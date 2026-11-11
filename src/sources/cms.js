// CMS Blue Button 2.0: Patient + Part D prescription drug events (ExplanationOfBenefit?type=pde).
import { fhirClient } from "../fhir.js";
import { ccText, firstCoding, isoDate, patientSummary, settle } from "./common.js";

const hasCode = (cc, code) => (cc?.coding || []).some((c) => String(c.code).toLowerCase() === code);

export function normalizePde(eob) {
  const item = eob.item?.[0] || {};
  const drug = firstCoding(item.productOrService, "ndc") || firstCoding(item.productOrService);
  const daysSupply = (eob.supportingInfo || []).find((s) => hasCode(s.category, "dayssupply"))?.valueQuantity?.value ?? null;
  const refill = (eob.supportingInfo || []).find((s) => hasCode(s.category, "refillnum"))?.valueQuantity?.value ?? null;
  return {
    source: "cms", kind: "fill", id: eob.id,
    date: isoDate(item.servicedDate || eob.billablePeriod?.start || eob.created),
    label: drug?.display || ccText(item.productOrService) || (drug?.code ? `NDC ${drug.code}` : "Prescription"),
    code: drug?.code || null, codeSystem: drug?.system || null,
    daysSupply: daysSupply != null ? Number(daysSupply) : null,
    quantity: item.quantity?.value ?? null,
    refill,
  };
}

export async function fetchCms({ base, token, patientId, fetchImpl }) {
  if (!patientId) throw new Error("CMS Blue Button did not return a patient id.");
  const fhir = fhirClient({ base, token, fetchImpl, maxPages: 20 });
  const { data, warnings } = await settle({
    patient: () => fhir.read("Patient", patientId),
    pde: () => fhir.search("ExplanationOfBenefit", { patient: patientId, type: "pde", _count: "50" }),
  });
  if (Array.isArray(data.patient)) data.patient = null;
  const facts = data.pde.map(normalizePde).filter((f) => f.date);
  return { patient: patientSummary(data.patient), facts, warnings };
}
