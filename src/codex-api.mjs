import { completeSimple, getModel } from "@mariozechner/pi-ai";
import {
  CODEX_API_BASE_URL,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
} from "./constants.mjs";

const DEFAULT_CODEX_INSTRUCTIONS =
  "You are CodexClaw. Answer clearly and helpfully in the user's language.";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;

function trim(value) {
  return String(value ?? "").trim();
}

function normalizeCodexModelId(value) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }
  return LEGACY_CODEX_MODEL_ID_ALIASES[raw] ?? raw;
}

function buildFallbackCodexModel(modelId) {
  return {
    id: modelId,
    name: modelId,
    api: "openai-codex-responses",
    provider: CODEX_PROVIDER_ID,
    baseUrl: CODEX_API_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function resolveCodexModel(modelId) {
  const normalizedId = normalizeCodexModelId(modelId);
  const registered = getModel(CODEX_PROVIDER_ID, normalizedId);
  if (registered) {
    return registered;
  }
  return buildFallbackCodexModel(normalizedId);
}

function collectTextFromAssistantMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  const chunks = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && trim(block.text)) {
        chunks.push(trim(block.text));
      }
    }
  }

  return chunks.join("\n\n").trim();
}

function collectTextFromLegacyPayload(payload) {
  const chunks = [];

  if (Array.isArray(payload.output)) {
    for (const item of payload.output) {
      if (!item || typeof item !== "object") {
        continue;
      }
      if (typeof item.text === "string" && trim(item.text)) {
        chunks.push(trim(item.text));
      }
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (!block || typeof block !== "object") {
            continue;
          }
          if (typeof block.text === "string" && trim(block.text)) {
            chunks.push(trim(block.text));
          }
          if (typeof block.output_text === "string" && trim(block.output_text)) {
            chunks.push(trim(block.output_text));
          }
        }
      }
    }
  }

  if (Array.isArray(payload.choices)) {
    for (const choice of payload.choices) {
      const message = choice?.message;
      if (typeof message?.content === "string" && trim(message.content)) {
        chunks.push(trim(message.content));
      }
    }
  }

  return chunks.join("\n\n").trim();
}

export function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  const textFromAssistant = collectTextFromAssistantMessage(payload);
  if (textFromAssistant) {
    return textFromAssistant;
  }

  if (typeof payload.output_text === "string" && trim(payload.output_text)) {
    return trim(payload.output_text);
  }

  return collectTextFromLegacyPayload(payload);
}

export async function requestCodexResponse(params) {
  const accessToken = trim(params?.accessToken);
  const modelId = normalizeCodexModelId(params?.modelId);
  const message = trim(params?.message);
  const instructions = trim(params?.instructions) || DEFAULT_CODEX_INSTRUCTIONS;

  if (!accessToken) {
    throw new Error("Missing access token.");
  }
  if (!modelId) {
    throw new Error("Missing model id.");
  }
  if (!message) {
    throw new Error("Message is empty.");
  }

  const model = resolveCodexModel(modelId);
  let response;
  try {
    response = await completeSimple(
      model,
      {
        systemPrompt: instructions,
        messages: [
          {
            role: "user",
            content: message,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: accessToken,
      },
    );
  } catch (error) {
    throw new Error(`Codex API error: ${trim(error?.message) || String(error)}`);
  }

  if (!response || typeof response !== "object") {
    throw new Error("Codex API returned an invalid response.");
  }

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Codex API error: ${trim(response.errorMessage) || "request failed"}`);
  }

  const text = extractResponseText(response);
  if (!text) {
    throw new Error("Codex API returned no text output.");
  }

  return {
    text,
    payload: response,
  };
}
