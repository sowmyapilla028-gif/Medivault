# Medivault

Medivault combines three sources into one view of a patient and asks an AI model for holistic recommendations:

1. **Upload**: the patient uploads a lab report or visit summary (PDF, photo or text). The AI model reads it into structured results.
2. **Review**: the patient signs in to
   - **An EHR** over SMART on FHIR R4 (the free SMART Health IT sandbox by default, or Epic): Patient, Condition, Observation (labs and vitals), AllergyIntolerance, Immunization
   - **CMS Blue Button 2.0** (Insurer A): Patient and Part D pharmacy fills (`ExplanationOfBenefit?type=pde`)
3. **Recommendations**: the server computes lab trends and refill gaps from the combined record, then the AI model writes prioritized recommendations, each citing the source and value it came from.

No demo data is built in. Everything shown comes from the uploaded file and the live sandbox APIs.

## Step 4: the follow-up agent

After the recommendations, a care agent checks whether a specialist visit is needed. It acts **only when the newly uploaded results, read with the patient's history, cross a referral rule**. Otherwise it reports "no follow-up needed" and does nothing else.

| Specialty | Trigger (from the uploaded document) | Book within |
|---|---|---|
| Endocrinology | A1c 10%+ | 3-14 days |
| | A1c 9%+ | 7-21 days |
| | A1c 8%+ and up 0.3+ from history, or 7.5%+ rising with a lapsed diabetes medicine | 14-28 days |
| Nephrology | eGFR under 30 / eGFR under 45 and down 10+ / urine albumin 300+ | 7-45 days |
| Cardiology (lipids) | LDL 190+ | 21-45 days |

These thresholds are demo rules in `src/agent/triage.js`, not clinical guidance.

When triggered, the agent streams each step to the page:
1. Alerts the patient with the specialty, the time window and the evidence (upload, EHR, pharmacy).
2. Checks the patient's calendar (a sample calendar in the demo) for that window.
3. Finds open specialist slots (simulated clinics, in FHIR `Slot` shape) that avoid busy times with a 45-minute travel buffer.
4. **Stops for approval.** Nothing is booked or sent until the patient picks a time.
5. Calls the clinic (simulated, with a live transcript; the agent identifies itself as an AI acting for the patient).
6. Creates the appointment (FHIR `Appointment`) and an `.ics` calendar invite.
7. Emails the patient (why, when, what to bring, questions) and the specialist's office (pre-visit summary with cited evidence and questions). Emails appear in the in-app outbox.

Endpoints: `GET /api/agent/triage`, `GET /api/agent/run` (Server-Sent Events), `GET /api/agent/book?slot=…` (SSE), `GET /api/agent/appointment.ics`. Set `PATIENT_EMAIL` to show a real address on the patient email.

## How it works

```
browser ──upload──▶ /api/document ──PDF/image──▶ AI model (JSON) ──▶ results
browser ──connect─▶ /auth/{epic|cms}/start ──OAuth 2 + PKCE──▶ provider sign-in ──▶ /auth/{source}/callback
                                                     server fetches FHIR with the access token
browser ──────────▶ /api/recommendations: record + computed trends/refill gaps ──▶ AI model ──▶ recommendations
```

- Access tokens stay on the server (in the session); the browser only gets a session cookie.
- Epic endpoints are found with SMART discovery (`/.well-known/smart-configuration`); Epic gets the required `aud` parameter.
- CMS is a confidential client (client secret sent with HTTP Basic). Epic can be public (PKCE only) or confidential.
- The AI model is pluggable: any OpenAI-compatible Chat Completions API (OpenCode Zen, OpenRouter, Groq, a local Ollama) or Claude. Replies are validated against a schema and re-asked if they don't fit.
- PDFs are read to text on the server, so models without PDF support work. Photos need a vision model.

| Path | What it does |
|---|---|
| `src/server.js` | Express routes, sessions, upload handling |
| `src/oauth.js` | Authorization-code flow with PKCE, token exchange and refresh |
| `src/fhir.js` | FHIR read/search with Bundle paging |
| `src/sources/epic.js`, `src/sources/cms.js` | Fetch and normalize each source |
| `src/analysis.js` | Lab trends, medication supply and refill gaps, identity check |
| `src/llm.js` | AI model calls: document extraction and recommendations |
| `public/index.html` | The three-step UI |
| `test/` | Tests that run the full flow against local mock servers |

## Quick demo (no keys needed)

```bash
npm install
npm start
```

Open http://localhost:3000 for the landing page, then click **Try the demo** and **Or run the whole demo with sample data** (the app itself is at http://localhost:3000/app). With no AI model configured, Medivault reads documents with a built-in parser and writes recommendations with built-in rules, and the **Use demo data** buttons load a fictional patient's EHR record and pharmacy claims without signing in. Uploading your own text-based PDF also works in this mode.

## Setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

### 1. AI model (OpenCode Zen or any OpenAI-compatible API)
1. Get an API key: sign in at https://opencode.ai, open Zen, add billing/credits, and create an API key. Put it in `LLM_API_KEY`.
2. List the models your key can use:
   ```bash
   curl https://opencode.ai/zen/v1/models -H "Authorization: Bearer YOUR_KEY"
   ```
   (In Windows PowerShell type `curl.exe` instead of `curl`.)
3. Pick a model that is served through `/chat/completions` (OpenCode's docs list which endpoint each model uses; GPT and Claude models on Zen use other endpoints) and put its ID in `LLM_MODEL`.
4. If that model can read images, set `LLM_VISION=true` so photo uploads work.

Other providers work the same way: set `LLM_BASE_URL` to their OpenAI-compatible base URL (for example `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama, which needs no key). To use Claude instead, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`.

### 2. EHR: nothing to do
With no EHR settings, Medivault uses the public **SMART Health IT sandbox** (https://launch.smarthealthit.org). It needs no registration and has synthetic patients. When you click Connect, it shows a demo login and a patient picker: pick any patient.

To use Epic later, register an app at https://fhir.epic.com (audience: Patients; redirect URI `http://localhost:3000/auth/epic/callback`; APIs: Patient.Read, Condition.Search (Problems), Observation.Search (Labs and Vitals), AllergyIntolerance.Search, Immunization.Search) and set `EPIC_CLIENT_ID`.

### 3. CMS Blue Button sandbox app
1. Sign up at https://sandbox.bluebutton.cms.gov and create an application.
2. Client type: **Confidential**, grant type: **Authorization code**.
3. Callback URL: `http://localhost:3000/auth/cms/callback`.
4. Copy the client ID and secret into `CMS_CLIENT_ID` and `CMS_CLIENT_SECRET`.
5. Sign in with a synthetic Medicare beneficiary (`BBUser#####` accounts, listed in the Blue Button docs).

### Run

```bash
npm start
```

Open http://localhost:3000. The server prints the exact redirect URIs it uses and warns about anything not configured.

### Test

```bash
npm test
```

The tests start local stand-ins for the EHR, CMS, Claude and an OpenAI-compatible API, and run the whole journey: upload, both OAuth flows (including PKCE and state checks), FHIR paging, refill-gap math and the recommendation request.

## Things to know

- **The sandboxes hold different people.** The EHR test patient, the Blue Button beneficiary and the person on your PDF are not the same person. Medivault compares name and date of birth, shows a warning on the Review page, and the AI model lists the mismatch under "Before you read these". A production build would link accounts to one verified user.
- **Sessions are in memory.** Restarting the server signs everyone out. Use a persistent session store (for example Redis) before deploying.
- **Not medical advice.** Recommendations are decision support for a demo.
- Uploaded files (or their text) are sent to your AI provider and not stored on disk.
