# Medivault (Whole Chart demo)

A demo web app that combines three sources into one view of a patient and gives holistic care recommendations:

1. **Upload**: the patient uploads a lab report or visit summary (PDF, photo, .txt or FHIR .json).
2. **Review**: the app shows the values it read and connects:
   - **Epic EHR (FHIR R4)**: Patient, Condition, Observation (labs and vitals), AllergyIntolerance, Immunization
   - **CMS Blue Button 2.0 (Insurer A)**: Part D pharmacy fills (`ExplanationOfBenefit?type=pde`)
   - **Humana (Insurer B, optional)**: dental and vision claims
3. **Recommendations**: rule-based findings that cite the evidence from each source, plus an A1c trend chart and a medication-supply timeline.

All data is synthetic and shaped like each sandbox's responses. The "Connect" buttons simulate the SMART on FHIR / OAuth sign-in.

## Run locally

It's a single static page. Open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8000
```

Photo/PDF reading by Claude and the "Write my summary" button only work when the page is opened as a Claude artifact. Elsewhere the app falls back to its in-browser parser and the rule-based recommendations.

## Going live

| Source | Sandbox base URL | Register at |
|---|---|---|
| Epic | `https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4/` | fhir.epic.com |
| CMS Blue Button 2.0 | `https://sandbox.bluebutton.cms.gov/v2/fhir/` | bluebutton.cms.gov |
| Humana | `https://fhir.humana.com/sandbox/api/` | developers.humana.com |

Each sandbox holds different synthetic people, so a live build needs a backend that runs the OAuth flows and links the three accounts to one user.
