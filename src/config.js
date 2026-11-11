import "dotenv/config";

const env = (name, fallback = undefined) => {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
};

const port = Number(env("PORT", 3000));
const appUrl = env("APP_URL", `http://localhost:${port}`).replace(/\/$/, "");

export const config = {
  port,
  appUrl,
  sessionSecret: env("SESSION_SECRET"),
  secureCookies: appUrl.startsWith("https://"),
  anthropic: {
    model: env("CLAUDE_MODEL", "claude-opus-5-5"),
  },
  sources: {
    epic: {
      id: "epic",
      label: "Epic",
      clientId: env("EPIC_CLIENT_ID"),
      clientSecret: env("EPIC_CLIENT_SECRET"),
      fhirBase: env("EPIC_FHIR_BASE", "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4").replace(/\/$/, ""),
      authorizeUrl: env("EPIC_AUTHORIZE_URL"),
      tokenUrl: env("EPIC_TOKEN_URL"),
      scope: env(
        "EPIC_SCOPES",
        "openid fhirUser launch/patient patient/Patient.read patient/Condition.read patient/Observation.read patient/AllergyIntolerance.read patient/Immunization.read"
      ),
      // SMART on FHIR requires `aud` = the FHIR base URL.
      sendAud: true,
      redirectUri: `${appUrl}/auth/epic/callback`,
    },
    cms: {
      id: "cms",
      label: "CMS Blue Button",
      clientId: env("CMS_CLIENT_ID"),
      clientSecret: env("CMS_CLIENT_SECRET"),
      fhirBase: env("CMS_FHIR_BASE", "https://sandbox.bluebutton.cms.gov/v2/fhir").replace(/\/$/, ""),
      authorizeUrl: env("CMS_AUTHORIZE_URL", "https://sandbox.bluebutton.cms.gov/v2/o/authorize/"),
      tokenUrl: env("CMS_TOKEN_URL", "https://sandbox.bluebutton.cms.gov/v2/o/token/"),
      scope: env("CMS_SCOPES", "openid profile patient/Patient.read patient/ExplanationOfBenefit.read"),
      sendAud: false,
      redirectUri: `${appUrl}/auth/cms/callback`,
    },
  },
};

export const isConfigured = (source) => Boolean(config.sources[source]?.clientId);
export const hasAnthropicCredentials = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
