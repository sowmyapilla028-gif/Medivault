// Deterministic signals computed from the combined record before Claude sees it.
// Claude explains and prioritizes; these numbers are computed, not generated.

const DAY = 86400000;
const toD = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / DAY);
const addDays = (s, n) => new Date(toD(s).getTime() + n * DAY).toISOString().slice(0, 10);
export const todayIso = () => new Date().toISOString().slice(0, 10);

// LOINC codes grouped into the markers we chart and trend.
export const MARKERS = {
  a1c: { label: "Hemoglobin A1c", loinc: ["4548-4", "17856-6", "4549-2"], name: /a1c|glyc(at)?ed h(a)?emoglobin/i },
  ldl: { label: "LDL cholesterol", loinc: ["13457-7", "18262-6", "2089-1"], name: /\bldl\b/i },
  glucose: { label: "Glucose", loinc: ["2345-7", "1558-6", "2339-0"], name: /glucose/i },
  egfr: { label: "eGFR", loinc: ["33914-3", "62238-1", "48642-3", "48643-1", "98979-8"], name: /egfr|glomerular/i },
  uacr: { label: "Urine albumin/creatinine", loinc: ["9318-7", "14959-1", "32294-1"], name: /albumin.*creat|microalb/i },
  bp: { label: "Blood pressure", loinc: ["85354-9", "55284-4"], name: /blood pressure/i },
  bmi: { label: "BMI", loinc: ["39156-5"], name: /\bbmi\b|body mass/i },
};

export function markerOf(f) {
  for (const [key, m] of Object.entries(MARKERS)) {
    if (f.code && m.loinc.includes(f.code)) return key;
  }
  for (const [key, m] of Object.entries(MARKERS)) {
    if (m.name.test(f.label || "")) return key;
  }
  return null;
}

/** Turn document results into facts shaped like the EHR facts. */
export function documentFacts(doc) {
  if (!doc) return [];
  return (doc.results || []).map((r, i) => ({
    source: "document", kind: "lab", id: `doc-${i}`, date: doc.documentDate || null,
    label: r.name, code: r.loinc || null, value: typeof r.value === "number" ? r.value : null,
    valueText: r.valueText || null, unit: r.unit || "", interpretation: r.flag || null, ref: r.referenceRange || null,
  }));
}

const drugKey = (label) => (label || "").toLowerCase().replace(/[^a-z ]/g, " ").trim().split(/\s+/)[0] || label;

export function medicationSupply(fills, asOf = todayIso()) {
  const byDrug = new Map();
  for (const f of fills) {
    const k = drugKey(f.label);
    if (!byDrug.has(k)) byDrug.set(k, []);
    byDrug.get(k).push(f);
  }
  const windowStart = addDays(asOf, -180);
  const out = [];
  for (const [key, list] of byDrug) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1];
    const days = last.daysSupply || 30;
    const runOut = addDays(last.date, days);
    const covered = new Set();
    for (const f of list) for (let i = 0; i < (f.daysSupply || 30); i++) {
      const d = addDays(f.date, i);
      if (d >= windowStart && d <= asOf) covered.add(d);
    }
    const oneTime = list.length === 1 && days <= 14;
    out.push({
      drug: key, label: last.label, fills: list.map((f) => ({ date: f.date, daysSupply: f.daysSupply, quantity: f.quantity })),
      lastFill: last.date, daysSupply: last.daysSupply, runOutDate: runOut,
      daysWithoutSupply: Math.max(0, daysBetween(runOut, asOf)),
      proportionOfDaysCovered180: oneTime ? null : Math.round((covered.size / 181) * 100),
      oneTime,
      status: oneTime ? "one-time" : daysBetween(runOut, asOf) > 7 ? "lapsed" : "current",
    });
  }
  return out.sort((a, b) => b.lastFill.localeCompare(a.lastFill));
}

const normName = (s) => (s || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");

export function identityCheck(doc, epicPatient, cmsPatient) {
  const docName = doc?.patientName || null, docDob = doc?.birthDate || null;
  const compare = (p) => {
    if (!p) return null;
    if (!docName && !docDob) return { status: "unknown", note: "The document has no name or date of birth to compare." };
    const dobMatch = docDob && p.birthDate ? docDob === p.birthDate : null;
    const nameMatch = docName && p.name ? normName(docName) === normName(p.name) : null;
    const status = dobMatch === false || nameMatch === false ? "mismatch" : dobMatch || nameMatch ? "match" : "unknown";
    return { status, name: p.name, birthDate: p.birthDate, nameMatch, dobMatch };
  };
  return { document: { name: docName, birthDate: docDob }, epic: compare(epicPatient), cms: compare(cmsPatient) };
}

export function buildRecord({ document, epic, cms, asOf = todayIso() }) {
  const facts = [...documentFacts(document), ...(epic?.facts || []), ...(cms?.facts || [])]
    .filter((f) => f)
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const series = {};
  for (const f of facts) {
    if (f.kind !== "lab" && f.kind !== "vital") continue;
    const m = markerOf(f);
    if (!m || f.value == null || !f.date) continue;
    (series[m] ||= []).push({ date: f.date, value: f.value, value2: f.value2 ?? null, unit: f.unit, source: f.source });
  }
  for (const k of Object.keys(series)) series[k].sort((a, b) => a.date.localeCompare(b.date));
  const medications = medicationSupply(facts.filter((f) => f.kind === "fill"), asOf);
  return {
    asOf,
    facts,
    series,
    medications,
    identity: identityCheck(document, epic?.patient, cms?.patient),
    counts: {
      document: facts.filter((f) => f.source === "document").length,
      epic: facts.filter((f) => f.source === "epic").length,
      cms: facts.filter((f) => f.source === "cms").length,
    },
  };
}
