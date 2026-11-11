import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMocks } from "./mocks.js";

const APP_PORT = 4319;
let mocks, server, app;
const jar = new Map();
const call = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, {
    redirect: "manual", ...opts,
    headers: { ...(opts.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") },
  });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
};
// Follow the OAuth dance: app -> provider authorize -> app callback.
async function signIn(source) {
  const start = await call(`/auth/${source}/start`);
  assert.equal(start.status, 302);
  const authUrl = new URL(start.headers.get("location"));
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  const provider = await fetch(authUrl, { redirect: "manual" });
  const cb = new URL(provider.headers.get("location"));
  const done = await call(cb.pathname + cb.search);
  return { authUrl, done };
}

before(async () => {
  mocks = await startMocks();
  Object.assign(process.env, {
    APP_URL: `http://127.0.0.1:${APP_PORT}`, SESSION_SECRET: "test-secret",
    EPIC_CLIENT_ID: "epic-client", EPIC_FHIR_BASE: `${mocks.base}/epic/fhir`,
    CMS_CLIENT_ID: "cms-client", CMS_CLIENT_SECRET: "cms-secret", CMS_FHIR_BASE: `${mocks.base}/cms/fhir`,
    CMS_AUTHORIZE_URL: `${mocks.base}/cms/o/authorize`, CMS_TOKEN_URL: `${mocks.base}/cms/o/token`,
    ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: mocks.base,
  });
  ({ createApp: app } = await import("../src/server.js"));
  await new Promise((r) => { server = app().listen(APP_PORT, r); });
});
after(() => { server?.close(); mocks?.server.close(); });

test("full journey: upload, connect Epic and CMS, recommendations", async () => {
  let status = await (await call("/api/status")).json();
  assert.equal(status.sources.epic.configured, true);
  assert.equal(status.sources.epic.connected, false);

  // 1. Upload a PDF -> sent to Claude as a document block
  const fd = new FormData();
  fd.append("file", new Blob(["Patient: Camila Lopez   DOB: 09/12/1987\nCollected: 11/03/2026\nHemoglobin A1c 8.9 % H"], { type: "text/plain" }), "labs.txt");
  const up = await call("/api/document", { method: "POST", body: fd });
  assert.equal(up.status, 200);
  const doc = await up.json();
  assert.equal(doc.results[0].value, 8.9);
  const docReq = mocks.seen.claudeRequests.at(-1);
  assert.equal(docReq.body.messages[0].content[0].type, "text", "documents are de-identified text, never the raw file");
  assert.ok(!JSON.stringify(docReq.body).includes("Camila"), "no patient name sent to Claude");
  assert.equal(docReq.body.model, "claude-opus-5-5");
  assert.equal(docReq.body.fallbacks, "default");
  assert.equal(docReq.body.output_config.format.type, "json_schema");
  assert.match(docReq.headers["anthropic-beta"], /server-side-fallback-2026-07-01/);

  // 2. Epic: SMART discovery, aud param, public client with PKCE
  const epic = await signIn("epic");
  assert.equal(epic.authUrl.searchParams.get("aud"), `${mocks.base}/epic/fhir`);
  assert.equal(epic.done.headers.get("location"), "/app#review");
  const epicTok = mocks.seen.tokenRequests.find((t) => t.prefix === "epic");
  assert.equal(epicTok.body.client_id, "epic-client");
  assert.equal(epicTok.auth, null);

  const epicData = await (await call("/api/sources/epic")).json();
  assert.equal(epicData.patient.name, "Camila Lopez");
  const kinds = epicData.facts.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["allergy", "condition", "lab", "lab", "vital"]); // resolved condition dropped, paging followed
  assert.equal(epicData.facts.find((f) => f.kind === "vital").valueText, "142/88");
  assert.equal(epicData.warnings.length, 1); // Immunization 403 reported, not fatal

  // 3. CMS: confidential client (Basic auth), PDE claims
  const cms = await signIn("cms");
  assert.equal(cms.authUrl.searchParams.get("aud"), null);
  assert.equal(cms.done.headers.get("location"), "/app#review");
  assert.ok(mocks.seen.tokenRequests.find((t) => t.prefix === "cms").auth.startsWith("Basic "));

  // 4. Combined record
  const record = await (await call("/api/record")).json();
  assert.deepEqual(record.series.a1c.map((p) => [p.value, p.source]), [[7.4, "epic"], [8.1, "epic"], [8.9, "document"]]);
  const met = record.medications.find((m) => m.drug === "metformin");
  assert.equal(met.fills.length, 2);
  assert.equal(met.status, "lapsed");
  assert.equal(record.identity.epic.status, "match");
  assert.equal(record.identity.cms.status, "mismatch");

  // 5. Recommendations: Claude receives computed signals, result is cached in session
  const recs = await (await call("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  assert.equal(recs.recommendations[0].priority, "high");
  const recReq = mocks.seen.claudeRequests.at(-1);
  const prompt = recReq.body.messages[0].content[0].text;
  assert.match(prompt, /METFORMIN HCL 1000 MG TABLET: 2 fill\(s\), last \d{4}-\d{2}-\d{2}/);
  assert.match(prompt, /a1c: \d{4}-\d{2}-\d{2} 7.4 \(epic\) -> \d{4}-\d{2}-\d{2} 8.1 \(epic\) -> \d{4}-\d{2}-\d{2} 8.9 \(document\)/);
  assert.doesNotMatch(prompt, /2026-02-10|2026-08-04|Camila|Jane Doe|1950-01-01/, "real dates and names are not sent");
  assert.match(prompt, /"pharmacy":"mismatch"/);
  assert.equal(recReq.body.output_config.effort, "high");
  const before = mocks.seen.claudeRequests.length;
  await call("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(mocks.seen.claudeRequests.length, before, "second call served from session");

  status = await (await call("/api/status")).json();
  assert.equal(status.sources.cms.connected, true);
});

test("rejects a callback with the wrong state", async () => {
  const res = await call("/auth/epic/callback?code=x&state=forged");
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get("location")), /sign-in expired or didn't match/);
});

test("provider errors come back as a readable message", async () => {
  const res = await call("/auth/cms/callback?error=access_denied&error_description=User%20declined");
  assert.match(decodeURIComponent(res.headers.get("location")), /CMS Blue Button: User declined/);
});
