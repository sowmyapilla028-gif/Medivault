// Synthetic demo records (one fictional patient), used only when the user clicks "Use demo data".
// Dates are written relative to 2026-11-11 and shifted so the story always ends "today".
import { normalizeEpic } from "./sources/epic.js";
import { normalizePde } from "./sources/cms.js";
import { patientSummary } from "./sources/common.js";

const ANCHOR = "2026-11-11";
const DAY = 86400000;
const shiftDays = () => Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(ANCHOR)) / DAY);
const sh = (d) => new Date(Date.parse(d) + shiftDays() * DAY).toISOString().slice(0, 10);

const PATIENT = { resourceType: "Patient", id: "demo-rosa", name: [{ given: ["Rosa"], family: "Delgado" }], gender: "female", birthDate: "1958-03-14" };
const obs = (id, cat, loinc, text, value, unit, date, ref) => ({ resourceType: "Observation", id, status: "final",
  category: [{ coding: [{ code: cat }] }], code: { coding: [{ system: "http://loinc.org", code: loinc }], text },
  effectiveDateTime: sh(date), valueQuantity: { value, unit }, ...(ref ? { referenceRange: [{ text: ref }] } : {}) });

export function demoEhr() {
  const cond = (id, code, text, onset) => ({ resourceType: "Condition", id, clinicalStatus: { coding: [{ code: "active" }] },
    code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code }], text }, onsetDateTime: onset });
  const data = {
    patient: PATIENT,
    conditions: [cond("c1", "E11.9", "Type 2 diabetes", "2019-06-12"), cond("c2", "I10", "High blood pressure", "2016-02-03"), cond("c3", "E78.5", "High cholesterol", "2018-09-20")],
    labs: [
      obs("o1", "laboratory", "4548-4", "Hemoglobin A1c", 7.4, "%", "2026-02-10", "< 7.0"),
      obs("o2", "laboratory", "4548-4", "Hemoglobin A1c", 8.1, "%", "2026-08-04", "< 7.0"),
      obs("o3", "laboratory", "13457-7", "LDL cholesterol", 112, "mg/dL", "2026-08-04", "< 100"),
      obs("o4", "laboratory", "62238-1", "eGFR", 68, "mL/min/1.73m2", "2026-08-04", "> 60"),
      obs("o5", "laboratory", "9318-7", "Urine albumin/creatinine", 42, "mg/g", "2026-08-04", "< 30"),
    ],
    vitals: [
      { resourceType: "Observation", id: "v1", status: "final", category: [{ coding: [{ code: "vital-signs" }] }], code: { coding: [{ system: "http://loinc.org", code: "85354-9" }], text: "Blood pressure" }, effectiveDateTime: sh("2026-08-04"),
        component: [{ code: { coding: [{ code: "8480-6" }], text: "Systolic" }, valueQuantity: { value: 142, unit: "mmHg" } }, { code: { coding: [{ code: "8462-4" }], text: "Diastolic" }, valueQuantity: { value: 88, unit: "mmHg" } }] },
      obs("v2", "vital-signs", "29463-7", "Weight", 84, "kg", "2026-08-04"),
      obs("v3", "vital-signs", "39156-5", "BMI", 31.2, "kg/m2", "2026-08-04"),
    ],
    allergies: [{ resourceType: "AllergyIntolerance", id: "a1", code: { text: "Penicillin" }, reaction: [{ manifestation: [{ text: "Hives" }] }], recordedDate: "2009-05-01" }],
    immunizations: [
      { resourceType: "Immunization", id: "i1", status: "completed", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "135" }], text: "Influenza, high dose" }, occurrenceDateTime: sh("2025-10-02") },
      { resourceType: "Immunization", id: "i2", status: "completed", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "216" }], text: "Pneumococcal PCV20" }, occurrenceDateTime: sh("2024-04-11") },
      { resourceType: "Immunization", id: "i3", status: "completed", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "187" }], text: "Shingles (Shingrix) dose 1" }, occurrenceDateTime: sh("2023-11-20") },
    ],
  };
  return { ...normalizeEpic(data), facts: normalizeEpic(data).facts.map((f) => ({ ...f, demo: true })), warnings: [], demo: true };
}

export function demoCms() {
  const pde = (id, display, ndc, date, days) => ({ resourceType: "ExplanationOfBenefit", id,
    item: [{ productOrService: { coding: [{ system: "http://hl7.org/fhir/sid/ndc", code: ndc, display }] }, servicedDate: sh(date), quantity: { value: days } }],
    supportingInfo: [{ category: { coding: [{ code: "dayssupply" }] }, valueQuantity: { value: days } }] });
  const eobs = [
    ...["2026-01-03", "2026-02-02", "2026-03-04", "2026-04-03", "2026-05-02", "2026-06-01", "2026-08-20"].map((d, i) => pde(`met${i}`, "METFORMIN HCL 1000 MG TABLET", "00093101801", d, 30)),
    ...["2025-12-16", "2026-03-16", "2026-06-15", "2026-09-14"].map((d, i) => pde(`lis${i}`, "LISINOPRIL 20 MG TABLET", "68180051301", d, 90)),
    ...["2026-01-08", "2026-04-10"].map((d, i) => pde(`ato${i}`, "ATORVASTATIN CALCIUM 40 MG TABLET", "00071015523", d, 90)),
    pde("amx0", "AMOXICILLIN 500 MG CAPSULE", "00093310905", "2026-03-19", 7),
  ];
  return { patient: patientSummary({ ...PATIENT, id: "-10000000000066" }), facts: eobs.map(normalizePde).map((f) => ({ ...f, demo: true })), warnings: [], demo: true };
}

export function sampleReportText(kind = "followup") {
  const d = sh("2026-11-03").split("-"), r = sh("2026-11-04").split("-");
  if (kind === "normal") return `NORTHSIDE COMMUNITY LAB - PATIENT COPY (DEMO)
Patient: Rosa Delgado    DOB: 03/14/1958    MRN: NCL-0048211
Phone: (555) 014-7781    Address: 418 Maple Avenue
Collected: ${d[1]}/${d[2]}/${d[0]}    Reported: ${r[1]}/${r[2]}/${r[0]}

TEST                         RESULT     FLAG   REFERENCE
Hemoglobin A1c               6.8 %             < 7.0 % (diabetes goal)
Glucose, fasting             112 mg/dL  H      70-99 mg/dL
LDL cholesterol (calc)       94 mg/dL          < 100 mg/dL
eGFR                         70                > 59 mL/min/1.73m2

Comment: A1c improved from prior result.`;
  return `NORTHSIDE COMMUNITY LAB - PATIENT COPY (DEMO)
Patient: Rosa Delgado    DOB: 03/14/1958    MRN: NCL-0048211
Phone: (555) 014-7781    Address: 418 Maple Avenue
Collected: ${d[1]}/${d[2]}/${d[0]}    Reported: ${r[1]}/${r[2]}/${r[0]}

TEST                         RESULT     FLAG   REFERENCE
Hemoglobin A1c               8.9 %      H      < 5.7 %
Glucose, fasting             186 mg/dL  H      70-99 mg/dL
LDL cholesterol (calc)       128 mg/dL  H      < 100 mg/dL
eGFR                         64                > 59 mL/min/1.73m2

Comment: A1c increased from prior result.`;
}
