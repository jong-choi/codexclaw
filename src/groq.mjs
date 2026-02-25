import { GROQ_API_BASE_URL, GROQ_API_ENV_NAME } from "./constants.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

function formatHttpErrorContext(status, text) {
  const detail = trim(text);
  if (!detail) {
    return `HTTP ${status}`;
  }
  const preview = detail.length > 280 ? `${detail.slice(0, 280)}...` : detail;
  return `HTTP ${status}: ${preview}`;
}

function buildGroqApiUrl(baseUrl, endpointPath) {
  const normalizedBase = normalizeGroqBaseUrl(baseUrl);
  const endpoint = trim(endpointPath).replace(/^\/+/, "");
  if (!endpoint) {
    return normalizedBase;
  }
  return new URL(endpoint, `${normalizedBase}/`).toString();
}

export function normalizeGroqBaseUrl(value, fallback = GROQ_API_BASE_URL) {
  const raw = trim(value) || trim(fallback) || GROQ_API_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(
      `Invalid Groq base URL: ${raw}. Use https://api.groq.com/openai/v1 or another reachable HTTP(S) URL.`,
    );
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") {
    pathname = "/openai/v1";
  }
  if (pathname.toLowerCase().endsWith("/models")) {
    pathname = pathname.slice(0, -"/models".length) || "/openai/v1";
  }
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateGroqBaseUrl(value) {
  try {
    normalizeGroqBaseUrl(value);
    return undefined;
  } catch (error) {
    return trim(error?.message) || "Invalid Groq base URL.";
  }
}

export function validateGroqApiKey(value) {
  const apiKey = trim(value);
  if (!apiKey) {
    return "Groq API key is required.";
  }
  if (/\s/.test(apiKey)) {
    return "Groq API key must not include spaces.";
  }
  return undefined;
}

export function resolveGroqBaseUrlFromConfig(config) {
  try {
    return normalizeGroqBaseUrl(config?.codex?.providers?.groq?.baseUrl);
  } catch {
    return normalizeGroqBaseUrl(GROQ_API_BASE_URL);
  }
}

export function buildGroqSetupHintLines() {
  return [
    "Groq base URL default: https://api.groq.com/openai/v1",
    "Use a custom URL only if you run a Groq-compatible proxy.",
    "Model list is fetched dynamically from /models.",
  ];
}

export async function listGroqModels(params = {}) {
  const baseUrl = normalizeGroqBaseUrl(params?.baseUrl);
  const apiKey = trim(params?.apiKey) || trim(process.env[GROQ_API_ENV_NAME]);
  if (!apiKey) {
    throw new Error("Groq API key is required.");
  }

  const timeoutMs = Number.isFinite(Number(params?.timeoutMs))
    ? Math.max(500, Math.floor(Number(params.timeoutMs)))
    : 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildGroqApiUrl(baseUrl, "/models"), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Failed to reach Groq at ${baseUrl}: ${trim(error?.message) || String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to list Groq models (${formatHttpErrorContext(response.status, text)})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Groq /models returned non-JSON response.");
  }

  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const ids = Array.from(
    new Set(
      entries
        .map((entry) => trim(entry?.id))
        .filter(Boolean),
    ),
  );
  return ids.toSorted((a, b) => a.localeCompare(b));
}
