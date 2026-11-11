// Built-in fallback used when no AI model is configured: a text parser for lab reports and
// rule-based recommendations over the combined record. Output matches the AI schemas exactly.

const TESTS = [
  [/hemoglobin a1c|hba1c|\ba1c\b|glycated/i, "4548-4", "Hemoglobin A1c", "%"],
  [/\bldl\b/i, "13457-7", "LDL cholesterol", "mg/dL"],
  [/\bhdl\b/i, "2085-9", "HDL cholesterol", "mg/dL"],
  [/triglyceride/i, "2571-8", "Triglycerides", "mg/dL"],
  [/total cholesterol|cholesterol,? total/i, "2093-3", "Total cholesterol", "mg/dL"],
  [/glucose/i, "2345-7", "Glucose", "mg/dL"],
  [/egfr|glomerular/i, "62238-1", "eGFR", "mL/min/1.73m2"],
  [/albumin.{0,20}creat|uacr|microalbumin/i, "9318-7", "Urine albumin/creatinine", "mg/g"],
  [/creatinine/i, "2160-0", "Creatinine", "mg/dL"],
  [/potassium/i, "2823-3", "Potassium", "mmol/L"],
  [/sodium/i, "2951-2", "Sodium", "mmol/L"],
  [/\btsh\b/i, "3016-3", "TSH", "mIU/L"],
  [/hemoglobin(?! a1c)|\bhgb\b/i, "718-7", "Hemoglobin", "g/dL"],
];

const toIso = (s) => {
  if (!s) return null;
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return null;
};

export function parseDocumentText(text) {
  const results = [], seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    for (const [re, loinc, name, unit] of TESTS) {
      if (seen.has(loinc) || !re.test(line)) continue;
      if (loinc === "2160-0" && /egfr|albumin/i.test(line)) continue;
      if (loinc === "2345-7" && /a1c/i.test(line)) continue;
      const after = line.slice(line.search(re)).replace(re, "");
      const m = after.match(/(-?\d+(?:\.\d+)?)/);
      if (!m) continue;
      const rest = after.slice(after.indexOf(m[1]) + m[1].length);
      const flag = /^\s*\S*\s+(H|HIGH)\b|\bhigh\b/i.test(rest) ? "high" : /^\s*\S*\s+(L|LOW)\b|\blow\b/i.test(rest) ? "low" : null;
      const range = (rest.match(/([<>]\s*\d[\d.]*|\d[\d.]*\s*-\s*\d[\d.]*)/) || [])[1] || null;
      results.push({ name, loinc, value: Number(m[1]), valueText: null, unit, flag, referenceRange: range });
      seen.add(loinc);
      break;
    }
  }
  const bp = text.match(/blood pressure[^\d]{0,20}(\d{2,3})\s*\/\s*(\d{2,3})/i);
  if (bp) results.push({ name: "Blood pressure", loinc: "85354-9", value: Number(bp[1]), valueText: `${bp[1]}/${bp[2]}`, unit: "mmHg", flag: null, referenceRange: null });
  const name = (text.match(/patient(?: name)?:\s*([A-Za-z',.-]+(?: [A-Za-z',.-]+){0,3}?)(?:\s{2,}|\s+DOB|\s*$)/im) || [])[1] || null;
  const dob = toIso((text.match(/(?:DOB|date of birth|birth date)[:\s]*([\d/-]+)/i) || [])[1]);
  const date = toIso((text.match(/(?:collected|collection date|date of service|visit date|reported)[^\n]*?(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i) || [])[1]);
  return {
    documentType: /lab|result/i.test(text) ? "Lab report" : "Medical document",
    patientName: name?.trim() || null, birthDate: dob, documentDate: date,
    results, diagnoses: [], medications: [],
    summary: results.length
      ? `Found ${results.length} result${results.length > 1 ? "s" : ""}${results.some((r) => r.flag) ? `, ${results.filter((r) => r.flag).length} flagged out of range` : ""}. Read by the built-in parser.`
      : "No lab results were recognized by the built-in parser.",
  };
}

/* ---------------- rule-based recommendations ---------------- */
const DIABETES_MEDS = /metformin|glipizide|glimepiride|glyburide|sitagliptin|linagliptin|empagliflozin|dapagliflozin|canagliflozin|semaglutide|dulaglutide|liraglutide|tirzepatide|pioglitazone|insulin/i;
const STATINS = /atorvastatin|rosuvastatin|simvastatin|pravastatin|lovastatin|pitavastatin|ezetimibe/i;
const BP_MEDS = /lisinopril|losartan|valsartan|amlodipine|hydrochlorothiazide|chlorthalidone|metoprolol|carvedilol|olmesartan|irbesartan|enalapril|ramipril|benazepril/i;
const ALLERGY_CLASSES = [
  [/penicillin|amoxicillin|ampicillin/i, /amoxicillin|ampicillin|penicillin|piperacillin|dicloxacillin|nafcillin/i, "penicillin-type antibiotic"],
  [/sulfa|sulfonamide/i, /sulfamethoxazole|sulfasalazine|sulfadiazine/i, "sulfonamide"],
  [/cephalosporin|cephalexin|cefdinir/i, /cephalexin|cefdinir|cefuroxime|ceftriaxone|cefadroxil|cefpodoxime/i, "cephalosporin"],
  [/aspirin|nsaid|ibuprofen|naproxen/i, /aspirin|ibuprofen|naproxen|meloxicam|diclofenac|celecoxib/i, "NSAID"],
];
const SRC = { document: "document", epic: "epic", cms: "cms" };
const fmt = (s) => s || "undated";
const ev = (source, detail) => ({ source: SRC[source] || source, detail });
const hasCondition = (facts, re) => facts.some((f) => f.kind === "condition" && re.test(`${f.code || ""} ${f.label || ""}`));

export function localRecommendations(record, document) {
  const recs = [], gaps = [], questions = [];
  const { facts, series, medications, asOf } = record;
  const latest = (k) => series[k]?.[series[k].length - 1];
  const rising = (k) => (series[k]?.length || 0) >= 2 && latest(k).value > series[k][series[k].length - 2].value;
  const lapsed = (re) => medications.find((m) => re.test(m.label) && m.status === "lapsed");
  const diabetic = hasCondition(facts, /^E1[01]|diabet/i) || (latest("a1c")?.value ?? 0) >= 6.5;

  // 1. Glucose control + diabetes medication refills
  const a1c = latest("a1c"), dm = lapsed(DIABETES_MEDS);
  if (a1c && (a1c.value >= 7 || rising("a1c"))) {
    const trend = series.a1c.map((p) => `${p.value}%`).join(" → ");
    recs.push({
      title: dm ? "Blood sugar is rising while a diabetes medicine ran out" : "Blood sugar is above target",
      priority: a1c.value >= 8 || dm ? "high" : "medium",
      why: `A1c ${series.a1c.length > 1 ? `went ${trend}` : `is ${a1c.value}%`} (goal usually under 7%).` +
        (dm ? ` Pharmacy claims show ${dm.label} was last filled ${dm.lastFill} and ran out ${dm.daysWithoutSupply} days ago.` : ""),
      action: dm ? "Ask your doctor about restarting it before adding a new medicine, and mention anything that made refills hard." : "Review your diabetes plan with your doctor.",
      evidence: [...series.a1c.map((p) => ev(p.source, `A1c ${p.value}% on ${fmt(p.date)}`)), ...(dm ? [ev("cms", `${dm.label}: last fill ${dm.lastFill}, ${dm.daysSupply}-day supply`)] : [])],
    });
  }
  // 2. Cholesterol + statin refills
  const ldl = latest("ldl"), st = lapsed(STATINS);
  if (ldl && ldl.value >= (diabetic ? 100 : 130)) {
    recs.push({
      title: st ? "Cholesterol is above goal and the cholesterol medicine ran out" : "LDL cholesterol is above goal",
      priority: st ? "high" : "medium",
      why: `LDL is ${ldl.value} mg/dL (goal under ${diabetic ? 100 : 130}).` + (st ? ` ${st.label} ran out ${st.daysWithoutSupply} days ago.` : ""),
      action: st ? "Ask whether it was stopped on purpose. If not, restart it and recheck LDL in 6-12 weeks." : "Discuss cholesterol treatment with your doctor.",
      evidence: [...series.ldl.map((p) => ev(p.source, `LDL ${p.value} mg/dL on ${fmt(p.date)}`)), ...(st ? [ev("cms", `${st.label}: last fill ${st.lastFill}`)] : [])],
    });
  }
  // 3. Allergy vs dispensed drug
  for (const al of facts.filter((f) => f.kind === "allergy")) {
    for (const [allergyRe, drugRe, cls] of ALLERGY_CLASSES) {
      if (!allergyRe.test(al.label || "")) continue;
      const fill = facts.find((f) => f.kind === "fill" && drugRe.test(f.label));
      if (fill) recs.push({
        title: "A medicine you're allergic to was dispensed",
        priority: "high",
        why: `Your health record lists an allergy to ${al.label}${al.valueText ? ` (${al.valueText.toLowerCase()})` : ""}. Pharmacy claims show ${fill.label}, a ${cls}, filled on ${fill.date}.`,
        action: "Make sure your pharmacy and every prescriber have this allergy on file.",
        evidence: [ev(al.source, `Allergy: ${al.label}`), ev("cms", `${fill.label} filled ${fill.date}`)],
      });
    }
  }
  // 4. Blood pressure / kidney
  const bp = latest("bp"), uacr = latest("uacr");
  if ((bp && (bp.value >= 130 || (bp.value2 ?? 0) >= 80)) || (uacr && uacr.value >= 30)) {
    const bpMed = medications.find((m) => BP_MEDS.test(m.label));
    recs.push({
      title: uacr?.value >= 30 ? "Blood pressure and kidney markers need attention" : "Blood pressure is above target",
      priority: "medium",
      why: [bp ? `Blood pressure was ${bp.value}/${bp.value2 ?? "?"} on ${bp.date} (goal under 130/80).` : "",
        uacr?.value >= 30 ? `Urine albumin is ${uacr.value} mg/g (normal under 30).` : "",
        bpMed ? (bpMed.status === "lapsed" ? `${bpMed.label} ran out ${bpMed.daysWithoutSupply} days ago.` : `${bpMed.label} refills are on time, so the current plan may need adjusting.`) : ""].filter(Boolean).join(" "),
      action: "Ask your doctor whether your blood pressure treatment should change, and when to recheck kidney tests.",
      evidence: [...(bp ? [ev(bp.source, `BP ${bp.value}/${bp.value2 ?? "?"} on ${bp.date}`)] : []), ...(uacr ? [ev(uacr.source, `Urine albumin/creatinine ${uacr.value} mg/g on ${uacr.date}`)] : []),
        ...(bpMed ? [ev("cms", `${bpMed.label}: last fill ${bpMed.lastFill}`)] : [])],
    });
  }
  // 5. Other lapsed long-term medicines
  for (const m of medications.filter((x) => x.status === "lapsed" && !DIABETES_MEDS.test(x.label) && !STATINS.test(x.label) && !BP_MEDS.test(x.label)).slice(0, 3)) {
    recs.push({ title: `${m.label} ran out`, priority: "medium",
      why: `Last filled ${m.lastFill} for ${m.daysSupply ?? "?"} days; no refill for ${m.daysWithoutSupply} days.`,
      action: "Check with your doctor or pharmacist whether you should still be taking it.", evidence: [ev("cms", `${m.fills.length} fill(s), last ${m.lastFill}`)] });
  }
  // 6. Other flagged values in the uploaded document
  const covered = new Set(["4548-4", "13457-7", "85354-9", "9318-7"]);
  for (const r of (document?.results || []).filter((x) => x.flag && x.flag !== "normal" && !covered.has(x.loinc)).slice(0, 3)) {
    recs.push({ title: `${r.name} is ${r.flag}`, priority: "low",
      why: `Your uploaded document shows ${r.name} ${r.valueText || r.value} ${r.unit || ""}${r.referenceRange ? ` (reference ${r.referenceRange})` : ""}.`,
      action: "Bring this up at your next visit.", evidence: [ev("document", `${r.name} ${r.valueText || r.value} ${r.unit || ""}`)] });
  }
  // 7. Vaccines
  const imms = facts.filter((f) => f.kind === "immunization");
  if (record.counts.epic > 0) {
    const flu = imms.filter((f) => /influenza|flu/i.test(f.label)).sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const seasonStart = `${Number(asOf.slice(0, 4)) - (Number(asOf.slice(5, 7)) < 8 ? 1 : 0)}-08-01`;
    if (!flu || flu.date < seasonStart) recs.push({ title: "No flu shot recorded this season", priority: "low",
      why: `The last flu vaccine in your record is ${flu ? flu.date : "not recorded"}.`, action: "Get this season's flu shot at a pharmacy or clinic.",
      evidence: flu ? [ev("epic", `${flu.label} on ${flu.date}`)] : [ev("epic", "No influenza vaccine on file")] });
    const shingrix = imms.filter((f) => /shingrix|zoster|shingles/i.test(f.label));
    if (shingrix.length === 1) recs.push({ title: "Shingles vaccine series isn't finished", priority: "low",
      why: `Only one Shingrix dose is recorded (${shingrix[0].date}). The series needs two.`, action: "Ask your pharmacy for the second dose.",
      evidence: [ev("epic", `${shingrix[0].label} on ${shingrix[0].date}`)] });
  }
  // Identity and missing sources
  for (const [k, label] of [["epic", "health record"], ["cms", "pharmacy claims"]]) {
    const id = record.identity[k];
    if (id?.status === "mismatch") gaps.push(`The ${label} belongs to ${id.name || "a different person"}, not the person on your document. Treat combined findings with care.`);
  }
  if (!record.counts.epic) gaps.push("No health record connected, so conditions, allergies and vaccines weren't checked.");
  if (!record.counts.cms) gaps.push("No pharmacy claims connected, so refill gaps weren't checked.");

  const order = { high: 0, medium: 1, low: 2 };
  recs.sort((a, b) => order[a.priority] - order[b.priority]);
  if (recs.some((r) => /ran out/.test(r.title))) questions.push("Is there anything making it hard to keep up with my refills, like cost or side effects?");
  if (a1c) questions.push("What should my A1c goal be, and when should we recheck it?");
  questions.push("Which of these should we handle first?");
  const high = recs.filter((r) => r.priority === "high").length;
  return {
    headline: recs.length ? `We found ${recs.length} thing${recs.length > 1 ? "s" : ""} to review${high ? `, ${high} that need attention soon` : ""}.` : "Nothing in the combined record needs attention right now.",
    overview: `Built-in rules compared your uploaded document with ${record.counts.epic} health record items and ${record.counts.cms} pharmacy claims. Connect an AI model for a written review.`,
    recommendations: recs, questionsForDoctor: questions, dataGaps: gaps,
  };
}
