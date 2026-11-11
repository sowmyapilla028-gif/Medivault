// Same journey with an OpenAI-compatible LLM (e.g. OpenCode Zen) and a generic SMART EHR.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMocks } from "./mocks.js";

const APP_PORT = 4321;
let mocks, server;
const jar = new Map();
const call = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, { redirect: "manual", ...opts,
    headers: { ...(opts.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
};

// A real, minimal text PDF so the local PDF reader is exercised.
function makePdf(lines) {
  const text = lines.map((l, i) => `BT /F1 12 Tf 50 ${750 - i * 18} Td (${l}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

before(async () => {
  mocks = await startMocks();
  Object.assign(process.env, {
    APP_URL: `http://127.0.0.1:${APP_PORT}`, SESSION_SECRET: "t",
    LLM_PROVIDER: "openai", LLM_BASE_URL: `${mocks.base}/zen/v1`, LLM_API_KEY: "zen-key", LLM_MODEL: "test-model",
    EHR_FHIR_BASE: `${mocks.base}/epic/fhir`, EHR_CLIENT_ID: "any-client", EHR_LABEL: "SMART Health IT",
    CMS_CLIENT_ID: "cms-client", CMS_CLIENT_SECRET: "cms-secret", CMS_FHIR_BASE: `${mocks.base}/cms/fhir`,
    CMS_AUTHORIZE_URL: `${mocks.base}/cms/o/authorize`, CMS_TOKEN_URL: `${mocks.base}/cms/o/token`,
  });
  delete process.env.ANTHROPIC_API_KEY;
  const { createApp } = await import("../src/server.js");
  await new Promise((r) => { server = createApp().listen(APP_PORT, r); });
});
after(() => { server?.close(); mocks?.server.close(); });

test("OpenAI-compatible LLM + generic SMART EHR", async () => {
  const status = await (await call("/api/status")).json();
  assert.equal(status.llmConfigured, true);
  assert.equal(status.llmLabel, "test-model");
  assert.equal(status.sources.epic.label, "SMART Health IT");

  const fd = new FormData();
  fd.append("file", new Blob([makePdf(["NORTHSIDE LAB", "Patient: Camila Lopez", "Hemoglobin A1c 8.9 % H"])], { type: "application/pdf" }), "labs.pdf");
  const up = await call("/api/document", { method: "POST", body: fd });
  assert.equal(up.status, 200, await up.clone().text());
  assert.equal((await up.json()).results[0].value, 8.9);
  const docReq = mocks.seen.chatRequests[0];
  assert.equal(docReq.body.model, "test-model");
  assert.deepEqual(docReq.body.response_format, { type: "json_object" });
  assert.match(docReq.body.messages[1].content, /Hemoglobin A1c 8\.9 % H/, "PDF text was extracted locally and sent");

  // EHR sign-in: no category filter on Condition for non-Epic servers
  const start = await call("/auth/epic/start");
  const provider = await fetch(start.headers.get("location"), { redirect: "manual" });
  const cb = new URL(provider.headers.get("location"));
  assert.equal((await call(cb.pathname + cb.search)).headers.get("location"), "/app#review");
  const ehr = await (await call("/api/sources/epic")).json();
  assert.equal(ehr.patient.name, "Camila Lopez");
  assert.equal(mocks.seen.conditionQueries.at(-1).category, undefined);

  // Recommendations: first reply fails validation, server asks again and succeeds
  const recs = await (await call("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  assert.equal(recs.headline, "A1c rising.");
  const last = mocks.seen.chatRequests.at(-1).body.messages;
  assert.match(last.at(-1).content, /Reply again with only the corrected JSON/);
});

test("a scanned (text-less) PDF gets a clear message", async () => {
  const fd = new FormData();
  fd.append("file", new Blob([makePdf([])], { type: "application/pdf" }), "scan.pdf");
  const res = await call("/api/document", { method: "POST", body: fd });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /no readable text/);
});
