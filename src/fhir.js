// Minimal FHIR R4 read/search client that follows Bundle paging.
export class FhirError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function fhirClient({ base, token, fetchImpl = fetch, maxPages = 10 }) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/fhir+json" };

  async function get(url) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new FhirError(`GET ${url.replace(base, "")} returned ${res.status} ${body.slice(0, 160)}`, res.status);
    }
    return res.json();
  }

  return {
    read: (type, id) => get(`${base}/${type}/${encodeURIComponent(id)}`),
    /** Search and return every resource of `type` across pages (OperationOutcome entries dropped). */
    async search(type, params) {
      let url = `${base}/${type}?${new URLSearchParams(params)}`;
      const out = [];
      for (let page = 0; url && page < maxPages; page++) {
        const bundle = await get(url);
        for (const e of bundle.entry || []) if (e.resource?.resourceType === type) out.push(e.resource);
        url = bundle.link?.find((l) => l.relation === "next")?.url || null;
      }
      return out;
    },
  };
}
