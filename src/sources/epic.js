// Epic FHIR R4: Patient, Condition, Observation (labs + vitals), AllergyIntolerance, Immunization.
import { fhirClient } from "../fhir.js";
import { ccText, firstCoding, isoDate, patientSummary, settle } from "./common.js";

export function normalizeObservation(o, kind) {
  const code = firstCoding(o.code, "loinc");
  const base = {
    source: "epic", kind, id: o.id,
    date: isoDate(o.effectiveDateTime || o.effectivePeriod?.start || o.issued),
    label: ccText(o.code) || "Observation",
    code: code?.code || null, codeSystem: code?.system || null,
    interpretation: ccText(o.interpretation?.[0]) || null,
    ref: o.referenceRange?.[0]?.text ||
      (o.referenceRange?.[0] ? [o.referenceRange[0].low?.value, o.referenceRange[0].high?.value].filter((v) => v != null).join("-") : null) || null,
  };
  if (o.valueQuantity) return { ...base, value: o.valueQuantity.value, unit: o.valueQuantity.unit || o.valueQuantity.code || "" };
  if (o.component?.length) {
    // e.g. blood pressure panel 85354-9 with systolic 8480-6 / diastolic 8462-4
    const parts = o.component.filter((c) => c.valueQuantity).map((c) => ({
      code: firstCoding(c.code)?.code || null, label: ccText(c.code), value: c.valueQuantity.value, unit: c.valueQuantity.unit || "",
    }));
    const sys = parts.find((p) => p.code === "8480-6"), dia = parts.find((p) => p.code === "8462-4");
    if (sys && dia) return { ...base, value: sys.value, value2: dia.value, unit: sys.unit || "mmHg", valueText: `${sys.value}/${dia.value}`, components: parts };
    return { ...base, components: parts, valueText: parts.map((p) => `${p.label} ${p.value} ${p.unit}`).join(", ") };
  }
  if (o.valueString) return { ...base, valueText: o.valueString };
  if (o.valueCodeableConcept) return { ...base, valueText: ccText(o.valueCodeableConcept) };
  return base;
}

export function normalizeEpic({ patient, conditions, labs, vitals, allergies, immunizations }) {
  const facts = [];
  for (const c of conditions) {
    const status = firstCoding(c.clinicalStatus)?.code;
    if (status && !["active", "recurrence", "relapse"].includes(status)) continue;
    const code = firstCoding(c.code, "icd-10") || firstCoding(c.code);
    facts.push({ source: "epic", kind: "condition", id: c.id, label: ccText(c.code), code: code?.code || null, codeSystem: code?.system || null,
      date: isoDate(c.onsetDateTime || c.recordedDate) });
  }
  for (const o of labs) facts.push(normalizeObservation(o, "lab"));
  for (const o of vitals) facts.push(normalizeObservation(o, "vital"));
  for (const a of allergies) {
    facts.push({ source: "epic", kind: "allergy", id: a.id, label: ccText(a.code), date: isoDate(a.recordedDate || a.onsetDateTime),
      valueText: (a.reaction || []).flatMap((r) => (r.manifestation || []).map(ccText)).filter(Boolean).join(", ") || null,
      criticality: a.criticality || null });
  }
  for (const i of immunizations) {
    if (i.status && i.status !== "completed") continue;
    const code = firstCoding(i.vaccineCode, "cvx");
    facts.push({ source: "epic", kind: "immunization", id: i.id, label: ccText(i.vaccineCode), code: code?.code || null,
      date: isoDate(i.occurrenceDateTime || i.occurrenceString) });
  }
  return { patient: patientSummary(patient), facts };
}

export async function fetchEpic({ base, token, patientId, fetchImpl }) {
  if (!patientId) throw new Error("Epic did not return a patient id. Check the app's launch/patient scope.");
  const fhir = fhirClient({ base, token, fetchImpl });
  const p = { patient: patientId };
  const { data, warnings } = await settle({
    patient: () => fhir.read("Patient", patientId),
    conditions: () => fhir.search("Condition", { ...p, category: "problem-list-item" }),
    labs: () => fhir.search("Observation", { ...p, category: "laboratory" }),
    vitals: () => fhir.search("Observation", { ...p, category: "vital-signs" }),
    allergies: () => fhir.search("AllergyIntolerance", p),
    immunizations: () => fhir.search("Immunization", p),
  });
  if (Array.isArray(data.patient)) data.patient = null;
  return { ...normalizeEpic(data), warnings };
}
