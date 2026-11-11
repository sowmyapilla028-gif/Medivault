import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import multer from "multer";
import { config, isConfigured, llmConfigured, llmLabel } from "./config.js";
import { buildAuthorizeUrl, exchangeCode, newAuthRequest, refresh, resolveEndpoints } from "./oauth.js";
import { fetchEpic } from "./sources/epic.js";
import { fetchCms } from "./sources/cms.js";
import { buildRecord } from "./analysis.js";
import { extractDocument, generateRecommendations, LlmError } from "./llm.js";
import { demoCms, demoEhr, sampleReportText } from "./demo-data.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FETCHERS = { epic: fetchEpic, cms: fetchCms };

export function createApp({ fetchImpl = fetch } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "1mb" }));

  let secret = config.sessionSecret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    console.warn("SESSION_SECRET is not set; using a random one. Sessions reset when the server restarts.");
  }
  app.use(session({
    name: "medivault.sid", secret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: config.secureCookies, maxAge: 4 * 3600 * 1000 },
  }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const sourceParam = (req, res) => {
    const id = req.params.source;
    if (!config.sources[id]) { res.status(404).json({ error: "Unknown source" }); return null; }
    return config.sources[id];
  };

  /* ---------- status ---------- */
  app.get("/api/status", (req, res) => {
    const s = req.session.sources || {};
    const src = (id) => ({
      label: config.sources[id].label,
      configured: isConfigured(id),
      connected: Boolean(s[id]?.token || s[id]?.demo),
      demo: Boolean(s[id]?.demo),
      fetchedAt: s[id]?.fetchedAt || null,
      error: s[id]?.error || null,
    });
    res.json({
      llmConfigured: llmConfigured(),
      llmLabel: llmLabel(),
      document: req.session.document ? { name: req.session.documentName, ...req.session.document } : null,
      sources: { epic: src("epic"), cms: src("cms") },
    });
  });

  /* ---------- document upload ---------- */
  app.post("/api/document", upload.single("file"), wrap(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Attach a file in the 'file' field." });
    const mimetype = req.file.mimetype === "application/octet-stream" && /\.pdf$/i.test(req.file.originalname) ? "application/pdf" : req.file.mimetype;
    const doc = await extractDocument({ buffer: req.file.buffer, mimetype, filename: req.file.originalname });
    req.session.document = doc;
    req.session.documentName = req.file.originalname;
    req.session.recommendations = null;
    res.json({ name: req.file.originalname, ...doc });
  }));
  app.post("/api/document/sample", wrap(async (req, res) => {
    const name = "sample-lab-report-demo.txt";
    const doc = await extractDocument({ buffer: Buffer.from(sampleReportText()), mimetype: "text/plain", filename: name });
    req.session.document = doc; req.session.documentName = name; req.session.recommendations = null;
    res.json({ name, ...doc });
  }));

  // Opt-in demo records for a source (no sign-in). Replaced by a real connection when the user connects.
  app.post("/api/demo/:source", (req, res) => {
    const src = sourceParam(req, res); if (!src) return;
    const data = src.id === "epic" ? demoEhr() : demoCms();
    req.session.sources = { ...(req.session.sources || {}), [src.id]: { demo: true, data, fetchedAt: new Date().toISOString() } };
    req.session.recommendations = null;
    res.json({ ok: true });
  });

  app.delete("/api/document", (req, res) => {
    req.session.document = null; req.session.documentName = null; req.session.recommendations = null;
    res.json({ ok: true });
  });

  /* ---------- OAuth ---------- */
  app.get("/auth/:source/start", wrap(async (req, res) => {
    const src = sourceParam(req, res); if (!src) return;
    if (!isConfigured(src.id)) return res.redirect(`/?error=${encodeURIComponent(`${src.label} isn't configured on the server. Add its client ID to .env.`)}#review`);
    const endpoints = await resolveEndpoints(src, fetchImpl);
    const authReq = newAuthRequest();
    req.session.oauth = { ...(req.session.oauth || {}), [src.id]: { state: authReq.state, verifier: authReq.verifier } };
    res.redirect(buildAuthorizeUrl(src, endpoints, authReq));
  }));

  app.get("/auth/:source/callback", wrap(async (req, res) => {
    const src = sourceParam(req, res); if (!src) return;
    const back = (msg) => res.redirect(msg ? `/?error=${encodeURIComponent(msg)}#review` : "/#review");
    if (req.query.error) return back(`${src.label}: ${req.query.error_description || req.query.error}`);
    const pending = req.session.oauth?.[src.id];
    if (!pending || pending.state !== req.query.state) return back(`${src.label} sign-in expired or didn't match. Try connecting again.`);
    delete req.session.oauth[src.id];
    try {
      const endpoints = await resolveEndpoints(src, fetchImpl);
      const token = await exchangeCode(src, endpoints, String(req.query.code || ""), pending.verifier, fetchImpl);
      req.session.sources = { ...(req.session.sources || {}), [src.id]: { token } };
      await loadSource(req, src);
      back();
    } catch (err) {
      console.error(err);
      back(err.message);
    }
  }));

  app.post("/auth/:source/disconnect", (req, res) => {
    const src = sourceParam(req, res); if (!src) return;
    if (req.session.sources) delete req.session.sources[src.id];
    req.session.recommendations = null;
    res.json({ ok: true });
  });

  async function validToken(req, src) {
    const entry = req.session.sources?.[src.id];
    if (!entry?.token) return null;
    const t = entry.token;
    if (t.expiresAt && t.expiresAt - Date.now() < 60_000) {
      if (!t.refreshToken) { delete req.session.sources[src.id]; return null; }
      const endpoints = await resolveEndpoints(src, fetchImpl);
      const fresh = await refresh(src, endpoints, t.refreshToken, fetchImpl);
      entry.token = { ...fresh, patient: fresh.patient || t.patient, refreshToken: fresh.refreshToken || t.refreshToken };
    }
    return entry.token;
  }

  async function loadSource(req, src) {
    const token = await validToken(req, src);
    if (!token) throw Object.assign(new Error(`${src.label} isn't connected.`), { status: 401 });
    const entry = req.session.sources[src.id];
    try {
      entry.data = await FETCHERS[src.id]({ base: src.fhirBase, token: token.accessToken, patientId: token.patient, fetchImpl, conditionCategory: src.conditionCategory });
      entry.fetchedAt = new Date().toISOString();
      entry.error = null;
    } catch (err) {
      entry.error = err.message;
      throw err;
    }
    req.session.recommendations = null;
    return entry.data;
  }

  app.get("/api/sources/:source", wrap(async (req, res) => {
    const src = sourceParam(req, res); if (!src) return;
    const entry = req.session.sources?.[src.id];
    if (entry?.demo) return res.json({ fetchedAt: entry.fetchedAt, ...entry.data });
    if (!entry?.token) return res.status(401).json({ error: `${src.label} isn't connected.` });
    const data = req.query.refresh || !entry.data ? await loadSource(req, src) : entry.data;
    res.json({ fetchedAt: entry.fetchedAt, ...data });
  }));

  /* ---------- combined record + recommendations ---------- */
  const currentRecord = (req) => buildRecord({
    document: req.session.document,
    epic: req.session.sources?.epic?.data,
    cms: req.session.sources?.cms?.data,
  });

  app.get("/api/record", (req, res) => res.json(currentRecord(req)));

  app.post("/api/recommendations", wrap(async (req, res) => {
    const s = req.session.sources || {};
    if (!req.session.document && !s.epic?.data && !s.cms?.data) {
      return res.status(400).json({ error: "Upload a document or connect a source first." });
    }
    if (req.session.recommendations && !req.body?.regenerate) return res.json(req.session.recommendations);
    const record = currentRecord(req);
    const result = await generateRecommendations(record, req.session.document);
    req.session.recommendations = { generatedAt: new Date().toISOString(), record, ...result };
    res.json(req.session.recommendations);
  }));

  app.post("/api/reset", (req, res) => req.session.destroy(() => res.json({ ok: true })));

  /* ---------- static frontend ---------- */
  app.use(express.static(path.join(here, "..", "public")));

  app.use((err, req, res, _next) => {
    const status = err instanceof LlmError ? err.status : err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.code === "LIMIT_FILE_SIZE" ? "That file is larger than 25 MB." : err.message || "Something went wrong." });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const missing = [];
  if (!isConfigured("epic")) missing.push("EHR_CLIENT_ID");
  if (!isConfigured("cms")) missing.push("CMS_CLIENT_ID / CMS_CLIENT_SECRET");
  if (!llmConfigured()) console.log("No AI model configured: using the built-in parser and rules (demo mode).");
  createApp().listen(config.port, () => {
    console.log(`Medivault running at ${config.appUrl}`);
    console.log(`EHR: ${config.sources.epic.label} at ${config.sources.epic.fhirBase}`);
    console.log(`LLM: ${llmConfigured() ? `${llmLabel()}${config.llm.provider === "openai" ? ` via ${config.llm.baseUrl}` : ""}` : "none (built-in rules)"}`);
    console.log(`EHR redirect URI: ${config.sources.epic.redirectUri}`);
    console.log(`CMS redirect URI:  ${config.sources.cms.redirectUri}`);
    if (missing.length) console.warn(`Not configured (use the "Use demo data" buttons instead): ${missing.join(", ")}`);
    console.log(`Open ${config.appUrl} in your browser.`);
  });
}
