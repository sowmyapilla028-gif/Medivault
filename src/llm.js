// Claude calls: (1) read an uploaded document into structured results, (2) write recommendations
// from the combined record. Both use structured outputs so the server gets validated JSON back.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config, llmConfigured } from "./config.js";
import { localRecommendations, parseDocumentText } from "./local-engine.js";
import { PrivacyShield } from "./privacy.js";
import { extractText, getDocumentProxy } from "unpdf";

let client;
const getClient = () => (client ||= new Anthropic());
export const setClientForTests = (c) => { client = c; };

// Opt into server-side refusal fallbacks (routes by refusal category; no model list to maintain).
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

export class LlmError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function structuredAnthropic({ system, content, schema, effort }) {
  let response;
  try {
    response = await getClient().beta.messages.parse({
      ...FALLBACK,
      model: config.anthropic.model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content }],
      output_config: { effort, format: betaZodOutputFormat(schema) },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new LlmError("The Anthropic API key is missing or invalid.", 500);
    if (err instanceof Anthropic.RateLimitError) throw new LlmError("Claude is rate limited right now. Try again in a minute.", 429);
    if (err instanceof Anthropic.BadRequestError) throw new LlmError(`Claude rejected the request: ${err.message}`, 400);
    if (err instanceof Anthropic.APIError) throw new LlmError(`Claude API error ${err.status ?? ""}: ${err.message}`, 502);
    if (err instanceof Anthropic.APIConnectionError) throw new LlmError("Couldn't reach the Claude API.", 502);
    throw err;
  }
  if (response.stop_reason === "refusal") {
    throw new LlmError(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}.`, 422);
  }
  if (response.stop_reason === "max_tokens") throw new LlmError("Claude's answer was cut off. Try a shorter document.", 502);
  if (!response.parsed_output) throw new LlmError("Claude's answer didn't match the expected format.", 502);
  return response.parsed_output;
}

/* ---------------- OpenAI-compatible provider (OpenCode Zen, OpenRouter, Groq, Ollama...) ---------------- */

function parseJsonReply(text) {
  let t = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.search(/[{[]/), end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start > 0 || end < t.length - 1) t = t.slice(Math.max(0, start), end + 1);
  return JSON.parse(t);
}

async function chatCompletion(body) {
  const { baseUrl, apiKey } = config.llm;
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LlmError(`Couldn't reach the LLM at ${baseUrl} (${err.message}).`, 502);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 300);
    const err = new LlmError(`LLM error ${res.status}: ${msg}`, res.status === 401 || res.status === 403 ? 500 : res.status === 429 ? 429 : 502);
    err.upstreamStatus = res.status;
    throw err;
  }
  const choice = json?.choices?.[0];
  if (!choice) throw new LlmError("The LLM returned no answer.", 502);
  return { text: choice.message?.content ?? "", finish: choice.finish_reason };
}

async function structuredOpenAI({ system, userParts, schema }) {
  if (!config.llm.model) throw new LlmError("Set LLM_MODEL in .env to a model your provider offers.", 500);
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
  const messages = [
    { role: "system", content: `${system}\n\nReply with only one JSON object, no prose and no code fences. It must validate against this JSON Schema:\n${jsonSchema}` },
    { role: "user", content: userParts.length === 1 && userParts[0].type === "text" ? userParts[0].text : userParts },
  ];
  let useJsonMode = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    let reply;
    try {
      reply = await chatCompletion({
        model: config.llm.model, messages, max_tokens: 16000,
        ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
      });
    } catch (err) {
      // Some providers/models reject response_format; retry once without it.
      if (useJsonMode && err.upstreamStatus === 400 && /response_format|json/i.test(err.message)) { useJsonMode = false; continue; }
      throw err;
    }
    if (reply.finish === "length") throw new LlmError("The LLM's answer was cut off. Try a shorter document or a model with a larger output limit.", 502);
    let problem;
    try {
      const parsed = schema.safeParse(parseJsonReply(reply.text));
      if (parsed.success) return parsed.data;
      problem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch (e) { problem = `not valid JSON (${e.message})`; }
    messages.push({ role: "assistant", content: reply.text }, { role: "user", content: `That reply was ${problem}. Reply again with only the corrected JSON object.` });
  }
  throw new LlmError("The LLM's answer didn't match the expected format after 3 tries. Try a stronger model.", 502);
}

/* ---------------- Document extraction ---------------- */

export const DocumentSchema = z.object({
  documentType: z.string().describe("e.g. lab report, discharge summary, visit note"),
  patientName: z.string().nullable(),
  birthDate: z.string().nullable().describe("YYYY-MM-DD"),
  documentDate: z.string().nullable().describe("Collection or visit date, YYYY-MM-DD"),
  results: z.array(z.object({
    name: z.string(),
    loinc: z.string().nullable().describe("LOINC code if you are confident, else null"),
    value: z.number().nullable(),
    valueText: z.string().nullable().describe("Use for non-numeric results such as 'Negative'"),
    unit: z.string().nullable(),
    flag: z.enum(["high", "low", "abnormal", "normal"]).nullable(),
    referenceRange: z.string().nullable(),
  })),
  diagnoses: z.array(z.string()),
  medications: z.array(z.string()),
  summary: z.string().describe("Two sentences on what this document shows"),
});

const DOC_SYSTEM = `You read a patient's medical document and transcribe it into structured data for a health app.
Transcribe only what the document states. Never infer or invent values. Keep result names as printed, but normalize obvious abbreviations (for example "HbA1c" stays "Hemoglobin A1c").
Dates must be YYYY-MM-DD. Blood pressure goes in valueText as "systolic/diastolic" with unit mmHg and value set to the systolic number.
If the document is not a medical document, return empty arrays and say so in the summary.\nPrivacy: names, birth dates, IDs, phone numbers, emails and addresses have been replaced with tokens such as [PATIENT_ab12cd] or [DOB_ab12cd]. Copy tokens exactly when you need them and never guess the real values. Write every date as YYYY-MM-DD.`;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function pdfToText(buffer) {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return text || "";
  } catch (err) {
    throw new LlmError(`Couldn't read that PDF (${err.message}).`, 422);
  }
}

const NOTHING_FOUND = "We didn't find any lab results or health information in this file. Upload a lab report or visit summary.";
const ensureMedical = (doc) => {
  if (!doc.results?.length && !doc.diagnoses?.length && !doc.medications?.length) throw new LlmError(NOTHING_FOUND, 422);
  return doc;
};

/**
 * privacy: { state: {salt, shiftDays}, known: {names, birthDates}, secret, onReport(report) }.
 * Everything sent to a model goes through PrivacyShield; nothing identifying leaves the server.
 */
export async function extractDocument(args) { return ensureMedical(await readDocument(args)); }

async function readDocument({ buffer, mimetype, filename, privacy = {} }) {
  const shield = new PrivacyShield({ ...(privacy.state || { salt: "dev", shiftDays: -90 }), secret: privacy.secret }, privacy.known);
  const report = (sent, text) => privacy.onReport?.(shield.report("document", text, sent));
  const isText = mimetype.startsWith("text/") || mimetype === "application/json";
  if (mimetype !== "application/pdf" && !IMAGE_TYPES.has(mimetype) && !isText) {
    throw new LlmError(`Unsupported file type ${mimetype}. Upload a PDF, image or text file.`, 415);
  }
  const ask = "Transcribe this document into the required JSON structure.";

  // No AI model configured: read the text and use the built-in parser. Nothing is sent anywhere,
  // but we still record what *would* have been sent so the privacy check can be shown.
  if (!llmConfigured()) {
    if (IMAGE_TYPES.has(mimetype)) throw new LlmError("Reading photos needs an AI model. Upload a text-based PDF or .txt file, or configure LLM_API_KEY and LLM_MODEL.", 422);
    const text = mimetype === "application/pdf" ? await pdfToText(buffer) : buffer.toString("utf8");
    if (text.replace(/\s/g, "").length < 20) throw new LlmError("This PDF has no readable text (it may be a scan). Upload a text-based PDF.", 422);
    report(false, shield.redact(text));
    return parseDocumentText(text);
  }

  // Photos can't be de-identified before reaching a model, so they are off unless explicitly allowed.
  if (IMAGE_TYPES.has(mimetype)) {
    if (process.env.PRIVACY_ALLOW_IMAGES !== "true") {
      throw new LlmError("Photos can't be de-identified before reaching the AI, so they're turned off. Upload a PDF or text file instead.", 422);
    }
    if (config.llm.provider === "openai" && !config.llm.vision) throw new LlmError("Photos need a model that can read images. Set LLM_VISION=true with a vision model, or upload a PDF or text file.", 422);
    privacy.onReport?.({ ...shield.report("document", "[image sent without de-identification: PRIVACY_ALLOW_IMAGES=true]", true), warning: "Image sent as-is" });
    const data = buffer.toString("base64");
    const out = config.llm.provider === "anthropic"
      ? await structuredAnthropic({ system: DOC_SYSTEM, content: [{ type: "image", source: { type: "base64", media_type: mimetype, data } }, { type: "text", text: ask }], schema: DocumentSchema, effort: "low" })
      : await structuredOpenAI({ system: DOC_SYSTEM, userParts: [{ type: "text", text: ask }, { type: "image_url", image_url: { url: `data:${mimetype};base64,${data}` } }], schema: DocumentSchema });
    return out;
  }

  // PDFs and text: read on the server, de-identify, then send only the de-identified text.
  const text = mimetype === "application/pdf" ? await pdfToText(buffer) : buffer.toString("utf8");
  if (text.replace(/\s/g, "").length < 20) {
    throw new LlmError("This PDF has no readable text (it may be a scan). Upload a text-based PDF.", 422);
  }
  const safe = shield.redact(text.slice(0, 200000));
  report(true, safe);
  const prompt = `${ask}\n\nDocument:\n\n${safe}`;
  const out = config.llm.provider === "anthropic"
    ? await structuredAnthropic({ system: DOC_SYSTEM, content: [{ type: "text", text: prompt }], schema: DocumentSchema, effort: "low" })
    : await structuredOpenAI({ system: DOC_SYSTEM, userParts: [{ type: "text", text: prompt }], schema: DocumentSchema });
  const back = shield.reidentify(out);
  // The real birth date only ever reached the model as a token; a plain date it returns is kept as written.
  if (out.birthDate && !/\[DOB_/.test(out.birthDate)) back.birthDate = out.birthDate;
  return back;
}

/* ---------------- Recommendations ---------------- */

export const RecommendationsSchema = z.object({
  headline: z.string().describe("One sentence addressed to the patient summarizing what matters most"),
  overview: z.string().describe("Short paragraph connecting what the document, EHR and pharmacy claims show together"),
  recommendations: z.array(z.object({
    title: z.string(),
    priority: z.enum(["high", "medium", "low"]),
    why: z.string().describe("Plain-language reason, citing specific values and dates from the record"),
    action: z.string().describe("One concrete next step for the patient"),
    evidence: z.array(z.object({
      source: z.enum(["document", "epic", "cms"]),
      detail: z.string().describe("The specific fact from that source, with its date"),
    })),
  })),
  questionsForDoctor: z.array(z.string()),
  dataGaps: z.array(z.string()).describe("Missing or conflicting data the patient should know about, including identity mismatches"),
});

const REC_SYSTEM = `You are a clinical decision-support assistant inside a patient-facing app. You receive one patient's combined record from three sources:
- "document": a file the patient just uploaded (read by an extraction step).
- "epic": their EHR via SMART on FHIR (problem list, labs, vitals, allergies, immunizations).
- "cms": their Medicare Part D pharmacy claims via CMS Blue Button (what was actually filled, with days of supply).
The server has already computed lab trends and medication supply (refill gaps, proportion of days covered). Trust those numbers; do not recompute them.

Write recommendations that are only possible by combining sources: for example a rising lab value together with a lapsed refill, an allergy in the EHR against a dispensed drug, a diagnosis with no matching treatment fills, or a newer document value that changes the picture. Single-source items are fine when clearly important.
Rules:
- Cite only facts present in the input. Every recommendation needs evidence entries naming the source and the specific value and date.
- Write for the patient in plain language. Suggest discussing changes with their clinician; never tell them to start, stop or change a medication on their own, and never diagnose.
- Order by priority. Use "high" only for safety issues or clearly worsening control. Aim for 3 to 7 recommendations.
- If the identity check shows the sources describe different people (common with separate sandbox test accounts), say so first in dataGaps and keep recommendations explicit about which source each fact comes from.\nPrivacy: names, birth dates, IDs, phone numbers, emails and addresses have been replaced with tokens such as [PATIENT_ab12cd] or [DOB_ab12cd]. Copy tokens exactly when you need them and never guess the real values. Write every date as YYYY-MM-DD.`;

const line = (f) => [f.date || "undated", f.source, f.kind, f.label,
  f.valueText || (f.value != null ? `${f.value} ${f.unit || ""}`.trim() : ""),
  f.interpretation ? `flag:${f.interpretation}` : "", f.ref ? `ref:${f.ref}` : ""].filter(Boolean).join(" | ");

export async function generateRecommendations(record, document, privacy = {}) {
  const clinical = record.facts.filter((f) => f.kind !== "fill").map(line).join("\n");
  const meds = record.medications.map((m) =>
    `${m.label}: ${m.fills.length} fill(s), last ${m.lastFill} (${m.daysSupply ?? "?"} days), runs out ${m.runOutDate}, ` +
    `${m.daysWithoutSupply} days without supply as of ${record.asOf}, status ${m.status}` +
    (m.proportionOfDaysCovered180 != null ? `, ${m.proportionOfDaysCovered180}% of last 180 days covered` : "")).join("\n");
  const trends = Object.entries(record.series).map(([k, pts]) =>
    `${k}: ${pts.map((p) => `${p.date} ${p.value2 != null ? `${p.value}/${p.value2}` : p.value} (${p.source})`).join(" -> ")}`).join("\n");

  const content = `Today is ${record.asOf}.

IDENTITY CHECK (does each source match the person on the uploaded document?):
${JSON.stringify({ ehr: record.identity.epic?.status || "not connected", pharmacy: record.identity.cms?.status || "not connected" })}

UPLOADED DOCUMENT SUMMARY:
${document ? `${document.documentType}: ${document.summary}\nDiagnoses listed: ${document.diagnoses.join("; ") || "none"}\nMedications listed: ${document.medications.join("; ") || "none"}` : "No document uploaded."}

LAB AND VITAL TRENDS (computed):
${trends || "none"}

MEDICATION SUPPLY FROM PHARMACY CLAIMS (computed):
${meds || "No pharmacy claims."}

CLINICAL FACTS (date | source | type | item | value | flag | reference):
${clinical || "none"}`;

  const shield = new PrivacyShield({ ...(privacy.state || { salt: "dev", shiftDays: -90 }), secret: privacy.secret }, privacy.known);
  const safe = shield.redact(content);
  if (!llmConfigured()) {
    privacy.onReport?.(shield.report("recommendations", safe, false));
    return localRecommendations(record, document);
  }
  privacy.onReport?.(shield.report("recommendations", safe, true));
  const out = config.llm.provider === "anthropic"
    ? await structuredAnthropic({ system: REC_SYSTEM, content: [{ type: "text", text: safe }], schema: RecommendationsSchema, effort: "high" })
    : await structuredOpenAI({ system: REC_SYSTEM, userParts: [{ type: "text", text: safe }], schema: RecommendationsSchema });
  return shield.reidentify(out);
}
