import { fileURLToPath } from "node:url";
import { Type, completeSimple, getModel } from "@mariozechner/pi-ai";
import {
  CODEX_API_BASE_URL,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
  NOTION_API_BASE_URL,
  NOTION_API_ENV_NAME,
  NOTION_API_VERSION,
  NOTION_SKILL_KEY,
} from "./constants.mjs";

const DEFAULT_CODEX_INSTRUCTIONS =
  "You are CodexClaw. Answer clearly and helpfully in the user's language.";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 16_000;
const NOTION_TOOL_NAME = "notion_api_request";
const NOTION_TOOL = {
  name: NOTION_TOOL_NAME,
  description:
    "Call the Notion REST API. Use this when the user asks to read/write/update Notion pages or databases.",
  parameters: Type.Object({
    method: Type.Union([
      Type.Literal("GET"),
      Type.Literal("POST"),
      Type.Literal("PATCH"),
      Type.Literal("DELETE"),
    ]),
    path: Type.String({
      minLength: 1,
      description: "Notion API path. Example: /v1/search or /v1/pages/{page_id}",
    }),
    body: Type.Optional(Type.Any()),
  }),
};

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

function resolveNotionApiKey(skills) {
  return trim(skills?.entries?.[NOTION_SKILL_KEY]?.apiKey);
}

function resolveNotionSkillPath() {
  return fileURLToPath(new URL(`./skills/${NOTION_SKILL_KEY}/SKILL.md`, import.meta.url));
}

function buildSkillsPrompt({ notionEnabled }) {
  if (!notionEnabled) {
    return "";
  }
  const skillPath = resolveNotionSkillPath();
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> and apply the matching skill instructions.",
    "<available_skills>",
    "  <skill>",
    `    <name>${NOTION_SKILL_KEY}</name>`,
    "    <description>Notion API for creating and managing pages, databases, and blocks.</description>",
    `    <location>${skillPath}</location>`,
    "  </skill>",
    "</available_skills>",
    `For Notion operations, use tool \`${NOTION_TOOL_NAME}\` instead of guessing API payloads.`,
    `Authentication is already configured via ${NOTION_API_ENV_NAME}; never ask the user to reveal it.`,
  ].join("\n");
}

function buildSystemPrompt({ instructions, notionEnabled }) {
  const skillsPrompt = buildSkillsPrompt({ notionEnabled });
  return [instructions, skillsPrompt].filter(Boolean).join("\n\n");
}

function collectToolCalls(message, toolName) {
  if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter(
    (block) => block && typeof block === "object" && block.type === "toolCall" && block.name === toolName,
  );
}

function normalizeConversationMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const out = [];
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const role = trim(raw.role).toLowerCase();
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const content = trim(raw.content);
    if (!content) {
      continue;
    }
    const timestampRaw = Number(raw.timestamp);
    const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0 ? timestampRaw : Date.now();
    out.push({
      role,
      content,
      timestamp,
    });
  }
  return out;
}

function normalizeNotionMethod(value) {
  const upper = trim(value).toUpperCase();
  if (["GET", "POST", "PATCH", "DELETE"].includes(upper)) {
    return upper;
  }
  return "";
}

function normalizeNotionPath(value) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }

  let normalized = raw;
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    try {
      const url = new URL(raw);
      if (url.origin !== NOTION_API_BASE_URL) {
        return "";
      }
      normalized = `${url.pathname}${url.search}`;
    } catch {
      return "";
    }
  }

  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (!(normalized === "/v1" || normalized.startsWith("/v1/"))) {
    return "";
  }
  return normalized;
}

function buildToolResultText(payload) {
  const serialized =
    typeof payload === "string" ? payload : JSON.stringify(payload ?? {}, null, 2);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}

async function parseNotionResponseBody(response) {
  const raw = await response.text();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function buildToolResultMessage(toolCall, result) {
  return {
    role: "toolResult",
    toolCallId: trim(toolCall?.id) || `tool-${Date.now()}`,
    toolName: trim(toolCall?.name) || NOTION_TOOL_NAME,
    content: [
      {
        type: "text",
        text: buildToolResultText(result),
      },
    ],
    isError: !result?.ok,
    timestamp: Date.now(),
  };
}

async function emitToolEvent(handler, event) {
  if (typeof handler !== "function") {
    return;
  }
  try {
    await handler(event);
  } catch {}
}

async function executeNotionToolCall(params) {
  const method = normalizeNotionMethod(params?.method);
  const path = normalizeNotionPath(params?.path);
  const apiKey = trim(params?.apiKey);

  if (!apiKey) {
    return {
      ok: false,
      error: "Notion API key is not configured.",
    };
  }
  if (!method) {
    return {
      ok: false,
      error: "Invalid method. Use GET, POST, PATCH, or DELETE.",
    };
  }
  if (!path) {
    return {
      ok: false,
      error: "Invalid path. Use a /v1/... Notion API path.",
    };
  }

  const request = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
  };

  if (method !== "GET" && params?.body !== undefined) {
    request.body = JSON.stringify(params.body);
  }

  try {
    const response = await fetch(`${NOTION_API_BASE_URL}${path}`, request);
    const body = await parseNotionResponseBody(response);
    return {
      ok: response.ok,
      status: response.status,
      path,
      method,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      path,
      method,
      error: trim(error?.message) || String(error),
    };
  }
}

function validateAssistantResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("Codex API returned an invalid response.");
  }
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Codex API error: ${trim(response.errorMessage) || "request failed"}`);
  }
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
  const notionApiKey = resolveNotionApiKey(params?.skills);
  const notionEnabled = Boolean(notionApiKey);
  const history = normalizeConversationMessages(params?.messages);

  if (!accessToken) {
    throw new Error("Missing access token.");
  }
  if (!modelId) {
    throw new Error("Missing model id.");
  }
  if (!message && history.length === 0) {
    throw new Error("Message is empty.");
  }

  const model = resolveCodexModel(modelId);
  const systemPrompt = buildSystemPrompt({ instructions, notionEnabled });
  const messages =
    history.length > 0
      ? history.map((entry) => ({ ...entry }))
      : [
          {
            role: "user",
            content: message,
            timestamp: Date.now(),
          },
        ];

  let response = null;
  const toolEvents = [];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    try {
      response = await completeSimple(
        model,
        {
          systemPrompt,
          messages,
          tools: notionEnabled ? [NOTION_TOOL] : undefined,
        },
        {
          apiKey: accessToken,
        },
      );
    } catch (error) {
      throw new Error(`Codex API error: ${trim(error?.message) || String(error)}`);
    }

    validateAssistantResponse(response);

    if (!notionEnabled) {
      break;
    }

    const notionCalls = collectToolCalls(response, NOTION_TOOL_NAME);
    if (notionCalls.length === 0) {
      break;
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      throw new Error("Notion tool call limit reached.");
    }

    messages.push(response);

    for (let i = 0; i < notionCalls.length; i += 1) {
      const toolCall = notionCalls[i];
      const rawArgs =
        toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : {};
      const toolCallId = trim(toolCall?.id) || `tool-${Date.now()}-${i + 1}`;
      const method = normalizeNotionMethod(rawArgs.method) || trim(rawArgs.method).toUpperCase();
      const path = normalizeNotionPath(rawArgs.path) || trim(rawArgs.path);
      await emitToolEvent(params?.onToolEvent, {
        phase: "start",
        toolName: NOTION_TOOL_NAME,
        toolCallId,
        method,
        path,
        round: round + 1,
        index: i + 1,
        total: notionCalls.length,
      });

      const startedAt = Date.now();
      const result = await executeNotionToolCall({
        ...rawArgs,
        apiKey: notionApiKey,
      });
      const event = {
        phase: "result",
        toolName: NOTION_TOOL_NAME,
        toolCallId,
        method,
        path,
        round: round + 1,
        index: i + 1,
        total: notionCalls.length,
        ok: Boolean(result?.ok),
        status: Number.isFinite(Number(result?.status)) ? Number(result.status) : undefined,
        error: trim(result?.error),
        durationMs: Date.now() - startedAt,
      };
      toolEvents.push(event);
      await emitToolEvent(params?.onToolEvent, event);
      messages.push(buildToolResultMessage(toolCall, result));
    }
  }

  if (!response) {
    throw new Error("Codex API returned no response.");
  }

  const text = extractResponseText(response);
  if (!text) {
    throw new Error("Codex API returned no text output.");
  }

  return {
    text,
    payload: response,
    toolEvents,
  };
}
