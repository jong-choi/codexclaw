import { OPENAI_API_BASE_URL } from "./constants.mjs";

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

function buildOpenAIApiUrl(baseUrl, endpointPath) {
  const normalizedBase = normalizeOpenAIBaseUrl(baseUrl);
  const endpoint = trim(endpointPath).replace(/^\/+/, "");
  if (!endpoint) {
    return normalizedBase;
  }
  return new URL(endpoint, `${normalizedBase}/`).toString();
}

export function normalizeOpenAIBaseUrl(value, fallback = OPENAI_API_BASE_URL) {
  const raw = trim(value) || trim(fallback) || OPENAI_API_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(
      `Invalid OpenAI-compatible base URL: ${raw}. Use https://api.openai.com/v1 or another reachable HTTP(S) URL.`,
    );
  }

  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname || pathname === "/") {
    pathname = "/v1";
  }
  if (pathname.toLowerCase().endsWith("/models")) {
    pathname = pathname.slice(0, -"/models".length) || "/v1";
  }
  if (!pathname.toLowerCase().endsWith("/v1")) {
    pathname = `${pathname}/v1`.replace(/\/{2,}/g, "/");
  }
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateOpenAIBaseUrl(value) {
  try {
    normalizeOpenAIBaseUrl(value);
    return undefined;
  } catch (error) {
    return trim(error?.message) || "Invalid OpenAI-compatible base URL.";
  }
}

export function validateOpenAIApiKey(value) {
  const apiKey = trim(value);
  if (!apiKey) {
    return "API key is required.";
  }
  if (/\s/.test(apiKey)) {
    return "API key must not include spaces.";
  }
  return undefined;
}

export function resolveOpenAIBaseUrlFromConfig(config) {
  try {
    return normalizeOpenAIBaseUrl(config?.codex?.providers?.["openai-api"]?.baseUrl);
  } catch {
    return normalizeOpenAIBaseUrl(OPENAI_API_BASE_URL);
  }
}

export function buildOpenAISetupHintLines() {
  return [
    "OpenAI-compatible base URL default: https://api.openai.com/v1",
    "Use a custom URL if you run an OpenAI-compatible proxy/gateway.",
    "Model list is fetched dynamically from /models.",
  ];
}

export async function listOpenAIModels(params = {}) {
  const baseUrl = normalizeOpenAIBaseUrl(params?.baseUrl);
  const apiKey = trim(params?.apiKey);
  if (!apiKey) {
    throw new Error("OpenAI API key is required.");
  }

  const timeoutMs = Number.isFinite(Number(params?.timeoutMs))
    ? Math.max(500, Math.floor(Number(params.timeoutMs)))
    : 8_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildOpenAIApiUrl(baseUrl, "/models"), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(
      `Failed to reach OpenAI-compatible endpoint at ${baseUrl}: ${trim(error?.message) || String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to list models (${formatHttpErrorContext(response.status, text)})`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("/models returned non-JSON response.");
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
