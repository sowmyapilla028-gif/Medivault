// Turn ISO dates (2026-08-20) inside patient-facing text into readable ones (Aug 20, 2026).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const humanDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
};
export const humanizeText = (s) => (typeof s === "string" ? s.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => humanDate(d)) : s);
