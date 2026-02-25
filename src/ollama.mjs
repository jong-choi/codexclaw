import { OLLAMA_API_BASE_URL } from "./constants.mjs";

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

export function normalizeOllamaBaseUrl(value, fallback = OLLAMA_API_BASE_URL) {
  const raw = trim(value) || trim(fallback) || OLLAMA_API_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(
      `Invalid Ollama base URL: ${raw}. Use http://ollama:11434 or another reachable HTTP(S) URL.`,
    );
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = normalizedPath.toLowerCase() === "/v1" ? "/" : `${normalizedPath || "/"}`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateOllamaBaseUrl(value) {
  try {
    normalizeOllamaBaseUrl(value);
    return undefined;
  } catch (error) {
    return trim(error?.message) || "Invalid Ollama base URL.";
  }
}

export function resolveOllamaBaseUrlFromConfig(config) {
  try {
    return normalizeOllamaBaseUrl(config?.codex?.providers?.ollama?.baseUrl);
  } catch {
    return normalizeOllamaBaseUrl(OLLAMA_API_BASE_URL);
  }
}

export function buildOllamaEndpointHintLines() {
  return [
    "When CodexClaw and Ollama run in the same Docker network: http://ollama:11434",
    "When Ollama runs on the host machine: http://127.0.0.1:11434 (or host.docker.internal from container)",
    "When Ollama runs on another server: use a reachable http(s)://host:port address",
  ];
}

function buildOllamaApiUrl(baseUrl, endpointPath) {
  const normalizedBase = normalizeOllamaBaseUrl(baseUrl);
  const endpoint = trim(endpointPath).replace(/^\/+/, "");
  if (!endpoint) {
    return normalizedBase;
  }
  return new URL(endpoint, `${normalizedBase}/`).toString();
}

export async function listOllamaModels(params = {}) {
  const baseUrl = normalizeOllamaBaseUrl(params?.baseUrl);
  const timeoutMs = Number.isFinite(Number(params?.timeoutMs))
    ? Math.max(500, Math.floor(Number(params.timeoutMs)))
    : 6_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildOllamaApiUrl(baseUrl, "/api/tags"), {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`Failed to reach Ollama at ${baseUrl}: ${trim(error?.message) || String(error)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to list Ollama models (${formatHttpErrorContext(response.status, text)})`,
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Ollama /api/tags returned non-JSON response.");
  }

  const items = Array.isArray(payload?.models) ? payload.models : [];
  const names = Array.from(
    new Set(
      items
        .map((entry) => trim(entry?.name))
        .filter(Boolean),
    ),
  );
  return names.toSorted((a, b) => a.localeCompare(b));
}

function normalizeStreamPayload(payload, fallbackLine) {
  const status = trim(payload?.status) || trim(fallbackLine);
  const completed = Number(payload?.completed);
  const total = Number(payload?.total);
  return {
    status,
    completed: Number.isFinite(completed) ? completed : undefined,
    total: Number.isFinite(total) ? total : undefined,
    digest: trim(payload?.digest),
    done: Boolean(payload?.done),
  };
}

export async function pullOllamaModel(params = {}) {
  const model = trim(params?.model);
  if (!model) {
    throw new Error("Ollama model name is required.");
  }
  const baseUrl = normalizeOllamaBaseUrl(params?.baseUrl);
  const onProgress = typeof params?.onProgress === "function" ? params.onProgress : null;

  const response = await fetch(buildOllamaApiUrl(baseUrl, "/api/pull"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson, application/json",
    },
    body: JSON.stringify({
      name: model,
      stream: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to pull model ${model} (${formatHttpErrorContext(response.status, text)})`,
    );
  }

  if (!response.body) {
    const completed = { status: "pull completed", done: true };
    onProgress?.(completed);
    return completed;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPayload = { status: "pull completed", done: true };

  const flushLine = (line) => {
    const trimmedLine = trim(line);
    if (!trimmedLine) {
      return;
    }
    let event;
    try {
      const parsed = JSON.parse(trimmedLine);
      event = normalizeStreamPayload(parsed, trimmedLine);
    } catch {
      event = normalizeStreamPayload({}, trimmedLine);
    }
    lastPayload = event;
    onProgress?.(event);
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      flushLine(line);
    }
  }

  flushLine(buffer);
  return lastPayload;
}

export async function deleteOllamaModel(params = {}) {
  const model = trim(params?.model);
  if (!model) {
    throw new Error("Ollama model name is required.");
  }
  const baseUrl = normalizeOllamaBaseUrl(params?.baseUrl);

  const response = await fetch(buildOllamaApiUrl(baseUrl, "/api/delete"), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      name: model,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to delete model ${model} (${formatHttpErrorContext(response.status, text)})`,
    );
  }
}
