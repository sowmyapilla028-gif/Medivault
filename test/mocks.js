// Local stand-ins for Epic, CMS Blue Button and the Claude API, used only by tests.
import crypto from "node:crypto";
import express from "express";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bundle = (resources, next) => ({ resourceType: "Bundle", type: "searchset", total: resources.length,
  link: next ? [{ relation: "next", url: next }] : [], entry: resources.map((resource) => ({ resource })) });

export function startMocks() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: "50mb" }));
  const seen = { tokenRequests: [], claudeRequests: [], chatRequests: [], fhirAuth: [], conditionQueries: [] };
  const codes = new Map();
  let base = "";

  // ---------- OAuth (shared shape for both) ----------
  const authorize = (prefix) => (req, res) => {
    const code = crypto.randomBytes(8).toString("hex");
    codes.set(code, { challenge: req.query.code_challenge, prefix, aud: req.query.aud, scope: req.query.scope, redirect: req.query.redirect_uri });
    const u = new URL(req.query.redirect_uri);
    u.searchParams.set("code", code); u.searchParams.set("state", req.query.state);
    res.redirect(u.toString());
  };
  const token = (prefix, patient) => (req, res) => {
    seen.tokenRequests.push({ prefix, body: req.body, auth: req.headers.authorization || null });
    const c = codes.get(req.body.code);
    if (!c || c.prefix !== prefix) return res.status(400).json({ error: "invalid_grant" });
    if (b64url(crypto.createHash("sha256").update(req.body.code_verifier || "").digest()) !== c.challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE failed" });
    codes.delete(req.body.code);
    res.json({ access_token: `${prefix}-token`, token_type: "Bearer", expires_in: 3600, patient, scope: c.scope });
  };
  const requireToken = (tok) => (req, res, next) => {
    seen.fhirAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${tok}`) return res.status(401).json({ resourceType: "OperationOutcome" });
    next();
  };

  // ---------- Epic ----------
  app.get("/epic/fhir/.well-known/smart-configuration", (req, res) =>
    res.json({ authorization_endpoint: `${base}/epic/oauth2/authorize`, token_endpoint: `${base}/epic/oauth2/token` }));
  app.get("/epic/oauth2/authorize", authorize("epic"));
  app.post("/epic/oauth2/token", token("epic", "eP1"));
  app.use("/epic/fhir", requireToken("epic-token"));
  app.get("/epic/fhir/Patient/eP1", (req, res) => res.json({ resourceType: "Patient", id: "eP1", name: [{ use: "official", given: ["Camila"], family: "Lopez" }], birthDate: "1987-09-12", gender: "female" }));
  app.get("/epic/fhir/Condition", (req, res) => (seen.conditionQueries.push(req.query), res.json(bundle([
    { resourceType: "Condition", id: "c1", clinicalStatus: { coding: [{ code: "active" }] }, code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "E11.9", display: "Type 2 diabetes mellitus" }], text: "Type 2 diabetes mellitus" }, onsetDateTime: "2019-06-12" },
    { resourceType: "Condition", id: "c2", clinicalStatus: { coding: [{ code: "resolved" }] }, code: { text: "Acute bronchitis" } },
    { resourceType: "OperationOutcome", issue: [{ severity: "warning" }] },
  ]))));
  app.get("/epic/fhir/Observation", (req, res) => {
    if (req.query.category === "laboratory") {
      if (req.query.page === "2") return res.json(bundle([
        { resourceType: "Observation", id: "l2", status: "final", category: [{ coding: [{ code: "laboratory" }] }], code: { coding: [{ system: "http://loinc.org", code: "4548-4" }], text: "Hemoglobin A1c" }, effectiveDateTime: "2026-08-04", valueQuantity: { value: 8.1, unit: "%" } },
      ]));
      return res.json(bundle([
        { resourceType: "Observation", id: "l1", status: "final", category: [{ coding: [{ code: "laboratory" }] }], code: { coding: [{ system: "http://loinc.org", code: "4548-4" }], text: "Hemoglobin A1c" }, effectiveDateTime: "2026-02-10T10:00:00Z", valueQuantity: { value: 7.4, unit: "%" }, referenceRange: [{ text: "<5.7" }] },
      ], `${base}/epic/fhir/Observation?patient=eP1&category=laboratory&page=2`));
    }
    return res.json(bundle([
      { resourceType: "Observation", id: "v1", status: "final", category: [{ coding: [{ code: "vital-signs" }] }], code: { coding: [{ system: "http://loinc.org", code: "85354-9" }], text: "Blood pressure" }, effectiveDateTime: "2026-08-04",
        component: [{ code: { coding: [{ code: "8480-6" }], text: "Systolic" }, valueQuantity: { value: 142, unit: "mmHg" } }, { code: { coding: [{ code: "8462-4" }], text: "Diastolic" }, valueQuantity: { value: 88, unit: "mmHg" } }] },
    ]));
  });
  app.get("/epic/fhir/AllergyIntolerance", (req, res) => res.json(bundle([
    { resourceType: "AllergyIntolerance", id: "a1", code: { text: "Penicillin" }, reaction: [{ manifestation: [{ text: "Hives" }] }], recordedDate: "2009-05-01" },
  ])));
  app.get("/epic/fhir/Immunization", (req, res) => res.status(403).json({ resourceType: "OperationOutcome" }));

  // ---------- CMS Blue Button ----------
  app.get("/cms/o/authorize", authorize("cms"));
  app.post("/cms/o/token", (req, res, next) => {
    if (req.headers.authorization !== "Basic " + Buffer.from("cms-client:cms-secret").toString("base64")) return res.status(401).json({ error: "invalid_client" });
    next();
  }, token("cms", "-10000000000066"));
  app.use("/cms/fhir", requireToken("cms-token"));
  app.get("/cms/fhir/Patient/-10000000000066", (req, res) => res.json({ resourceType: "Patient", id: "-10000000000066", name: [{ given: ["Jane"], family: "Doe" }], birthDate: "1950-01-01" }));
  const pde = (id, ndc, display, date, days) => ({ resourceType: "ExplanationOfBenefit", id, type: { coding: [{ code: "PDE" }] },
    item: [{ sequence: 1, productOrService: { coding: [{ system: "http://hl7.org/fhir/sid/ndc", code: ndc, display }] }, servicedDate: date, quantity: { value: days * 2 } }],
    supportingInfo: [{ category: { coding: [{ system: "http://hl7.org/fhir/us/carin-bb/CodeSystem/C4BBSupportingInfoType", code: "dayssupply" }] }, valueQuantity: { value: days } }] });
  app.get("/cms/fhir/ExplanationOfBenefit", (req, res) => {
    if (req.query.type !== "pde") return res.status(400).end();
    res.json(bundle([
      pde("p1", "00093101801", "METFORMIN HCL 1000 MG TABLET", "2026-05-02", 30),
      pde("p2", "00093101801", "METFORMIN HCL 1000 MG TABLET", "2026-06-01", 30),
      pde("p3", "00071015523", "ATORVASTATIN 40 MG TABLET", "2026-04-10", 90),
    ]));
  });

  // ---------- OpenAI-compatible Chat Completions (e.g. OpenCode Zen) ----------
  let recAttempts = 0;
  app.post("/zen/v1/chat/completions", (req, res) => {
    seen.chatRequests.push({ body: req.body, headers: req.headers });
    if (req.headers.authorization !== "Bearer zen-key") return res.status(401).json({ error: { message: "bad key" } });
    const system = req.body.messages[0].content;
    let content;
    if (system.includes("Transcribe only what the document states")) {
      // Prose + fenced JSON: the server must still parse it.
      content = "Here you go:\n```json\n" + JSON.stringify({ documentType: "Lab report", patientName: "Camila Lopez", birthDate: "1987-09-12", documentDate: "2026-11-03",
        results: [{ name: "Hemoglobin A1c", loinc: "4548-4", value: 8.9, valueText: null, unit: "%", flag: "high", referenceRange: "<5.7" }],
        diagnoses: [], medications: [], summary: "A1c is high." }) + "\n```";
    } else if (recAttempts++ === 0) {
      content = JSON.stringify({ headline: "Missing fields" }); // invalid on purpose -> server retries
    } else {
      content = JSON.stringify({ headline: "A1c rising.", overview: "Combined.", recommendations: [{ title: "Talk about metformin", priority: "high", why: "w", action: "a",
        evidence: [{ source: "document", detail: "A1c 8.9%" }] }], questionsForDoctor: [], dataGaps: [] });
    }
    res.json({ id: "c1", object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] });
  });

  // ---------- Claude API ----------
  app.post("/v1/messages", (req, res) => {
    seen.claudeRequests.push({ body: req.body, headers: req.headers });
    const isDoc = String(JSON.stringify(req.body.system)).includes("Transcribe only what the document states");
    const out = isDoc ? {
      documentType: "Lab report", patientName: "Camila Lopez", birthDate: "1987-09-12", documentDate: "2026-11-03",
      results: [{ name: "Hemoglobin A1c", loinc: "4548-4", value: 8.9, valueText: null, unit: "%", flag: "high", referenceRange: "<5.7" }],
      diagnoses: [], medications: [], summary: "A1c is high.",
    } : {
      headline: "Your A1c is rising while metformin refills stopped.", overview: "Combined view.",
      recommendations: [{ title: "Restart metformin conversation", priority: "high", why: "A1c 7.4 -> 8.9; metformin ran out.", action: "Talk to your doctor.",
        evidence: [{ source: "document", detail: "A1c 8.9% on 2026-11-03" }, { source: "cms", detail: "Metformin last fill 2026-06-01" }] }],
      questionsForDoctor: ["Should I restart metformin?"], dataGaps: ["CMS record is for a different person."],
    };
    res.json({ id: "msg_test", type: "message", role: "assistant", model: req.body.model, content: [{ type: "text", text: JSON.stringify(out) }],
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; resolve({ base, server, seen }); });
  });
}
