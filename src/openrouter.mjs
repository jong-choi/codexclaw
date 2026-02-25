import { OPENROUTER_API_BASE_URL, OPENROUTER_API_ENV_NAME } from "./constants.mjs";

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

function parseNumberString(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const raw = trim(value);
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function parseOpenRouterPricing(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const prompt = parseNumberString(value.prompt);
  const completion = parseNumberString(value.completion);
  if (prompt === null || completion === null) {
    return null;
  }
  return { prompt, completion };
}

function isFreeOpenRouterModel(id, pricing) {
  if (id.toLowerCase().endsWith(":free")) {
    return true;
  }
  return Boolean(pricing && pricing.prompt === 0 && pricing.completion === 0);
}

function buildOpenRouterApiUrl(baseUrl, endpointPath) {
  const normalizedBase = normalizeOpenRouterBaseUrl(baseUrl);
  const endpoint = trim(endpointPath).replace(/^\/+/, "");
  if (!endpoint) {
    return normalizedBase;
  }
  return new URL(endpoint, `${normalizedBase}/`).toString();
}

export function normalizeOpenRouterBaseUrl(value, fallback = OPENROUTER_API_BASE_URL) {
  const raw = trim(value) || trim(fallback) || OPENROUTER_API_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(
      `Invalid OpenRouter base URL: ${raw}. Use https://openrouter.ai/api/v1 or another reachable HTTP(S) URL.`,
    );
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") {
    pathname = "/api/v1";
  }
  if (pathname.toLowerCase().endsWith("/models")) {
    pathname = pathname.slice(0, -"/models".length) || "/api/v1";
  }
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateOpenRouterBaseUrl(value) {
  try {
    normalizeOpenRouterBaseUrl(value);
    return undefined;
  } catch (error) {
    return trim(error?.message) || "Invalid OpenRouter base URL.";
  }
}

export function validateOpenRouterApiKey(value) {
  const apiKey = trim(value);
  if (!apiKey) {
    return "OpenRouter API key is required.";
  }
  if (/\s/.test(apiKey)) {
    return "OpenRouter API key must not include spaces.";
  }
  return undefined;
}

export function resolveOpenRouterBaseUrlFromConfig(config) {
  try {
    return normalizeOpenRouterBaseUrl(config?.codex?.providers?.openrouter?.baseUrl);
  } catch {
    return normalizeOpenRouterBaseUrl(OPENROUTER_API_BASE_URL);
  }
}

export function buildOpenRouterSetupHintLines() {
  return [
    "OpenRouter base URL default: https://openrouter.ai/api/v1",
    "Use a custom URL only if you run an OpenRouter-compatible proxy.",
    "Free models are detected dynamically from /models (:free or zero prompt/completion pricing).",
  ];
}

export async function listOpenRouterFreeModels(params = {}) {
  const baseUrl = normalizeOpenRouterBaseUrl(params?.baseUrl);
  const apiKey = trim(params?.apiKey) || trim(process.env[OPENROUTER_API_ENV_NAME]);
  const timeoutMs = Number.isFinite(Number(params?.timeoutMs))
    ? Math.max(500, Math.floor(Number(params.timeoutMs)))
    : 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    const headers = { Accept: "application/json" };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    response = await fetch(buildOpenRouterApiUrl(baseUrl, "/models"), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `Failed to reach OpenRouter at ${baseUrl}: ${trim(error?.message) || String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to list OpenRouter models (${formatHttpErrorContext(response.status, text)})`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("OpenRouter /models returned non-JSON response.");
  }

  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const ids = Array.from(
    new Set(
      entries
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const id = trim(entry.id);
          if (!id) {
            return "";
          }
          const pricing = parseOpenRouterPricing(entry.pricing);
          return isFreeOpenRouterModel(id, pricing) ? id : "";
        })
        .filter(Boolean),
    ),
  );
  return ids.toSorted((a, b) => a.localeCompare(b));
}
