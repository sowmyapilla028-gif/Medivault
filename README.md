# Medivault

Medivault combines three sources into one view of a patient and asks Claude for holistic recommendations:

1. **Upload**: the patient uploads a lab report or visit summary (PDF, photo or text). Claude reads it into structured results.
2. **Review**: the patient signs in to
   - **Epic** (SMART on FHIR R4): Patient, Condition (problem list), Observation (labs and vitals), AllergyIntolerance, Immunization
   - **CMS Blue Button 2.0** (Insurer A): Patient and Part D pharmacy fills (`ExplanationOfBenefit?type=pde`)
3. **Recommendations**: the server computes lab trends and refill gaps from the combined record, then Claude writes prioritized recommendations, each citing the source and value it came from.

No demo data is built in. Everything shown comes from the uploaded file and the live sandbox APIs.

## How it works

```
browser ──upload──▶ /api/document ──PDF/image──▶ Claude (structured output) ──▶ results
browser ──connect─▶ /auth/{epic|cms}/start ──OAuth 2 + PKCE──▶ provider sign-in ──▶ /auth/{source}/callback
                                                     server fetches FHIR with the access token
browser ──────────▶ /api/recommendations: record + computed trends/refill gaps ──▶ Claude ──▶ recommendations
```

- Access tokens stay on the server (in the session); the browser only gets a session cookie.
- Epic endpoints are found with SMART discovery (`/.well-known/smart-configuration`); Epic gets the required `aud` parameter.
- CMS is a confidential client (client secret sent with HTTP Basic). Epic can be public (PKCE only) or confidential.
- Claude calls use the official Anthropic SDK with structured outputs, so the server always gets validated JSON.

| Path | What it does |
|---|---|
| `src/server.js` | Express routes, sessions, upload handling |
| `src/oauth.js` | Authorization-code flow with PKCE, token exchange and refresh |
| `src/fhir.js` | FHIR read/search with Bundle paging |
| `src/sources/epic.js`, `src/sources/cms.js` | Fetch and normalize each source |
| `src/analysis.js` | Lab trends, medication supply and refill gaps, identity check |
| `src/llm.js` | Claude: document extraction and recommendations |
| `public/index.html` | The three-step UI |
| `test/` | Tests that run the full flow against local mock servers |

## Setup

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Then fill in `.env`:

### 1. Anthropic API key
Create a key at https://platform.claude.com and set `ANTHROPIC_API_KEY`.

### 2. Epic sandbox app
1. Sign up at https://fhir.epic.com and choose **Build Apps → Create**.
2. Application audience: **Patients**.
3. Incoming APIs (R4): Patient.Read, Condition.Search (Problems), Observation.Search (Labs), Observation.Search (Vitals), AllergyIntolerance.Search, Immunization.Search.
4. Redirect URI: `http://localhost:3000/auth/epic/callback` (or `${APP_URL}/auth/epic/callback`).
5. Leave it as a public client (no secret) unless you need a confidential one, then save.
6. Copy the **Non-Production Client ID** into `EPIC_CLIENT_ID`. New client IDs can take a while to become active in the sandbox.
7. Sign in with one of Epic's sandbox test patients (MyChart usernames and passwords are on fhir.epic.com under the sandbox test data docs).

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

The tests start local stand-ins for Epic, CMS and the Claude API and run the whole journey: upload, both OAuth flows (including PKCE and state checks), FHIR paging, refill-gap math and the recommendation request.

## Things to know

- **The sandboxes hold different people.** The Epic test patient, the Blue Button beneficiary and the person on your PDF are not the same person. Medivault compares name and date of birth, shows a warning on the Review page, and Claude lists the mismatch under "Before you read these". A production build would link accounts to one verified user.
- **Sessions are in memory.** Restarting the server signs everyone out. Use a persistent session store (for example Redis) before deploying.
- **Not medical advice.** Recommendations are decision support for a demo.
- Uploaded files are sent to the Claude API and not stored on disk.
