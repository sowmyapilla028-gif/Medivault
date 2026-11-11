// Demo mode: no AI model and no sign-ins. Built-in parser, demo records and rule-based recommendations.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const APP_PORT = 4322;
let server;
const jar = new Map();
const call = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, { redirect: "manual", ...opts,
    headers: { ...(opts.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
};

before(async () => {
  for (const k of ["ANTHROPIC_API_KEY", "LLM_API_KEY", "LLM_MODEL", "CMS_CLIENT_ID", "CMS_CLIENT_SECRET", "EPIC_CLIENT_ID", "EHR_FHIR_BASE"]) delete process.env[k];
  Object.assign(process.env, { APP_URL: `http://127.0.0.1:${APP_PORT}`, SESSION_SECRET: "t" });
  const { createApp } = await import("../src/server.js");
  await new Promise((r) => { server = createApp().listen(APP_PORT, r); });
});
after(() => server?.close());

test("whole demo runs with no AI model and no credentials", async () => {
  const status = await (await call("/api/status")).json();
  assert.equal(status.llmConfigured, false);
  assert.equal(status.llmLabel, "Built-in rules");
  assert.equal(status.sources.cms.configured, false);

  const doc = await (await call("/api/document/sample", { method: "POST" })).json();
  assert.deepEqual(doc.results.map((r) => [r.name, r.value]), [["Hemoglobin A1c", 8.9], ["Glucose", 186], ["LDL cholesterol", 128], ["eGFR", 64]]);
  assert.equal(doc.patientName, "Rosa Delgado");

  assert.equal((await call("/api/demo/epic", { method: "POST" })).status, 200);
  assert.equal((await call("/api/demo/cms", { method: "POST" })).status, 200);
  const st2 = await (await call("/api/status")).json();
  assert.equal(st2.sources.cms.connected, true);
  assert.equal(st2.sources.cms.demo, true);
  const ehr = await (await call("/api/sources/epic")).json();
  assert.equal(ehr.patient.name, "Rosa Delgado");

  const record = await (await call("/api/record")).json();
  assert.equal(record.identity.epic.status, "match");
  assert.deepEqual(record.series.a1c.map((p) => p.value), [7.4, 8.1, 8.9]);
  assert.equal(record.medications.find((m) => m.drug === "metformin").status, "lapsed");

  const recs = await (await call("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  const titles = recs.recommendations.map((r) => `${r.priority}: ${r.title}`);
  assert.ok(titles.includes("high: Blood sugar is rising while a diabetes medicine ran out"), titles.join("\n"));
  assert.ok(titles.includes("high: A medicine you're allergic to was dispensed"));
  assert.ok(titles.includes("high: Cholesterol is above goal and the cholesterol medicine ran out"));
  assert.ok(titles.includes("medium: Blood pressure and kidney markers need attention"));
  assert.ok(titles.includes("low: Shingles vaccine series isn't finished"));
  assert.equal(recs.recommendations[0].priority, "high");
  for (const r of recs.recommendations) assert.ok(r.evidence.length > 0, r.title);
});

test("a real PDF is read by the built-in parser when no AI model is set", async () => {
  const text = ["BT /F1 12 Tf 50 750 Td (Patient: Jane Roe   DOB: 01/02/1960) Tj ET", "BT /F1 12 Tf 50 730 Td (Collected: 10/01/2026) Tj ET",
    "BT /F1 12 Tf 50 710 Td (LDL Cholesterol 162 mg/dL H) Tj ET"].join("\n");
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF`;
  const fd = new FormData();
  fd.append("file", new Blob([pdf], { type: "application/pdf" }), "labs.pdf");
  const res = await call("/api/document", { method: "POST", body: fd });
  const doc = await res.json();
  assert.equal(res.status, 200, JSON.stringify(doc));
  assert.equal(doc.results[0].name, "LDL cholesterol");
  assert.equal(doc.results[0].value, 162);
  assert.equal(doc.results[0].flag, "high");
});
