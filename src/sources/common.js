export const firstCoding = (cc, systemHint) =>
  (systemHint && cc?.coding?.find((c) => (c.system || "").includes(systemHint))) || cc?.coding?.[0] || null;

export const ccText = (cc) => cc?.text || cc?.coding?.find((c) => c.display)?.display || cc?.coding?.[0]?.code || null;

export const isoDate = (s) => (typeof s === "string" && s.length >= 10 ? s.slice(0, 10) : s || null);

export function patientSummary(p) {
  if (!p) return null;
  const n = p.name?.find((x) => x.use === "official") || p.name?.[0];
  const name = n ? (n.text || [...(n.given || []), n.family].filter(Boolean).join(" ")) : null;
  return { id: p.id, name, birthDate: p.birthDate || null, gender: p.gender || null };
}

/** Run named async loaders; collect results and per-loader errors instead of failing the whole fetch. */
export async function settle(loaders) {
  const names = Object.keys(loaders);
  const results = await Promise.allSettled(names.map((n) => loaders[n]()));
  const data = {}, warnings = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") data[names[i]] = r.value;
    else { data[names[i]] = []; warnings.push(`${names[i]}: ${r.reason?.message || r.reason}`); }
  });
  return { data, warnings };
}
