import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { triage } from "../src/agent/triage.js";
import { proposeSlots } from "../src/agent/scheduling.js";

const series = (pts) => pts.map(([date, value, source]) => ({ date, value, source, unit: "" }));
const rec = (s, meds = []) => ({ series: s, medications: meds, facts: [] });

test("triage: high new A1c rising from history triggers endocrinology", () => {
  const t = triage(rec({ a1c: series([["2026-02-10", 7.4, "epic"], ["2026-08-04", 8.1, "epic"], ["2026-11-03", 8.9, "document"]]) },
    [{ label: "METFORMIN 1000 MG", drug: "metformin", status: "lapsed", daysWithoutSupply: 53 }]), { results: [] });
  assert.equal(t.needed, true);
  assert.equal(t.primary.specialty, "Endocrinology");
  assert.deepEqual(t.primary.windowDays, [14, 28]);
  assert.ok(t.primary.questions.some((q) => /metformin ran out 53 days/.test(q)));
});

test("triage: high value only in history (not in the new upload) does not trigger", () => {
  const t = triage(rec({ a1c: series([["2026-08-04", 9.4, "epic"]]) }), { results: [] });
  assert.equal(t.needed, false);
});

test("triage: normal new results do not trigger; no upload never triggers", () => {
  assert.equal(triage(rec({ a1c: series([["2026-08-04", 7.9, "epic"], ["2026-11-03", 6.4, "document"]]) }), { results: [] }).needed, false);
  assert.equal(triage(rec({ a1c: series([["2026-11-03", 11, "epic"]]) }), null).needed, false);
});

test("triage: very high A1c alone is urgent; low eGFR adds nephrology", () => {
  const t = triage(rec({ a1c: series([["2026-11-03", 10.2, "document"]]), egfr: series([["2026-11-03", 25, "document"]]) }), { results: [] });
  assert.equal(t.primary.specialty, "Endocrinology");
  assert.deepEqual(t.primary.windowDays, [3, 14]);
  assert.equal(t.others[0].specialty, "Nephrology");
});

test("proposeSlots avoids busy times with a travel buffer and picks different days", () => {
  const d = (h, day = 2) => new Date(2026, 10, day, h);
  const slots = [{ id: "a", start: d(9), end: d(9.67) }, { id: "b", start: d(14), end: d(14.67) }, { id: "c", start: d(15, 3), end: d(15.67, 3) }, { id: "x", start: d(16, 3), end: d(16.67, 3) }];
  const events = [{ start: d(8.5), end: d(10) }];
  assert.deepEqual(proposeSlots(slots, events, d(0)).map((s) => s.id), ["b", "c"]);
});

/* ---------- end to end over HTTP ---------- */
const APP_PORT = 4323;
let server;
const jar = new Map();
const call = async (path, opts = {}) => {
  const res = await fetch(`http://127.0.0.1:${APP_PORT}${path}`, { redirect: "manual", ...opts,
    headers: { ...(opts.headers || {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
  for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar.set(kv.slice(0, i), kv.slice(i + 1)); }
  return res;
};
const events = async (path) => (await (await call(path)).text()).split("\n\n").filter((x) => x.startsWith("data: ")).map((x) => JSON.parse(x.slice(6)));

before(async () => {
  for (const k of ["ANTHROPIC_API_KEY", "LLM_API_KEY", "LLM_MODEL", "CMS_CLIENT_ID", "EPIC_CLIENT_ID", "EHR_FHIR_BASE"]) delete process.env[k];
  Object.assign(process.env, { APP_URL: `http://127.0.0.1:${APP_PORT}`, SESSION_SECRET: "t" });
  const { createApp } = await import("../src/server.js");
  await new Promise((r) => { server = createApp().listen(APP_PORT, r); });
});
after(() => server?.close());

test("agent: triggered follow-up runs to approval, then books, adds calendar event and emails", async () => {
  await call("/api/document/sample", { method: "POST" });
  await call("/api/demo/epic", { method: "POST" });
  await call("/api/demo/cms", { method: "POST" });

  const tri = await (await call("/api/agent/triage")).json();
  assert.equal(tri.primary.specialty, "Endocrinology");

  const plan = await events("/api/agent/run?fast=1");
  const st = plan.at(-1).state;
  assert.equal(st.status, "awaiting_approval");
  assert.ok(st.proposals.length >= 1 && st.proposals.length <= 3);
  for (const p of st.proposals) {
    const s = new Date(p.start), e = new Date(p.end);
    assert.ok(!st.calendar.events.some((ev) => s < new Date(ev.end) && e > new Date(ev.start)), "proposal overlaps a busy event");
    const days = (s - new Date(new Date().toDateString())) / 86400000;
    assert.ok(days >= 14 && days <= 29, `proposal ${p.start} outside 14-28 day window`);
  }
  assert.ok(!plan.some((e) => e.type === "emails"), "nothing is sent before approval");

  const booked = await events(`/api/agent/book?fast=1&slot=${encodeURIComponent(st.proposals[0].id)}`);
  const fin = booked.at(-1).state;
  assert.equal(fin.status, "booked");
  assert.equal(fin.call.transcript.length, 10);
  assert.equal(fin.appointment.resourceType, "Appointment");
  assert.equal(fin.appointment.start, st.proposals[0].start);
  assert.deepEqual(fin.emails.map((m) => m.id), ["to-patient", "to-specialist"]);
  assert.match(fin.emails[1].body, /A1c 8\.9%/);
  assert.match(fin.emails[1].body, /METFORMIN HCL 1000 MG TABLET: last filled .* ran out \d+ days ago/);

  const ics = await call("/api/agent/appointment.ics");
  assert.equal(ics.headers.get("content-type"), "text/calendar; charset=utf-8");
  assert.match(await ics.text(), /BEGIN:VEVENT[\s\S]*SUMMARY:Endocrinology: Dr\. Priya Raman\\, MD/);

  // booking again with a stale slot is refused
  const again = await events(`/api/agent/book?fast=1&slot=${encodeURIComponent(st.proposals[0].id)}`);
  assert.match(again.at(-1).error, /no longer available/);
});

test("agent: normal new results -> no follow-up, no calendar, no call, no emails", async () => {
  await call("/api/reset", { method: "POST" }); jar.clear();
  const fd = new FormData();
  fd.append("file", new Blob(["Patient: Rosa Delgado  DOB: 03/14/1958\nCollected: 11/03/2026\nHemoglobin A1c 6.4 %\nLDL cholesterol 92 mg/dL"], { type: "text/plain" }), "normal.txt");
  await call("/api/document", { method: "POST", body: fd });
  await call("/api/demo/epic", { method: "POST" });
  await call("/api/demo/cms", { method: "POST" });
  const evs = await events("/api/agent/run?fast=1");
  const st = evs.at(-1).state;
  assert.equal(st.status, "not_needed");
  assert.equal(st.calendar, undefined);
  assert.ok(!evs.some((e) => ["calendar", "transcript", "emails"].includes(e.type)));
  assert.equal((await call("/api/agent/appointment.ics")).status, 404);
});

test("tier 1: non-medical uploads are rejected with a clear message", async () => {
  await call("/api/reset", { method: "POST" }); jar.clear();
  const fd = new FormData();
  fd.append("file", new Blob(["Shopping list: eggs, milk, bread"], { type: "text/plain" }), "notes.txt");
  const res = await call("/api/document", { method: "POST", body: fd });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /didn't find any lab results/);
  assert.equal((await (await call("/api/status")).json()).document, null);
});

test("tier 1: normal-results sample -> agent decides no follow-up; texts use readable dates", async () => {
  await call("/api/reset", { method: "POST" }); jar.clear();
  const doc = await (await call("/api/document/sample?kind=normal", { method: "POST" })).json();
  assert.equal(doc.results.find((r) => r.name === "Hemoglobin A1c").value, 6.8);
  await call("/api/demo/epic", { method: "POST" }); await call("/api/demo/cms", { method: "POST" });
  assert.equal((await (await call("/api/agent/triage")).json()).needed, false);
  const recs = await (await call("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  const text = JSON.stringify(recs.recommendations);
  assert.doesNotMatch(text, /\b\d{4}-\d{2}-\d{2}\b/, "no raw ISO dates in recommendation text");
  assert.match(text, /[A-Z][a-z]{2} \d{1,2}, \d{4}/);
});

test("tier 1: a booking keeps going if the browser disconnects, and the state can be read back", async () => {
  await call("/api/reset", { method: "POST" }); jar.clear();
  await call("/api/document/sample", { method: "POST" });
  await call("/api/demo/epic", { method: "POST" }); await call("/api/demo/cms", { method: "POST" });
  const st = (await events("/api/agent/run?fast=1")).at(-1).state;
  // Start booking at normal pace and hang up after the first chunk.
  const ctl = new AbortController();
  const res = await call(`/api/agent/book?slot=${encodeURIComponent(st.proposals[0].id)}`, { signal: ctl.signal });
  await res.body.getReader().read(); ctl.abort();
  await new Promise((r) => setTimeout(r, 300));
  const mid = await (await call("/api/agent")).json();
  assert.equal(mid.status, "booking");
  for (let i = 0; i < 40; i++) {
    const a = await (await call("/api/agent")).json();
    if (a.status === "booked") { assert.equal(a.emails.length, 2); return; }
    await new Promise((r) => setTimeout(r, 300));
  }
  assert.fail("booking never finished after disconnect");
});
