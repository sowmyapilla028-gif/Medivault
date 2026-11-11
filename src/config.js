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
  llm: {
    // "openai" = any OpenAI-compatible Chat Completions API (OpenCode Zen, OpenRouter, Groq, Ollama...).
    // "anthropic" = Claude via the Anthropic SDK.
    provider: env("LLM_PROVIDER", env("ANTHROPIC_API_KEY") ? "anthropic" : "openai"),
    baseUrl: env("LLM_BASE_URL", "https://opencode.ai/zen/v1").replace(/\/$/, ""),
    apiKey: env("LLM_API_KEY", env("OPENCODE_API_KEY")),
    model: env("LLM_MODEL"),
    // Set to true if LLM_MODEL accepts images (needed for photo uploads and scanned PDFs).
    vision: env("LLM_VISION", "false") === "true",
  },
  anthropic: {
    model: env("CLAUDE_MODEL", "claude-opus-5-5"),
  },
  sources: {
    // The EHR connection. Any SMART on FHIR R4 server works. With nothing configured it uses the
    // public SMART Health IT sandbox, which needs no registration (any client ID is accepted).
    epic: (() => {
      const usingEpic = Boolean(env("EPIC_CLIENT_ID")) && !env("EHR_FHIR_BASE");
      const base = env("EHR_FHIR_BASE", env("EPIC_FHIR_BASE", usingEpic
        ? "https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4"
        : "https://launch.smarthealthit.org/v/r4/fhir")).replace(/\/$/, "");
      const isSmartSandbox = base.includes("launch.smarthealthit.org");
      return {
        id: "epic",
        label: env("EHR_LABEL", usingEpic ? "Epic" : isSmartSandbox ? "SMART Health IT" : "EHR"),
        clientId: env("EHR_CLIENT_ID", env("EPIC_CLIENT_ID", isSmartSandbox ? "medivault-demo" : undefined)),
        clientSecret: env("EHR_CLIENT_SECRET", env("EPIC_CLIENT_SECRET")),
        fhirBase: base,
        authorizeUrl: env("EHR_AUTHORIZE_URL", env("EPIC_AUTHORIZE_URL")),
        tokenUrl: env("EHR_TOKEN_URL", env("EPIC_TOKEN_URL")),
        scope: env("EHR_SCOPES", env("EPIC_SCOPES",
          "openid fhirUser launch/patient patient/Patient.read patient/Condition.read patient/Observation.read patient/AllergyIntolerance.read patient/Immunization.read")),
        // Epic only returns problem-list Conditions when asked by category; other servers (Synthea data) may not tag them.
        conditionCategory: env("EHR_CONDITION_CATEGORY", usingEpic ? "problem-list-item" : ""),
        // SMART on FHIR requires `aud` = the FHIR base URL.
        sendAud: true,
        redirectUri: `${appUrl}/auth/epic/callback`,
      };
    })(),
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
export const llmConfigured = () =>
  config.llm.provider === "anthropic" ? hasAnthropicCredentials() : Boolean(config.llm.apiKey && config.llm.model) ||
    Boolean(config.llm.model && /localhost|127\.0\.0\.1/.test(config.llm.baseUrl));
export const llmLabel = () => (config.llm.provider === "anthropic" ? `Claude (${config.anthropic.model})` : config.llm.model || "LLM");
