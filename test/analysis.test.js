import { test } from "node:test";
import assert from "node:assert/strict";
import { medicationSupply, identityCheck, markerOf } from "../src/analysis.js";
import { normalizePde } from "../src/sources/cms.js";

test("medicationSupply finds lapsed refills and coverage", () => {
  const fills = ["2026-01-01", "2026-01-31", "2026-03-02"].map((date) => ({ label: "Metformin 500 mg", date, daysSupply: 30 }));
  const [m] = medicationSupply(fills, "2026-06-01");
  assert.equal(m.runOutDate, "2026-04-01");
  assert.equal(m.daysWithoutSupply, 61);
  assert.equal(m.status, "lapsed");
  assert.ok(m.proportionOfDaysCovered180 > 40 && m.proportionOfDaysCovered180 < 60);
});

test("one-time short fills are not flagged as lapsed", () => {
  const [m] = medicationSupply([{ label: "Amoxicillin 500 mg", date: "2026-03-19", daysSupply: 7 }], "2026-06-01");
  assert.equal(m.status, "one-time");
});

test("identityCheck ignores name order and case", () => {
  const r = identityCheck({ patientName: "LOPEZ, Camila", birthDate: "1987-09-12" }, { name: "Camila Lopez", birthDate: "1987-09-12" }, null);
  assert.equal(r.epic.status, "match");
  assert.equal(r.cms, null);
});

test("markerOf uses LOINC first, then name", () => {
  assert.equal(markerOf({ code: "4548-4", label: "x" }), "a1c");
  assert.equal(markerOf({ code: null, label: "HbA1c" }), "a1c");
  assert.equal(markerOf({ code: null, label: "Sodium" }), null);
});

test("normalizePde reads Blue Button drug, days supply and date", () => {
  const f = normalizePde({ id: "x", item: [{ productOrService: { coding: [{ system: "http://hl7.org/fhir/sid/ndc", code: "1", display: "LISINOPRIL 20 MG" }] }, servicedDate: "2026-09-14", quantity: { value: 90 } }],
    supportingInfo: [{ category: { coding: [{ code: "dayssupply" }] }, valueQuantity: { value: 90 } }] });
  assert.deepEqual([f.label, f.daysSupply, f.date, f.quantity], ["LISINOPRIL 20 MG", 90, "2026-09-14", 90]);
});

import { PrivacyShield } from "../src/privacy.js";
test("privacy shield: identifiers tokenized, dates shifted with intervals kept, answer mapped back", () => {
  const s = new PrivacyShield({ salt: "x", shiftDays: -100 }, { names: ["Rosa Delgado"], birthDates: ["1958-03-14"] });
  const out = s.redact("Patient: Rosa Delgado  DOB: 03/14/1958  MRN: A12345\nCall (555) 014-2290, rosa@example.com, 2140 Alder Street\nA1c 8.9 % on 2026-11-03; prior 2026-08-04. Delgado, Rosa reported missed doses.");
  for (const pii of ["Rosa", "Delgado", "03/14/1958", "A12345", "014-2290", "rosa@example.com", "Alder", "2026-11-03", "2026-08-04"]) assert.ok(!out.includes(pii), pii);
  assert.match(out, /A1c 8\.9 % on 2026-07-26; prior 2026-04-26/); // 91-day interval preserved
  const tok = out.match(/\[PATIENT_[0-9a-f]{6}\]/)[0];
  assert.equal(s.redact("Rosa Delgado").includes(tok), true, "same value -> same token");
  assert.deepEqual(s.reidentify({ n: tok, d: "on 2026-07-26 and Apr 26, 2026" }), { n: "Rosa Delgado", d: "on 2026-11-03 and 2026-08-04" });
  const r = s.report("t", out, true);
  assert.ok(r.replaced.PATIENT >= 2 && r.replaced.DOB === 1 && r.replaced.ID === 1 && r.replaced.PHONE === 1 && r.replaced.EMAIL === 1 && r.replaced.ADDRESS === 1);
});
