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
