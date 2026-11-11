// Privacy shield: everything sent to an AI model passes through here first.
//
// 1. Direct identifiers (names, dates of birth, record/member IDs, SSNs, phone numbers, emails,
//    street addresses) are replaced with keyed hashes: HMAC-SHA256 with a per-session secret,
//    e.g. "Rosa Delgado" -> [PATIENT_7f3a9c]. The same value always gets the same token within a
//    session, so the model can still tell that two records refer to the same person.
// 2. Every date is shifted by a hidden per-session offset, so intervals and trends stay exact
//    but real dates of service are not exposed.
// 3. The model's answer is mapped back on the server (tokens -> values, dates un-shifted).
//    The token map and the key never leave the server.
//
// Lab values, units, diagnoses and drug names are kept: the model needs them to reason.
import crypto from "node:crypto";

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const parseIso = (s) => new Date(`${s}T00:00:00Z`);

export function newPrivacyState() {
  // Offset between 45 and 400 days into the past; never zero.
  return { salt: crypto.randomBytes(16).toString("hex"), shiftDays: -(45 + crypto.randomInt(356)) };
}

export class PrivacyShield {
  constructor({ salt, shiftDays, secret = "" }, known = {}) {
    this.key = crypto.createHash("sha256").update(`${secret}:${salt}`).digest();
    this.shiftDays = shiftDays;
    this.map = new Map(); // token -> original
    this.counts = {};
    this.datesShifted = 0;
    this.names = [...new Set((known.names || []).filter(Boolean).map((n) => n.trim()).filter((n) => n.length > 2))];
    this.birthDates = [...new Set((known.birthDates || []).filter(Boolean))];
  }

  token(kind, value) {
    if (kind === "DOB") { // store birth dates as YYYY-MM-DD so they compare with FHIR birthDate
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(String(value).trim());
      if (m) value = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    }
    const norm = String(value).trim().toLowerCase().replace(/\s+/g, " ");
    const h = crypto.createHmac("sha256", this.key).update(`${kind}:${norm}`).digest("hex").slice(0, 6);
    const t = `[${kind}_${h}]`;
    if (!this.map.has(t)) this.map.set(t, String(value).trim());
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    return t;
  }

  shift(isoDate, dir = 1) {
    const d = parseIso(isoDate);
    if (Number.isNaN(d.getTime())) return isoDate;
    return iso(new Date(d.getTime() + dir * this.shiftDays * DAY));
  }

  /** De-identify free text before it is sent to a model. */
  redact(text) {
    if (!text) return text;
    let t = String(text);
    const tok = (kind) => (_, label, value) => `${label}${this.token(kind, value)}`;

    // Labeled fields first (most reliable).
    t = t.replace(/((?:patient(?: name)?|name|member|beneficiary)\s*:\s*)([A-Za-z][A-Za-z',.-]*(?: [A-Za-z][A-Za-z',.-]*){0,3}?)(?=\s{2,}|\s+(?:DOB|MRN|ID|Sex|Age)\b|\s*$|\s*\n)/gim, tok("PATIENT"));
    t = t.replace(/((?:DOB|date of birth|birth ?date)\s*[:\s]\s*)(\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4})/gi, tok("DOB"));
    t = t.replace(/((?:MRN|medical record (?:number|no\.?)|member id|patient id|subscriber id|account (?:no\.?|number))\s*[:#]?\s*)([A-Z0-9][A-Z0-9-]{3,})/gi, tok("ID"));
    t = t.replace(/((?:SSN|social security(?: number)?)\s*[:#]?\s*)(\d{3}-?\d{2}-?\d{4})/gi, tok("ID"));

    // Known identifiers from the connected records, anywhere in the text.
    for (const name of [...this.names].sort((a, b) => b.length - a.length)) {
      const parts = name.split(/\s+/);
      const variants = [name, parts.length > 1 ? `${parts.at(-1)}, ${parts.slice(0, -1).join(" ")}` : null].filter(Boolean);
      for (const v of variants) t = t.replace(new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), () => this.token("PATIENT", name));
      for (const p of parts.filter((p) => p.length > 2)) t = t.replace(new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), () => this.token("NAME", p));
    }
    for (const dob of this.birthDates) {
      const [y, m, d] = dob.split("-");
      for (const v of [dob, `${m}/${d}/${y}`, `${+m}/${+d}/${y}`]) if (t.includes(v)) t = t.split(v).join(this.token("DOB", dob));
    }

    // Contact details and IDs by pattern.
    t = t.replace(/\b\d{3}-\d{2}-\d{4}\b/g, (m) => this.token("ID", m));
    t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => this.token("EMAIL", m));
    t = t.replace(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, (m) => this.token("PHONE", m));
    t = t.replace(/\b\d{1,5}\s+(?:[A-Z][a-z]+\s){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Way|Court|Ct|Plaza|Place|Pl|Terrace|Ter)\b\.?(?:,?\s*(?:Suite|Ste|Apt|Unit)\s*\w+)?/g, (m) => this.token("ADDRESS", m));

    // Shift every remaining date (tokens contain no dates, so birth dates stay tokenized).
    t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => { this.datesShifted++; return this.shift(m); });
    t = t.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (m, mo, d, y) => {
      this.datesShifted++;
      return this.shift(`${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`);
    });
    return t;
  }

  /** Map a model answer back: tokens -> original values, shifted dates -> real dates. */
  reidentify(value) {
    if (typeof value === "string") {
      // Un-shift dates first, then restore tokens (restored values such as birth dates are real already).
      let s = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (m) => this.shift(m, -1));
      s = s.replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}), (\d{4})\b/g, (m, mon, d, y) => {
        const back = this.shift(`${y}-${String(MONTHS.indexOf(mon.toLowerCase()) + 1).padStart(2, "0")}-${d.padStart(2, "0")}`, -1);
        return back;
      });
      for (const [t, orig] of this.map) s = s.split(t).join(orig);
      return s;
    }
    if (Array.isArray(value)) return value.map((v) => this.reidentify(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.reidentify(v)]));
    return value;
  }

  report(stage, sentText, sent) {
    return {
      stage, sentToAI: sent, at: new Date().toISOString(),
      replaced: { ...this.counts }, identifiersReplaced: Object.values(this.counts).reduce((a, b) => a + b, 0),
      datesShifted: this.datesShifted,
      preview: String(sentText || "").slice(0, 2500),
    };
  }
}
