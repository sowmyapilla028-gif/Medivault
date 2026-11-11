import { humanizeText as H } from "../dates.js";
// Decides whether the newly uploaded results, read together with the patient's history,
// call for a specialist follow-up. The trigger must come from the uploaded document;
// history is used for trends and supporting context. Thresholds are demo heuristics,
// written to be easy to read and audit, not clinical guidance.

const DIABETES_MEDS = /metformin|glipizide|glimepiride|glyburide|sitagliptin|linagliptin|empagliflozin|dapagliflozin|canagliflozin|semaglutide|dulaglutide|liraglutide|tirzepatide|pioglitazone|insulin/i;

const fromDoc = (series, key) => (series[key] || []).filter((p) => p.source === "document").at(-1) || null;
const priorHistory = (series, key, before) => (series[key] || []).filter((p) => p.source !== "document" && (!before || (p.date || "") <= before)).at(-1) || null;
const label = { document: "Your upload", epic: "Health record", cms: "Pharmacy claims" };
const ev = (source, detail) => ({ source, detail });

function endocrinology(record) {
  const a1c = fromDoc(record.series, "a1c");
  if (!a1c) return null;
  const prev = priorHistory(record.series, "a1c", a1c.date);
  const rise = prev ? +(a1c.value - prev.value).toFixed(1) : null;
  const lapsedMed = record.medications.find((m) => DIABETES_MEDS.test(m.label) && m.status === "lapsed");
  const uacr = (record.series.uacr || []).at(-1);
  const egfr = (record.series.egfr || []).at(-1);

  let windowDays, criterion;
  if (a1c.value >= 10) { windowDays = [3, 14]; criterion = "New A1c is 10% or higher"; }
  else if (a1c.value >= 9) { windowDays = [7, 21]; criterion = "New A1c is 9% or higher"; }
  else if (a1c.value >= 8 && rise != null && rise >= 0.3) { windowDays = [14, 28]; criterion = "New A1c is 8% or higher and rising compared with your history"; }
  else if (a1c.value >= 7.5 && rise != null && rise >= 0.3 && lapsedMed) { windowDays = [14, 28]; criterion = "New A1c is above 7.5% and rising while a diabetes medicine has lapsed"; }
  else return null;

  const evidence = [ev("document", `A1c ${a1c.value}% on ${a1c.date || "upload"}`)];
  if (prev) evidence.push(ev(prev.source, `Previous A1c ${prev.value}% on ${prev.date}`));
  if (lapsedMed) evidence.push(ev("cms", `${lapsedMed.label}: ran out ${lapsedMed.daysWithoutSupply} days ago`));
  if (uacr && uacr.value >= 30) evidence.push(ev(uacr.source, `Urine albumin/creatinine ${uacr.value} mg/g on ${uacr.date}`));
  if (egfr) evidence.push(ev(egfr.source, `eGFR ${egfr.value} on ${egfr.date}`));

  const questions = [];
  if (lapsedMed) questions.push(`My ${lapsedMed.drug} ran out ${lapsedMed.daysWithoutSupply} days ago. Should I restart it, or change treatment?`);
  if (uacr && uacr.value >= 30) questions.push(`My urine albumin is ${uacr.value} mg/g. Would a kidney-protective diabetes medicine (such as an SGLT2 inhibitor) make sense for me?`);
  questions.push(`My A1c went ${prev ? `from ${prev.value}% to ` : "to "}${a1c.value}%. What target should I aim for, and when should we recheck?`);
  if (egfr) questions.push(`With an eGFR of ${egfr.value}, are my current diabetes medicines still the right dose?`);

  return {
    specialty: "Endocrinology",
    specialistTitle: "Endocrinologist (diabetes specialist)",
    windowDays,
    urgency: windowDays[1] <= 14 ? "high" : "medium",
    criterion,
    reason: `Your newly uploaded A1c is ${a1c.value}%${prev ? `, up from ${prev.value}% in your health record` : ""}${lapsedMed ? `, and pharmacy claims show ${lapsedMed.drug} ran out ${lapsedMed.daysWithoutSupply} days ago` : ""}.`,
    evidence, questions,
    share: ["A1c trend", "Medication fill history", ...(uacr ? ["Kidney results"] : [])],
  };
}

function nephrology(record) {
  const egfr = fromDoc(record.series, "egfr"), uacr = fromDoc(record.series, "uacr");
  if (!egfr && !uacr) return null;
  const prevE = egfr && priorHistory(record.series, "egfr", egfr.date);
  let windowDays, criterion;
  if (egfr && egfr.value < 30) { windowDays = [7, 21]; criterion = "New eGFR is below 30"; }
  else if (uacr && uacr.value >= 300) { windowDays = [21, 45]; criterion = "New urine albumin is 300 mg/g or higher"; }
  else if (egfr && egfr.value < 45 && prevE && prevE.value - egfr.value >= 10) { windowDays = [21, 45]; criterion = "New eGFR is below 45 and has dropped 10 or more points"; }
  else return null;
  const evidence = [];
  if (egfr) evidence.push(ev("document", `eGFR ${egfr.value} on ${egfr.date || "upload"}`));
  if (prevE) evidence.push(ev(prevE.source, `Previous eGFR ${prevE.value} on ${prevE.date}`));
  if (uacr) evidence.push(ev("document", `Urine albumin/creatinine ${uacr.value} mg/g`));
  return {
    specialty: "Nephrology", specialistTitle: "Nephrologist (kidney specialist)", windowDays,
    urgency: windowDays[1] <= 21 ? "high" : "medium", criterion,
    reason: `Your newly uploaded kidney results ${egfr ? `show an eGFR of ${egfr.value}` : ""}${egfr && uacr ? " and " : ""}${uacr ? `urine albumin of ${uacr.value} mg/g` : ""}.`,
    evidence,
    questions: ["What is causing the change in my kidney function?", "Should any of my medicines be adjusted for my kidneys?", "How often should my kidney tests be repeated?"],
    share: ["Kidney results", "Medication fill history"],
  };
}

function lipids(record) {
  const ldl = fromDoc(record.series, "ldl");
  if (!ldl || ldl.value < 190) return null;
  return {
    specialty: "Cardiology", specialistTitle: "Cardiologist (lipid clinic)", windowDays: [21, 45], urgency: "medium",
    criterion: "New LDL is 190 mg/dL or higher",
    reason: `Your newly uploaded LDL cholesterol is ${ldl.value} mg/dL.`,
    evidence: [ev("document", `LDL ${ldl.value} mg/dL`)],
    questions: ["Could this be an inherited cholesterol condition?", "Which treatment would lower my LDL most safely?"],
    share: ["Cholesterol results", "Medication fill history"],
  };
}

/** Returns { needed, primary, others, checked } for the current record. */
export function triage(record, document) {
  const checked = [
    "A1c: 9%+, or 8%+ and rising, or 7.5%+ rising with a lapsed diabetes medicine",
    "Kidney: eGFR under 30, eGFR under 45 and falling, or urine albumin 300+",
    "Cholesterol: LDL 190+",
  ];
  if (!document) return { needed: false, reason: "Upload a lab report first. Follow-ups are triggered by new results.", checked, primary: null, others: [] };
  const found = [endocrinology(record), nephrology(record), lipids(record)].filter(Boolean)
    .sort((a, b) => a.windowDays[1] - b.windowDays[1]);
  if (!found.length) {
    const watch = [["a1c", "A1c", "%", (v) => (v < 7.5 ? "within the agent's limits" : "below the referral threshold")],
      ["egfr", "eGFR", "", () => "above the referral threshold"], ["uacr", "Urine albumin", " mg/g", () => "below the referral threshold"],
      ["ldl", "LDL cholesterol", " mg/dL", () => "below the referral threshold"]];
    const reviewed = watch.map(([k, name, unit, note]) => {
      const d = fromDoc(record.series, k); if (!d) return null;
      const prev = priorHistory(record.series, k, d.date);
      return { name, value: `${d.value}${unit}`, previous: prev ? `${prev.value}${unit}` : null, note: note(d.value) };
    }).filter(Boolean);
    return { needed: false, reason: "None of your newly uploaded results, read with your history, call for a specialist visit. Keep following your regular care plan.", checked, reviewed, primary: null, others: [] };
  }
  for (const f of found) { f.reason = H(f.reason); f.questions = f.questions.map(H); f.evidence = f.evidence.map((e) => ({ ...e, detail: H(e.detail) })); }
  return { needed: true, primary: found[0], others: found.slice(1), checked, sourceLabels: label };
}
