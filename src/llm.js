// Claude calls: (1) read an uploaded document into structured results, (2) write recommendations
// from the combined record. Both use structured outputs so the server gets validated JSON back.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";

let client;
const getClient = () => (client ||= new Anthropic());
export const setClientForTests = (c) => { client = c; };

// Opt into server-side refusal fallbacks (routes by refusal category; no model list to maintain).
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

export class LlmError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function structured({ system, content, schema, effort }) {
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
If the document is not a medical document, return empty arrays and say so in the summary.`;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export async function extractDocument({ buffer, mimetype, filename }) {
  let block;
  if (mimetype === "application/pdf") {
    block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") }, title: filename };
  } else if (IMAGE_TYPES.has(mimetype)) {
    block = { type: "image", source: { type: "base64", media_type: mimetype, data: buffer.toString("base64") } };
  } else if (mimetype.startsWith("text/") || mimetype === "application/json") {
    block = { type: "text", text: `Document "${filename}":\n\n${buffer.toString("utf8")}` };
  } else {
    throw new LlmError(`Unsupported file type ${mimetype}. Upload a PDF, image or text file.`, 415);
  }
  return structured({
    system: DOC_SYSTEM,
    content: [block, { type: "text", text: "Transcribe this document into the required JSON structure." }],
    schema: DocumentSchema,
    effort: "low",
  });
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
- "epic": their EHR via Epic FHIR (problem list, labs, vitals, allergies, immunizations).
- "cms": their Medicare Part D pharmacy claims via CMS Blue Button (what was actually filled, with days of supply).
The server has already computed lab trends and medication supply (refill gaps, proportion of days covered). Trust those numbers; do not recompute them.

Write recommendations that are only possible by combining sources: for example a rising lab value together with a lapsed refill, an allergy in the EHR against a dispensed drug, a diagnosis with no matching treatment fills, or a newer document value that changes the picture. Single-source items are fine when clearly important.
Rules:
- Cite only facts present in the input. Every recommendation needs evidence entries naming the source and the specific value and date.
- Write for the patient in plain language. Suggest discussing changes with their clinician; never tell them to start, stop or change a medication on their own, and never diagnose.
- Order by priority. Use "high" only for safety issues or clearly worsening control. Aim for 3 to 7 recommendations.
- If the identity check shows the sources describe different people (common with separate sandbox test accounts), say so first in dataGaps and keep recommendations explicit about which source each fact comes from.`;

const line = (f) => [f.date || "undated", f.source, f.kind, f.label,
  f.valueText || (f.value != null ? `${f.value} ${f.unit || ""}`.trim() : ""),
  f.interpretation ? `flag:${f.interpretation}` : "", f.ref ? `ref:${f.ref}` : ""].filter(Boolean).join(" | ");

export async function generateRecommendations(record, document) {
  const clinical = record.facts.filter((f) => f.kind !== "fill").map(line).join("\n");
  const meds = record.medications.map((m) =>
    `${m.label}: ${m.fills.length} fill(s), last ${m.lastFill} (${m.daysSupply ?? "?"} days), runs out ${m.runOutDate}, ` +
    `${m.daysWithoutSupply} days without supply as of ${record.asOf}, status ${m.status}` +
    (m.proportionOfDaysCovered180 != null ? `, ${m.proportionOfDaysCovered180}% of last 180 days covered` : "")).join("\n");
  const trends = Object.entries(record.series).map(([k, pts]) =>
    `${k}: ${pts.map((p) => `${p.date} ${p.value2 != null ? `${p.value}/${p.value2}` : p.value} (${p.source})`).join(" -> ")}`).join("\n");

  const content = `Today is ${record.asOf}.

IDENTITY CHECK (document vs each source):
${JSON.stringify(record.identity)}

UPLOADED DOCUMENT SUMMARY:
${document ? `${document.documentType}: ${document.summary}\nDiagnoses listed: ${document.diagnoses.join("; ") || "none"}\nMedications listed: ${document.medications.join("; ") || "none"}` : "No document uploaded."}

LAB AND VITAL TRENDS (computed):
${trends || "none"}

MEDICATION SUPPLY FROM PHARMACY CLAIMS (computed):
${meds || "No pharmacy claims."}

CLINICAL FACTS (date | source | type | item | value | flag | reference):
${clinical || "none"}`;

  return structured({ system: REC_SYSTEM, content: [{ type: "text", text: content }], schema: RecommendationsSchema, effort: "high" });
}
