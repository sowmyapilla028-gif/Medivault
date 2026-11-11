// SMART on FHIR / OAuth 2.0 authorization-code flow with PKCE (S256).
// Works for Epic (public or confidential client) and CMS Blue Button (confidential client).
import crypto from "node:crypto";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const discoveryCache = new Map();

/** Resolve authorize/token endpoints: explicit config wins, else SMART discovery on the FHIR base. */
export async function resolveEndpoints(src, fetchImpl = fetch) {
  if (src.authorizeUrl && src.tokenUrl) return { authorizeUrl: src.authorizeUrl, tokenUrl: src.tokenUrl };
  const cached = discoveryCache.get(src.fhirBase);
  if (cached) return cached;
  const res = await fetchImpl(`${src.fhirBase}/.well-known/smart-configuration`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`SMART discovery failed for ${src.label} (${res.status})`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error(`SMART discovery for ${src.label} is missing endpoints`);
  const endpoints = {
    authorizeUrl: src.authorizeUrl || doc.authorization_endpoint,
    tokenUrl: src.tokenUrl || doc.token_endpoint,
  };
  discoveryCache.set(src.fhirBase, endpoints);
  return endpoints;
}

export function newAuthRequest() {
  const verifier = b64url(crypto.randomBytes(32));
  return {
    state: b64url(crypto.randomBytes(16)),
    verifier,
    challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
  };
}

export function buildAuthorizeUrl(src, endpoints, req) {
  const u = new URL(endpoints.authorizeUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", src.clientId);
  u.searchParams.set("redirect_uri", src.redirectUri);
  u.searchParams.set("scope", src.scope);
  u.searchParams.set("state", req.state);
  u.searchParams.set("code_challenge", req.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (src.sendAud) u.searchParams.set("aud", src.fhirBase);
  return u.toString();
}

async function tokenRequest(src, endpoints, form, fetchImpl) {
  const headers = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams(form);
  if (src.clientSecret) {
    headers.Authorization = "Basic " + Buffer.from(`${encodeURIComponent(src.clientId)}:${encodeURIComponent(src.clientSecret)}`).toString("base64");
  } else {
    body.set("client_id", src.clientId);
  }
  const res = await fetchImpl(endpoints.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description || json?.error || text.slice(0, 200);
    throw new Error(`${src.label} token exchange failed (${res.status}): ${reason}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    patient: json.patient || null,
    scope: json.scope || src.scope,
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : null,
  };
}

export function exchangeCode(src, endpoints, code, verifier, fetchImpl = fetch) {
  return tokenRequest(src, endpoints, {
    grant_type: "authorization_code",
    code,
    redirect_uri: src.redirectUri,
    code_verifier: verifier,
  }, fetchImpl);
}

export function refresh(src, endpoints, refreshToken, fetchImpl = fetch) {
  return tokenRequest(src, endpoints, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl);
}
