import fs from "node:fs/promises";
import path from "node:path";
import { Type, completeSimple, getModel } from "@mariozechner/pi-ai";
import {
  BRAVE_API_ENV_NAME,
  BRAVE_SEARCH_ENDPOINT,
  CODEX_API_BASE_URL,
  CODEX_PROVIDER_ID,
  NOTION_API_BASE_URL,
  NOTION_API_ENV_NAME,
  NOTION_API_VERSION,
  NOTION_SKILL_KEY,
  OLLAMA_API_BASE_URL,
  OLLAMA_PROVIDER_ID,
  QWEN_API_BASE_URL,
  QWEN_PROVIDER_ID,
  SCHEDULER_SKILL_KEY,
  TIME_CONTEXT_SKILL_KEY,
  WORKSPACE_FILES_SKILL_KEY,
  WORKSPACE_INSTRUCTIONS_FILE_NAME,
  WORKSPACE_MEMORY_FILE_NAME,
  WEB_FETCH_SKILL_KEY,
  WEB_SEARCH_SKILL_KEY,
} from "./constants.mjs";
import { normalizeProviderModelId, resolveProviderId } from "./model-provider.mjs";
import { normalizeOllamaBaseUrl } from "./ollama.mjs";
import {
  cancelScheduledJob,
  createScheduledJob,
  createRecurringScheduledJob,
  deleteRecurringScheduledJob,
  formatDateTimeInTimezone,
  isValidSchedulerTimezone,
  listRecurringScheduledJobs,
  listScheduledJobs,
  pauseRecurringScheduledJob,
  resolveSchedulerTimezone,
  resumeRecurringScheduledJob,
} from "./schedule-store.mjs";
import { getTelegramChatTimezone, setTelegramChatTimezone } from "./telegram-settings-store.mjs";
import { ensureWorkspaceInitialized, resolveWorkspaceRoot, resolveWorkspaceTemplateRoot } from "./workspace.mjs";

const DEFAULT_CODEX_INSTRUCTIONS =
  "You are an AI assistant. Answer clearly and helpfully in the user's language. Do not introduce yourself with product/project names unless the user explicitly asks.";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 16_000;
const REASONING_EFFORT_LEVELS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

const NOTION_TOOL_NAME = "notion_api_request";
const WEB_SEARCH_TOOL_NAME = "web_search";
const WEB_FETCH_TOOL_NAME = "web_fetch";
const WORKSPACE_READ_TOOL_NAME = "workspace_read_file";
const WORKSPACE_WRITE_TOOL_NAME = "workspace_write_file";
const WORKSPACE_DELETE_TOOL_NAME = "workspace_delete_path";
const SCHEDULE_CREATE_TOOL_NAME = "schedule_create";
const SCHEDULE_LIST_TOOL_NAME = "schedule_list";
const SCHEDULE_DELETE_TOOL_NAME = "schedule_delete";
const SCHEDULE_RECURRING_CREATE_TOOL_NAME = "schedule_recurring_create";
const SCHEDULE_RECURRING_LIST_TOOL_NAME = "schedule_recurring_list";
const SCHEDULE_RECURRING_DELETE_TOOL_NAME = "schedule_recurring_delete";
const SCHEDULE_RECURRING_PAUSE_TOOL_NAME = "schedule_recurring_pause";
const SCHEDULE_RECURRING_RESUME_TOOL_NAME = "schedule_recurring_resume";
const TIMEZONE_GET_TOOL_NAME = "timezone_get";
const TIMEZONE_SET_TOOL_NAME = "timezone_set";
const CURRENT_TIME_GET_TOOL_NAME = "current_time_get";

const WEB_SEARCH_DEFAULT_COUNT = 5;
const WEB_SEARCH_MAX_COUNT = 10;
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WEB_FETCH_DEFAULT_MAX_CHARS = 50_000;
const WEB_FETCH_MAX_CHARS_CAP = 50_000;
const WEB_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
const WEB_FETCH_DEFAULT_ERROR_DETAIL_CHARS = 4_000;
const WEB_FETCH_DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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

const WEB_SEARCH_TOOL = {
  name: WEB_SEARCH_TOOL_NAME,
  description:
    "Search the web with Brave Search API. Returns result snippets (title/url/description).",
  parameters: Type.Object({
    query: Type.String({ minLength: 1, description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: WEB_SEARCH_MAX_COUNT,
        description: "Number of results to return (1-10).",
      }),
    ),
    country: Type.Optional(
      Type.String({
        description: "2-letter country code for region-specific results (e.g., US, DE, ALL).",
      }),
    ),
    search_lang: Type.Optional(
      Type.String({ description: "ISO language code for search results (e.g., en, ko)." }),
    ),
    ui_lang: Type.Optional(
      Type.String({ description: "ISO language code for UI elements." }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Discovery time filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
      }),
    ),
  }),
};

const WEB_FETCH_TOOL = {
  name: WEB_FETCH_TOOL_NAME,
  description:
    "Fetch a URL and extract readable text content. Use this for lightweight page access without browser automation.",
  parameters: Type.Object({
    url: Type.String({ minLength: 1, description: "HTTP or HTTPS URL to fetch." }),
    extractMode: Type.Optional(
      Type.Union([Type.Literal("markdown"), Type.Literal("text")]),
    ),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 100,
        description: "Maximum characters to return (truncates when exceeded).",
      }),
    ),
  }),
};

const WORKSPACE_READ_TOOL = {
  name: WORKSPACE_READ_TOOL_NAME,
  description:
    "Read a UTF-8 text file from the CodexClaw workspace. Use this to inspect memory/instruction files.",
  parameters: Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Workspace-relative file path (for example MEMORY.md or notes/today.md).",
    }),
    maxChars: Type.Optional(
      Type.Number({
        minimum: 100,
        maximum: WEB_FETCH_MAX_CHARS_CAP,
        description: "Maximum characters to return.",
      }),
    ),
  }),
};

const WORKSPACE_WRITE_TOOL = {
  name: WORKSPACE_WRITE_TOOL_NAME,
  description:
    "Create or update a UTF-8 text file inside the CodexClaw workspace. Path is always workspace-relative.",
  parameters: Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Workspace-relative file path to create or update.",
    }),
    content: Type.String({
      description: "Text content to write.",
    }),
    mode: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("append")])),
  }),
};

const WORKSPACE_DELETE_TOOL = {
  name: WORKSPACE_DELETE_TOOL_NAME,
  description:
    "Delete a file or directory inside the CodexClaw workspace. Cannot delete outside workspace root.",
  parameters: Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Workspace-relative target path.",
    }),
    recursive: Type.Optional(
      Type.Boolean({
        description: "Set true to delete non-empty directories.",
      }),
    ),
  }),
};

const SCHEDULE_CREATE_TOOL = {
  name: SCHEDULE_CREATE_TOOL_NAME,
  description:
    "Create a one-time scheduled task for the current Telegram chat. The stored prompt will be sent back into Codex at run time, so write prompt as the exact future instruction.",
  parameters: Type.Object({
    prompt: Type.String({
      minLength: 1,
      description:
        "Future instruction to run when schedule fires (not the original scheduling sentence). Example: 'Tell the user to call their mom now.'",
    }),
    delaySeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Relative delay in seconds (use this for requests like 'in 3 minutes').",
      }),
    ),
    runAt: Type.Optional(
      Type.String({
        description:
          "Absolute schedule time. Use ISO 8601 with offset (recommended), or YYYY-MM-DDTHH:mm[:ss] with timezone.",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description:
          "IANA timezone for local runAt without offset, e.g. Asia/Seoul, Europe/London, America/New_York.",
      }),
    ),
  }),
};

const SCHEDULE_LIST_TOOL = {
  name: SCHEDULE_LIST_TOOL_NAME,
  description: "List scheduled tasks for the current Telegram chat.",
  parameters: Type.Object({
    status: Type.Optional(
      Type.Union([
        Type.Literal("pending"),
        Type.Literal("running"),
        Type.Literal("completed"),
        Type.Literal("failed"),
        Type.Literal("canceled"),
        Type.Literal("all"),
      ]),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 50,
        description: "Maximum number of items to return.",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description: "Display timezone for returned local times (IANA).",
      }),
    ),
  }),
};

const SCHEDULE_DELETE_TOOL = {
  name: SCHEDULE_DELETE_TOOL_NAME,
  description: "Cancel one scheduled task by job id for the current Telegram chat.",
  parameters: Type.Object({
    jobId: Type.String({
      minLength: 1,
      description: "Scheduled job id from schedule_list.",
    }),
  }),
};

const WEEKDAY_TOKEN_SCHEMA = Type.Union([
  Type.Literal("MO"),
  Type.Literal("TU"),
  Type.Literal("WE"),
  Type.Literal("TH"),
  Type.Literal("FR"),
  Type.Literal("SA"),
  Type.Literal("SU"),
]);

const SCHEDULE_RECURRING_CREATE_TOOL = {
  name: SCHEDULE_RECURRING_CREATE_TOOL_NAME,
  description:
    "Create a recurring schedule for the current Telegram chat. The prompt is executed later by Codex, so write it as the exact future instruction.",
  parameters: Type.Object({
    prompt: Type.String({
      minLength: 1,
      description:
        "Future instruction for trigger time, not the original scheduling sentence. Example: 'Tell the user to call their mom now.'",
    }),
    frequency: Type.Union([Type.Literal("daily"), Type.Literal("weekly")]),
    hour: Type.Number({
      minimum: 0,
      maximum: 23,
      description: "Local hour in 24h format (0-23).",
    }),
    minute: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 59,
        description: "Local minute (0-59). Defaults to 0.",
      }),
    ),
    weekdays: Type.Optional(
      Type.Array(WEEKDAY_TOKEN_SCHEMA, {
        minItems: 1,
        maxItems: 7,
        uniqueItems: true,
        description: "Required for weekly frequency. Use MO,TU,WE,TH,FR,SA,SU.",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description:
          "Optional IANA timezone override. If omitted, uses this chat timezone (set with timezone_set).",
      }),
    ),
  }),
};

const SCHEDULE_RECURRING_LIST_TOOL = {
  name: SCHEDULE_RECURRING_LIST_TOOL_NAME,
  description: "List recurring schedules for the current Telegram chat.",
  parameters: Type.Object({
    state: Type.Optional(
      Type.Union([
        Type.Literal("active"),
        Type.Literal("paused"),
        Type.Literal("running"),
        Type.Literal("canceled"),
        Type.Literal("all"),
      ]),
    ),
    limit: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 50,
        description: "Maximum number of items to return.",
      }),
    ),
    timezone: Type.Optional(
      Type.String({
        description: "Display timezone for returned local times (IANA).",
      }),
    ),
  }),
};

const SCHEDULE_RECURRING_DELETE_TOOL = {
  name: SCHEDULE_RECURRING_DELETE_TOOL_NAME,
  description: "Delete (cancel) one recurring schedule by recurring id for the current Telegram chat.",
  parameters: Type.Object({
    recurringId: Type.String({
      minLength: 1,
      description: "Recurring schedule id from schedule_recurring_list.",
    }),
  }),
};

const SCHEDULE_RECURRING_PAUSE_TOOL = {
  name: SCHEDULE_RECURRING_PAUSE_TOOL_NAME,
  description: "Pause one recurring schedule by recurring id for the current Telegram chat.",
  parameters: Type.Object({
    recurringId: Type.String({
      minLength: 1,
      description: "Recurring schedule id from schedule_recurring_list.",
    }),
  }),
};

const SCHEDULE_RECURRING_RESUME_TOOL = {
  name: SCHEDULE_RECURRING_RESUME_TOOL_NAME,
  description: "Resume one paused recurring schedule by recurring id for the current Telegram chat.",
  parameters: Type.Object({
    recurringId: Type.String({
      minLength: 1,
      description: "Recurring schedule id from schedule_recurring_list.",
    }),
  }),
};

const TIMEZONE_GET_TOOL = {
  name: TIMEZONE_GET_TOOL_NAME,
  description: "Get timezone settings for the current Telegram chat and show current UTC/local time.",
  parameters: Type.Object({}),
};

const TIMEZONE_SET_TOOL = {
  name: TIMEZONE_SET_TOOL_NAME,
  description:
    "Set timezone for the current Telegram chat. Use IANA names like Asia/Seoul, Europe/London, America/New_York.",
  parameters: Type.Object({
    timezone: Type.String({
      minLength: 1,
      description: "IANA timezone.",
    }),
  }),
};

const CURRENT_TIME_GET_TOOL = {
  name: CURRENT_TIME_GET_TOOL_NAME,
  description:
    "Get current time (UTC and local). Uses chat timezone by default, or a provided IANA timezone.",
  parameters: Type.Object({
    timezone: Type.Optional(
      Type.String({
        description: "Optional IANA timezone override.",
      }),
    ),
  }),
};

function trim(value) {
  return String(value ?? "").trim();
}

function normalizeWorkspaceRelativePath(rawPath) {
  const normalizedInput = trim(rawPath).replaceAll("\\", "/");
  if (!normalizedInput) {
    return "";
  }
  const normalized = path.posix.normalize(normalizedInput);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return "";
  }
  if (normalized.startsWith("/")) {
    return "";
  }
  return normalized;
}

function resolveWorkspacePath(workspaceRoot, rawPath) {
  const relativePath = normalizeWorkspaceRelativePath(rawPath);
  if (!relativePath) {
    return {
      ok: false,
      error: "Invalid workspace path. Use a workspace-relative path.",
    };
  }
  const absolutePath = path.resolve(workspaceRoot, relativePath);
  const escaped = path.relative(workspaceRoot, absolutePath).startsWith("..");
  if (escaped) {
    return {
      ok: false,
      error: "Path escapes workspace root.",
    };
  }
  return {
    ok: true,
    relativePath,
    absolutePath,
  };
}

function resolveWorkspaceWriteMode(value) {
  return trim(value).toLowerCase() === "append" ? "append" : "overwrite";
}

function resolveWorkspaceReadMaxChars(value) {
  return resolveWebFetchMaxChars(value);
}

function normalizeReasoningEffort(value) {
  const normalized = trim(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "off") {
    return "none";
  }
  if (normalized === "x-high" || normalized === "x_high" || normalized === "extra-high") {
    return "xhigh";
  }
  if (normalized === "extra_high") {
    return "xhigh";
  }
  if (normalized === "extra high" || normalized === "x high") {
    return "xhigh";
  }
  return normalized;
}

function resolveQwenInputTypes(modelId) {
  return modelId === "vision-model" ? ["text", "image"] : ["text"];
}

function resolveOllamaBaseUrl(providerConnection) {
  const configuredBaseUrl = trim(providerConnection?.baseUrl) || OLLAMA_API_BASE_URL;
  return normalizeOllamaBaseUrl(configuredBaseUrl, OLLAMA_API_BASE_URL);
}

function resolveOllamaOpenAIBaseUrl(providerConnection) {
  const base = resolveOllamaBaseUrl(providerConnection);
  return `${base}/v1`;
}

function buildFallbackModel(providerId, modelId, options = {}) {
  const resolvedProviderId = resolveProviderId(providerId);
  if (resolvedProviderId === OLLAMA_PROVIDER_ID) {
    return {
      id: modelId,
      name: modelId,
      // pi-ai does not include a built-in "ollama" API provider.
      // Use Ollama's OpenAI-compatible endpoint instead.
      api: "openai-completions",
      provider: OLLAMA_PROVIDER_ID,
      baseUrl: resolveOllamaOpenAIBaseUrl(options?.providerConnection),
      reasoning: false,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      },
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_768,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }
  if (resolvedProviderId === QWEN_PROVIDER_ID) {
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: QWEN_PROVIDER_ID,
      baseUrl: QWEN_API_BASE_URL,
      reasoning: true,
      compat: {
        thinkingFormat: "qwen",
        supportsDeveloperRole: false,
        supportsStore: false,
        supportsReasoningEffort: false,
      },
      input: resolveQwenInputTypes(modelId),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: DEFAULT_MAX_TOKENS,
    };
  }

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

function resolveModel(providerId, modelId, options = {}) {
  const resolvedProviderId = resolveProviderId(providerId);
  const normalizedId = normalizeProviderModelId(resolvedProviderId, modelId);
  const registered = getModel(resolvedProviderId, normalizedId);
  if (registered) {
    return registered;
  }
  return buildFallbackModel(resolvedProviderId, normalizedId, options);
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
  } else if (typeof message.content === "string" && trim(message.content)) {
    chunks.push(trim(message.content));
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

function resolveSkillEntry(skills, skillKey) {
  const entry = skills?.entries?.[skillKey];
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return entry;
}

function resolveSkillApiKey(skills, skillKey) {
  return trim(skills?.entries?.[skillKey]?.apiKey);
}

function resolveNotionApiKey(skills) {
  return resolveSkillApiKey(skills, NOTION_SKILL_KEY);
}

function resolveWebSearchApiKey(skills) {
  const fromConfig = resolveSkillApiKey(skills, WEB_SEARCH_SKILL_KEY);
  const fromEnv = trim(process.env[BRAVE_API_ENV_NAME]);
  return fromConfig || fromEnv;
}

function resolveWebSearchSkillEnabled(skills) {
  const entry = resolveSkillEntry(skills, WEB_SEARCH_SKILL_KEY);
  if (!entry) {
    return false;
  }
  if (typeof entry.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveWebFetchSkillEnabled(skills) {
  const entry = resolveSkillEntry(skills, WEB_FETCH_SKILL_KEY);
  if (!entry) {
    return false;
  }
  if (typeof entry.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveSchedulerSkillEnabled(skills) {
  const entry = resolveSkillEntry(skills, SCHEDULER_SKILL_KEY);
  if (!entry) {
    return false;
  }
  if (typeof entry.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function buildSkillsPrompt({
  notionEnabled,
  webSearchEnabled,
  webFetchEnabled,
  webSearchApiKey,
  schedulerEnabled,
  schedulerTimezoneConfigured,
  timeContextEnabled,
}) {
  const skills = [
    {
      name: WORKSPACE_FILES_SKILL_KEY,
      description: "Workspace file management for memory and instruction files.",
    },
  ];
  if (notionEnabled) {
    skills.push({
      name: NOTION_SKILL_KEY,
      description: "Notion API for creating and managing pages, databases, and blocks.",
    });
  }
  if (webSearchEnabled) {
    skills.push({
      name: WEB_SEARCH_SKILL_KEY,
      description: "Web search via Brave Search API.",
    });
  }
  if (webFetchEnabled) {
    skills.push({
      name: WEB_FETCH_SKILL_KEY,
      description: "Fetch and extract readable content from web pages.",
    });
  }
  if (schedulerEnabled) {
    skills.push({
      name: SCHEDULER_SKILL_KEY,
      description: "Schedule delayed/absolute follow-up tasks for the current Telegram chat.",
    });
  }
  if (timeContextEnabled) {
    skills.push({
      name: TIME_CONTEXT_SKILL_KEY,
      description: "Current time awareness and timezone management for this Telegram chat.",
    });
  }

  const lines = [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> and apply the matching skill instructions.",
    "<available_skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${skill.name}</name>`);
    lines.push(`    <description>${skill.description}</description>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");
  lines.push(
    "Skill details above are already summarized. Do not read SKILL.md files via workspace file tools.",
  );
  lines.push(
    `For workspace file operations, use tools \`${WORKSPACE_READ_TOOL_NAME}\`, \`${WORKSPACE_WRITE_TOOL_NAME}\`, \`${WORKSPACE_DELETE_TOOL_NAME}\`.`,
  );

  if (notionEnabled) {
    lines.push(`For Notion operations, use tool \`${NOTION_TOOL_NAME}\` instead of guessing API payloads.`);
    lines.push(
      `Authentication is already configured via ${NOTION_API_ENV_NAME}; never ask the user to reveal it.`,
    );
  }
  if (webSearchEnabled) {
    lines.push(`For web lookup, use tool \`${WEB_SEARCH_TOOL_NAME}\`.`);
    if (webSearchApiKey) {
      lines.push(`Brave auth is already configured via ${BRAVE_API_ENV_NAME}; never ask the user to reveal it.`);
    } else {
      lines.push(
        `If ${WEB_SEARCH_TOOL_NAME} returns missing API key, tell the user to configure ${BRAVE_API_ENV_NAME}.`,
      );
    }
  }
  if (webFetchEnabled) {
    lines.push(`For direct page retrieval, use tool \`${WEB_FETCH_TOOL_NAME}\`.`);
  }
  if (schedulerEnabled) {
    lines.push(
      `For one-time reminders, use \`${SCHEDULE_CREATE_TOOL_NAME}\`, \`${SCHEDULE_LIST_TOOL_NAME}\`, \`${SCHEDULE_DELETE_TOOL_NAME}\`.`,
    );
    lines.push(
      `For recurring reminders, use \`${SCHEDULE_RECURRING_CREATE_TOOL_NAME}\`, \`${SCHEDULE_RECURRING_LIST_TOOL_NAME}\`, \`${SCHEDULE_RECURRING_DELETE_TOOL_NAME}\`, \`${SCHEDULE_RECURRING_PAUSE_TOOL_NAME}\`, \`${SCHEDULE_RECURRING_RESUME_TOOL_NAME}\`.`,
    );
    lines.push(
      "Important: schedule_create.prompt is executed later as a new Codex request. Write it as the exact future instruction.",
    );
    lines.push(
      "Important: schedule_recurring_create.prompt follows the same rule. It must be the exact future instruction.",
    );
    lines.push(
      "Do not copy the user's scheduling sentence into prompt. Rewrite it into what future Codex should do.",
    );
    lines.push(
      "Few-shot: user='Schedule a reminder for 8 AM tomorrow to call my mom' -> schedule_create.prompt='Tell the user to call their mom now.'",
    );
    lines.push(
      "Few-shot: user='Remind me in 10 minutes to drink water' -> schedule_create.prompt='Tell the user to drink water now.'",
    );
    lines.push(
      "Few-shot: user='Every Monday at 8 PM remind me to send a weekly report' -> schedule_recurring_create.prompt='Tell the user to send their weekly report now.'",
    );
    lines.push("For relative requests (e.g. 'in 3 minutes'), prefer delaySeconds.");
    lines.push("For recurring local times, use frequency/hour/minute and weekdays (for weekly).");
    lines.push(
      "For absolute local times, provide runAt plus timezone (IANA) unless runAt already includes timezone offset.",
    );
    if (!schedulerTimezoneConfigured) {
      lines.push(
        "If timezone is not configured and user asks local-time scheduling, ask timezone and set it with timezone_set first.",
      );
    }
  }
  if (timeContextEnabled) {
    lines.push(
      `For timezone/current-time tasks, use \`${TIMEZONE_GET_TOOL_NAME}\`, \`${TIMEZONE_SET_TOOL_NAME}\`, \`${CURRENT_TIME_GET_TOOL_NAME}\`.`,
    );
  }

  return lines.join("\n");
}

function buildWorkspacePrompt({ workspaceRoot, isFirstTurn }) {
  const lines = [
    "## Workspace",
    `Workspace root: ${workspaceRoot}`,
    `Memory file: ${WORKSPACE_MEMORY_FILE_NAME}`,
    `Instruction file: ${WORKSPACE_INSTRUCTIONS_FILE_NAME}`,
    "Priority rule: INSTRUCTIONS.md and MEMORY.md are the primary chat-level behavior/context source.",
    "If they conflict with generic system wording, prefer INSTRUCTIONS.md and MEMORY.md unless it violates hard safety constraints.",
    "workspace_* tools are only for files under Workspace root.",
    "Do not use workspace_* tools for repository source paths such as src/, skills/, bin/, docs/, README.md.",
    "Never claim workspace file changes unless you actually executed workspace tools.",
    "Memory update rule: you may update MEMORY.md proactively when it improves future replies.",
    "Instruction update rule: modify INSTRUCTIONS.md only when the user explicitly asks for it, or clearly consents after your proposal.",
    "When a user asks to change instructions, apply the update directly with workspace_write_file and report exactly what changed.",
  ];
  if (isFirstTurn) {
    lines.push(
      "First-turn rule: before final response, ensure MEMORY.md and INSTRUCTIONS.md both exist, then read both files. ",
    );
    lines.push(
      "On first turn, do not read any other workspace file unless the user explicitly asks for it.",
    );
    lines.push(
      "If either file is missing, create it with workspace_write_file (empty content is allowed), then read both files.",
    );
    lines.push("On first turn, apply INSTRUCTIONS.md and MEMORY.md context before producing the final answer.");
  }
  return lines.join("\n");
}

function buildRuntimeClockPrompt({ nowUtcIso, timezone, localNow, timezoneConfigured, timeContextEnabled }) {
  const lines = [
    "## Time Context",
    `Current UTC time: ${nowUtcIso}`,
  ];
  if (timezoneConfigured && timezone) {
    lines.push(`Chat timezone: ${timezone}`);
    if (localNow) {
      lines.push(`Current local time (${timezone}): ${localNow}`);
    }
  } else if (timeContextEnabled) {
    lines.push("Chat timezone: not set");
    lines.push(
      `If the user asks local-time scheduling, ask for timezone (IANA) and set it with ${TIMEZONE_SET_TOOL_NAME}.`,
    );
  } else {
    lines.push("Timezone context: unavailable in this runtime.");
  }
  return lines.join("\n");
}

function buildSystemPrompt({
  instructions,
  notionEnabled,
  webSearchEnabled,
  webFetchEnabled,
  webSearchApiKey,
  schedulerEnabled,
  schedulerTimezoneConfigured,
  timeContextEnabled,
  workspaceRoot,
  isFirstTurn,
  runtimeClockPrompt,
}) {
  const skillsPrompt = buildSkillsPrompt({
    notionEnabled,
    webSearchEnabled,
    webFetchEnabled,
    webSearchApiKey,
    schedulerEnabled,
    schedulerTimezoneConfigured,
    timeContextEnabled,
  });
  const workspacePrompt = buildWorkspacePrompt({
    workspaceRoot,
    isFirstTurn,
  });
  return [instructions, workspacePrompt, runtimeClockPrompt, skillsPrompt].filter(Boolean).join("\n\n");
}

function collectToolCalls(message, toolNames) {
  if (!message || typeof message !== "object" || !Array.isArray(message.content)) {
    return [];
  }
  const allowed = new Set(Array.isArray(toolNames) ? toolNames.map((name) => trim(name)) : []);
  if (allowed.size === 0) {
    return [];
  }
  return message.content.filter(
    (block) =>
      block &&
      typeof block === "object" &&
      block.type === "toolCall" &&
      allowed.has(trim(block.name)),
  );
}

function buildZeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function asUsageNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function normalizeUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
  const input = asUsageNumber(usage.input);
  const output = asUsageNumber(usage.output);
  const cacheRead = asUsageNumber(usage.cacheRead);
  const cacheWrite = asUsageNumber(usage.cacheWrite);
  const derivedTotal = input + output + cacheRead + cacheWrite;
  const totalTokens = asUsageNumber(usage.totalTokens) || derivedTotal;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: asUsageNumber(cost.input),
      output: asUsageNumber(cost.output),
      cacheRead: asUsageNumber(cost.cacheRead),
      cacheWrite: asUsageNumber(cost.cacheWrite),
      total: asUsageNumber(cost.total),
    },
  };
}

function sumUsage(baseUsage, deltaUsage) {
  const base = normalizeUsage(baseUsage);
  const delta = normalizeUsage(deltaUsage);
  return {
    input: base.input + delta.input,
    output: base.output + delta.output,
    cacheRead: base.cacheRead + delta.cacheRead,
    cacheWrite: base.cacheWrite + delta.cacheWrite,
    totalTokens: base.totalTokens + delta.totalTokens,
    cost: {
      input: base.cost.input + delta.cost.input,
      output: base.cost.output + delta.cost.output,
      cacheRead: base.cost.cacheRead + delta.cost.cacheRead,
      cacheWrite: base.cost.cacheWrite + delta.cost.cacheWrite,
      total: base.cost.total + delta.cost.total,
    },
  };
}

function normalizeAssistantContentBlocks(rawContent) {
  if (Array.isArray(rawContent)) {
    const blocks = rawContent
      .map((block) => {
        if (!block || typeof block !== "object") {
          return null;
        }
        if (block.type === "text" && typeof block.text === "string" && trim(block.text)) {
          return {
            type: "text",
            text: trim(block.text),
          };
        }
        return null;
      })
      .filter(Boolean);
    if (blocks.length > 0) {
      return blocks;
    }
  }

  const text = trim(rawContent);
  if (!text) {
    return [];
  }
  return [
    {
      type: "text",
      text,
    },
  ];
}

function normalizeConversationMessages(rawMessages, model) {
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
    const timestampRaw = Number(raw.timestamp);
    const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0 ? timestampRaw : Date.now();

    if (role === "user") {
      const content = trim(raw.content);
      if (!content) {
        continue;
      }
      out.push({
        role: "user",
        content,
        timestamp,
      });
      continue;
    }

    const contentBlocks = normalizeAssistantContentBlocks(raw.content);
    if (contentBlocks.length === 0) {
      continue;
    }
    out.push({
      role: "assistant",
      content: contentBlocks,
      api: trim(model?.api),
      provider: trim(model?.provider),
      model: trim(model?.id),
      usage: buildZeroUsage(),
      stopReason: "stop",
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

function resolveWebSearchCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return WEB_SEARCH_DEFAULT_COUNT;
  }
  return Math.max(1, Math.min(WEB_SEARCH_MAX_COUNT, Math.floor(parsed)));
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function normalizeWebSearchFreshness(value) {
  const raw = trim(value).toLowerCase();
  if (!raw) {
    return "";
  }
  if (BRAVE_FRESHNESS_SHORTCUTS.has(raw)) {
    return raw;
  }
  const matched = raw.match(BRAVE_FRESHNESS_RANGE);
  if (!matched) {
    return "";
  }
  const [, start, end] = matched;
  if (!isValidIsoDate(start) || !isValidIsoDate(end) || start > end) {
    return "";
  }
  return `${start}to${end}`;
}

function normalizeWebFetchUrl(value) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeWebFetchExtractMode(value) {
  return trim(value).toLowerCase() === "text" ? "text" : "markdown";
}

function resolveWebFetchMaxChars(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return WEB_FETCH_DEFAULT_MAX_CHARS;
  }
  return Math.max(100, Math.min(WEB_FETCH_MAX_CHARS_CAP, Math.floor(parsed)));
}

function decodeHtmlEntities(value) {
  if (!value) {
    return "";
  }
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return value
    .replace(/&#(\d+);/g, (_, num) => {
      const codePoint = Number.parseInt(num, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
    })
    .replace(/&([a-zA-Z]+);/g, (full, name) => entities[name] ?? full);
}

function extractHtmlTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return "";
  }
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim();
}

function stripHtmlToText(html) {
  if (!html) {
    return "";
  }

  let text = html;
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, " ");
  text = text.replace(/<\s*br\s*\/?>/gi, "\n");
  text = text.replace(/<\s*\/\s*(p|div|section|article|main|header|footer|aside|li|ul|ol|h[1-6]|table|tr|pre|blockquote)\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  text = text.replace(/\r/g, "");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]{2,}/g, " ");
  return text.trim();
}

function markdownToText(value) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }
  return raw
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^\)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .trim();
}

function normalizeContentType(value) {
  const raw = trim(value);
  if (!raw) {
    return "application/octet-stream";
  }
  const [type] = raw.split(";");
  return trim(type).toLowerCase() || "application/octet-stream";
}

function truncateText(value, maxChars) {
  const raw = String(value ?? "");
  if (raw.length <= maxChars) {
    return {
      text: raw,
      truncated: false,
    };
  }
  const suffix = "\n...[truncated]";
  const head = Math.max(0, maxChars - suffix.length);
  return {
    text: `${raw.slice(0, head)}${suffix}`,
    truncated: true,
  };
}

function buildToolResultText(payload) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload ?? {}, null, 2);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}

async function parseResponseBody(response) {
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
    toolName: trim(toolCall?.name) || "tool",
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

function normalizeToolCallArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {}
  }
  return {};
}

function truncateToolPath(value) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }
  if (raw.length <= 160) {
    return raw;
  }
  return `${raw.slice(0, 157)}...`;
}

function resolveToolTarget(toolName, args) {
  if (toolName === NOTION_TOOL_NAME) {
    return {
      method: normalizeNotionMethod(args?.method) || trim(args?.method).toUpperCase(),
      path: truncateToolPath(normalizeNotionPath(args?.path) || trim(args?.path)),
    };
  }
  if (toolName === WEB_SEARCH_TOOL_NAME) {
    return {
      method: "SEARCH",
      path: truncateToolPath(trim(args?.query)),
    };
  }
  if (toolName === WEB_FETCH_TOOL_NAME) {
    return {
      method: "GET",
      path: truncateToolPath(trim(args?.url)),
    };
  }
  if (toolName === WORKSPACE_READ_TOOL_NAME) {
    return {
      method: "READ",
      path: truncateToolPath(trim(args?.path)),
    };
  }
  if (toolName === WORKSPACE_WRITE_TOOL_NAME) {
    return {
      method: resolveWorkspaceWriteMode(args?.mode).toUpperCase(),
      path: truncateToolPath(trim(args?.path)),
    };
  }
  if (toolName === WORKSPACE_DELETE_TOOL_NAME) {
    return {
      method: "DELETE",
      path: truncateToolPath(trim(args?.path)),
    };
  }
  if (toolName === SCHEDULE_CREATE_TOOL_NAME) {
    return {
      method: "CREATE",
      path: truncateToolPath(trim(args?.runAt) || `${Math.floor(Number(args?.delaySeconds) || 0)}s`),
    };
  }
  if (toolName === SCHEDULE_LIST_TOOL_NAME) {
    return {
      method: "LIST",
      path: truncateToolPath(trim(args?.status) || "pending"),
    };
  }
  if (toolName === SCHEDULE_DELETE_TOOL_NAME) {
    return {
      method: "DELETE",
      path: truncateToolPath(trim(args?.jobId)),
    };
  }
  if (toolName === SCHEDULE_RECURRING_CREATE_TOOL_NAME) {
    return {
      method: "CREATE",
      path: truncateToolPath(
        `${trim(args?.frequency) || "?"} ${String(args?.hour ?? "?")}:${String(args?.minute ?? 0)}`,
      ),
    };
  }
  if (toolName === SCHEDULE_RECURRING_LIST_TOOL_NAME) {
    return {
      method: "LIST",
      path: truncateToolPath(trim(args?.state) || "all"),
    };
  }
  if (toolName === SCHEDULE_RECURRING_DELETE_TOOL_NAME) {
    return {
      method: "DELETE",
      path: truncateToolPath(trim(args?.recurringId)),
    };
  }
  if (toolName === SCHEDULE_RECURRING_PAUSE_TOOL_NAME) {
    return {
      method: "PAUSE",
      path: truncateToolPath(trim(args?.recurringId)),
    };
  }
  if (toolName === SCHEDULE_RECURRING_RESUME_TOOL_NAME) {
    return {
      method: "RESUME",
      path: truncateToolPath(trim(args?.recurringId)),
    };
  }
  if (toolName === TIMEZONE_GET_TOOL_NAME) {
    return {
      method: "GET",
      path: "timezone",
    };
  }
  if (toolName === TIMEZONE_SET_TOOL_NAME) {
    return {
      method: "SET",
      path: truncateToolPath(trim(args?.timezone)),
    };
  }
  if (toolName === CURRENT_TIME_GET_TOOL_NAME) {
    return {
      method: "GET",
      path: truncateToolPath(trim(args?.timezone) || "current-time"),
    };
  }
  return {
    method: "",
    path: "",
  };
}

async function ensureWorkspaceScaffold(workspaceRoot, workspaceTemplateRoot) {
  await ensureWorkspaceInitialized({
    workspaceRoot,
    templateRoot: workspaceTemplateRoot,
  });
}

function buildMissingBraveApiKeyPayload() {
  return {
    ok: false,
    error: "missing_brave_api_key",
    message:
      "web_search needs a Brave Search API key. Configure skills.entries.web_search.apiKey or set BRAVE_API_KEY.",
    docs: "https://docs.openclaw.ai/tools/web",
  };
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
    const body = await parseResponseBody(response);
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

async function executeWebSearchToolCall(params) {
  const apiKey = trim(params?.apiKey);
  const query = trim(params?.query);
  const count = resolveWebSearchCount(params?.count);
  const country = trim(params?.country);
  const searchLang = trim(params?.search_lang);
  const uiLang = trim(params?.ui_lang);
  const freshnessRaw = trim(params?.freshness);
  const freshness = normalizeWebSearchFreshness(freshnessRaw);

  if (!query) {
    return {
      ok: false,
      error: "Query is required.",
    };
  }
  if (!apiKey) {
    return buildMissingBraveApiKeyPayload();
  }
  if (freshnessRaw && !freshness) {
    return {
      ok: false,
      error: "Invalid freshness. Use pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD.",
    };
  }

  const searchParams = new URLSearchParams();
  searchParams.set("q", query);
  searchParams.set("count", String(count));
  if (country) {
    searchParams.set("country", country);
  }
  if (searchLang) {
    searchParams.set("search_lang", searchLang);
  }
  if (uiLang) {
    searchParams.set("ui_lang", uiLang);
  }
  if (freshness) {
    searchParams.set("freshness", freshness);
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(`${BRAVE_SEARCH_ENDPOINT}?${searchParams.toString()}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: AbortSignal.timeout(WEB_FETCH_DEFAULT_TIMEOUT_MS),
    });

    const body = await parseResponseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        provider: "brave",
        query,
        error: `Brave API error (${response.status})`,
        body,
      };
    }

    const rows = Array.isArray(body?.web?.results) ? body.web.results : [];
    const results = rows.slice(0, count).map((entry) => ({
      title: trim(entry?.title),
      url: trim(entry?.url),
      description: trim(entry?.description),
      age: trim(entry?.age),
    }));

    return {
      ok: true,
      status: response.status,
      provider: "brave",
      query,
      count,
      country: country || undefined,
      search_lang: searchLang || undefined,
      ui_lang: uiLang || undefined,
      freshness: freshness || undefined,
      tookMs: Date.now() - startedAt,
      results,
    };
  } catch (error) {
    return {
      ok: false,
      provider: "brave",
      query,
      error: trim(error?.message) || String(error),
    };
  }
}

function formatWebFetchErrorDetail(value, contentType) {
  const raw = trim(value);
  if (!raw) {
    return "";
  }
  const normalizedType = normalizeContentType(contentType);
  const rendered = normalizedType.includes("text/html") ? stripHtmlToText(raw) : raw;
  return truncateText(rendered, WEB_FETCH_DEFAULT_ERROR_DETAIL_CHARS).text;
}

async function executeWebFetchToolCall(params) {
  const url = normalizeWebFetchUrl(params?.url);
  const extractMode = normalizeWebFetchExtractMode(params?.extractMode);
  const maxChars = resolveWebFetchMaxChars(params?.maxChars);

  if (!url) {
    return {
      ok: false,
      error: "Invalid URL. Use http:// or https://",
    };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/markdown, text/html;q=0.9, application/json;q=0.8, text/plain;q=0.7, */*;q=0.1",
        "User-Agent": WEB_FETCH_DEFAULT_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(WEB_FETCH_DEFAULT_TIMEOUT_MS),
    });

    const rawBody = await response.text();
    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!response.ok) {
      return {
        ok: false,
        url,
        finalUrl: trim(response.url) || url,
        status: response.status,
        contentType,
        error: `Web fetch failed (${response.status})`,
        detail: formatWebFetchErrorDetail(rawBody, contentType),
      };
    }

    let extractor = "raw";
    let title = "";
    let text = rawBody;

    if (contentType.includes("text/html")) {
      title = extractHtmlTitle(rawBody);
      text = stripHtmlToText(rawBody);
      extractor = "html";
    } else if (contentType.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(rawBody), null, 2);
        extractor = "json";
      } catch {
        text = rawBody;
        extractor = "json-raw";
      }
    } else if (contentType.includes("text/markdown")) {
      extractor = "markdown";
      if (extractMode === "text") {
        text = markdownToText(rawBody);
      }
    } else if (contentType.startsWith("text/")) {
      extractor = "text";
    }

    if (extractMode === "text" && extractor !== "markdown") {
      text = trim(text);
    }

    const truncated = truncateText(text, maxChars);
    return {
      ok: true,
      url,
      finalUrl: trim(response.url) || url,
      status: response.status,
      contentType,
      title: title || undefined,
      extractMode,
      extractor,
      truncated: truncated.truncated,
      length: truncated.text.length,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
      text: truncated.text,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeWorkspaceReadToolCall(params) {
  const workspaceRoot = resolveWorkspaceRoot(params?.workspaceRoot);
  const resolved = resolveWorkspacePath(workspaceRoot, params?.path);
  if (!resolved.ok) {
    return {
      ok: false,
      workspaceRoot,
      error: resolved.error,
    };
  }

  const maxChars = resolveWorkspaceReadMaxChars(params?.maxChars);
  try {
    const stat = await fs.stat(resolved.absolutePath);
    if (!stat.isFile()) {
      return {
        ok: false,
        workspaceRoot,
        path: resolved.relativePath,
        error: "Target is not a file.",
      };
    }
    const content = await fs.readFile(resolved.absolutePath, "utf8");
    const truncated = truncateText(content, maxChars);
    return {
      ok: true,
      workspaceRoot,
      path: resolved.relativePath,
      truncated: truncated.truncated,
      length: truncated.text.length,
      text: truncated.text,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        workspaceRoot,
        path: resolved.relativePath,
        error: "not_found",
        retryable: false,
        message:
          "File not found in workspace root. Do not retry with repository skill paths (for example src/skills/.../SKILL.md).",
      };
    }
    return {
      ok: false,
      workspaceRoot,
      path: resolved.relativePath,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeWorkspaceWriteToolCall(params) {
  const workspaceRoot = resolveWorkspaceRoot(params?.workspaceRoot);
  const resolved = resolveWorkspacePath(workspaceRoot, params?.path);
  if (!resolved.ok) {
    return {
      ok: false,
      workspaceRoot,
      error: resolved.error,
    };
  }

  const content =
    typeof params?.content === "string"
      ? params.content
      : params?.content === undefined || params?.content === null
        ? ""
        : String(params.content);
  const mode = resolveWorkspaceWriteMode(params?.mode);

  try {
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    if (mode === "append") {
      await fs.appendFile(resolved.absolutePath, content, "utf8");
    } else {
      await fs.writeFile(resolved.absolutePath, content, "utf8");
    }
    const stat = await fs.stat(resolved.absolutePath);
    return {
      ok: true,
      workspaceRoot,
      path: resolved.relativePath,
      mode,
      bytes: Number.isFinite(stat.size) ? stat.size : undefined,
    };
  } catch (error) {
    return {
      ok: false,
      workspaceRoot,
      path: resolved.relativePath,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeWorkspaceDeleteToolCall(params) {
  const workspaceRoot = resolveWorkspaceRoot(params?.workspaceRoot);
  const resolved = resolveWorkspacePath(workspaceRoot, params?.path);
  if (!resolved.ok) {
    return {
      ok: false,
      workspaceRoot,
      error: resolved.error,
    };
  }

  const recursive = Boolean(params?.recursive);
  try {
    const stat = await fs.stat(resolved.absolutePath);
    if (stat.isDirectory() && !recursive) {
      return {
        ok: false,
        workspaceRoot,
        path: resolved.relativePath,
        error: "Target is a directory. Set recursive=true to delete directories.",
      };
    }
    await fs.rm(resolved.absolutePath, { recursive, force: false });
    return {
      ok: true,
      workspaceRoot,
      path: resolved.relativePath,
      recursive,
      deletedType: stat.isDirectory() ? "directory" : "file",
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: false,
        workspaceRoot,
        path: resolved.relativePath,
        error: "not_found",
      };
    }
    return {
      ok: false,
      workspaceRoot,
      path: resolved.relativePath,
      error: trim(error?.message) || String(error),
    };
  }
}

function resolveRuntimeScheduleContext(params) {
  const channel = trim(params?.runtime?.channel).toLowerCase();
  const chatId = trim(params?.runtime?.chatId);
  const sessionId = trim(params?.runtime?.sessionId);
  if (!channel || !chatId || !sessionId) {
    return {
      ok: false,
      error: "Schedule tools need runtime context (channel/chat/session).",
    };
  }
  return {
    ok: true,
    channel,
    chatId,
    sessionId,
  };
}

function resolveRuntimeTelegramContext(params) {
  const channel = trim(params?.runtime?.channel).toLowerCase();
  const chatId = trim(params?.runtime?.chatId);
  if (channel !== "telegram" || !chatId) {
    return {
      ok: false,
      error: "This tool is available only in Telegram chat context.",
    };
  }
  return {
    ok: true,
    channel,
    chatId,
  };
}

function buildNowPayload(timezone) {
  const nowMs = Date.now();
  const nowUtc = new Date(nowMs).toISOString();
  const safeTimezone = trim(timezone);
  if (!safeTimezone || !isValidSchedulerTimezone(safeTimezone)) {
    return {
      nowUtc,
      timezoneConfigured: false,
      timezone: null,
      nowLocal: null,
    };
  }
  return {
    nowUtc,
    timezoneConfigured: true,
    timezone: resolveSchedulerTimezone(safeTimezone),
    nowLocal: formatDateTimeInTimezone(nowMs, safeTimezone),
  };
}

async function executeTimezoneGetToolCall(params) {
  const runtime = resolveRuntimeTelegramContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  const timezone = await getTelegramChatTimezone({
    customConfigPath: params?.configPath,
    chatId: runtime.chatId,
  });
  const now = buildNowPayload(timezone);
  return {
    ok: true,
    timezoneConfigured: now.timezoneConfigured,
    timezone: now.timezone,
    nowUtc: now.nowUtc,
    nowLocal: now.nowLocal,
  };
}

async function executeTimezoneSetToolCall(params) {
  const runtime = resolveRuntimeTelegramContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  const result = await setTelegramChatTimezone({
    customConfigPath: params?.configPath,
    chatId: runtime.chatId,
    timezone: params?.timezone,
  });
  if (!result?.ok) {
    return result;
  }
  const now = buildNowPayload(result.timezone);
  return {
    ok: true,
    timezone: result.timezone,
    timezoneConfigured: true,
    nowUtc: now.nowUtc,
    nowLocal: now.nowLocal,
  };
}

async function executeCurrentTimeGetToolCall(params) {
  const runtime = resolveRuntimeTelegramContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  const timezoneArg = trim(params?.timezone);
  let timezone = "";
  if (timezoneArg) {
    if (!isValidSchedulerTimezone(timezoneArg)) {
      return {
        ok: false,
        error:
          "Invalid timezone. Use IANA timezone like Asia/Seoul, Europe/London, or America/New_York.",
      };
    }
    timezone = resolveSchedulerTimezone(timezoneArg);
  } else {
    timezone = await getTelegramChatTimezone({
      customConfigPath: params?.configPath,
      chatId: runtime.chatId,
    });
  }

  const now = buildNowPayload(timezone);
  return {
    ok: true,
    timezoneConfigured: now.timezoneConfigured,
    timezone: now.timezone,
    nowUtc: now.nowUtc,
    nowLocal: now.nowLocal,
    unixMs: Date.now(),
  };
}

async function executeScheduleCreateToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await createScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      sessionId: runtime.sessionId,
      prompt: params?.prompt,
      delaySeconds: params?.delaySeconds,
      runAt: params?.runAt,
      timezone: params?.timezone,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.displayTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleListToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await listScheduledJobs({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      status: params?.status,
      limit: params?.limit,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.timezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleDeleteToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await cancelScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      jobId: params?.jobId,
      displayTimezone: params?.defaultTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleRecurringCreateToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await createRecurringScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      sessionId: runtime.sessionId,
      prompt: params?.prompt,
      frequency: params?.frequency,
      weekdays: params?.weekdays,
      hour: params?.hour,
      minute: params?.minute,
      timezone: params?.timezone,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.displayTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleRecurringListToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await listRecurringScheduledJobs({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      state: params?.state,
      limit: params?.limit,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.timezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleRecurringDeleteToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await deleteRecurringScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      recurringId: params?.recurringId,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.defaultTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleRecurringPauseToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await pauseRecurringScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      recurringId: params?.recurringId,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.defaultTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

async function executeScheduleRecurringResumeToolCall(params) {
  const runtime = resolveRuntimeScheduleContext(params);
  if (!runtime.ok) {
    return {
      ok: false,
      error: runtime.error,
    };
  }

  try {
    return await resumeRecurringScheduledJob({
      customConfigPath: params?.configPath,
      channel: runtime.channel,
      chatId: runtime.chatId,
      recurringId: params?.recurringId,
      defaultTimezone: params?.defaultTimezone,
      displayTimezone: params?.defaultTimezone,
    });
  } catch (error) {
    return {
      ok: false,
      error: trim(error?.message) || String(error),
    };
  }
}

function validateAssistantResponse(response) {
  if (!response || typeof response !== "object") {
    throw new Error("Model API returned an invalid response.");
  }
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(`Model API error: ${trim(response.errorMessage) || "request failed"}`);
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
  const providerId = resolveProviderId(params?.providerId);
  const modelId = normalizeProviderModelId(providerId, params?.modelId);
  const message = trim(params?.message);
  const reasoningEffortRaw = normalizeReasoningEffort(params?.reasoningEffort);
  const instructions = trim(params?.instructions) || DEFAULT_CODEX_INSTRUCTIONS;
  const workspaceRoot = resolveWorkspaceRoot(params?.workspaceRoot);
  const workspaceTemplateRoot = resolveWorkspaceTemplateRoot(params?.workspaceTemplateRoot);
  const isFirstTurn = Boolean(params?.isFirstTurn);

  const notionApiKey = resolveNotionApiKey(params?.skills);
  const notionEnabled = Boolean(notionApiKey);

  const webSearchEnabled = resolveWebSearchSkillEnabled(params?.skills);
  const webSearchApiKey = resolveWebSearchApiKey(params?.skills);

  const webFetchEnabled = resolveWebFetchSkillEnabled(params?.skills);
  const schedulerEnabled = resolveSchedulerSkillEnabled(params?.skills);
  const runtimeChannel = trim(params?.runtime?.channel).toLowerCase();
  const runtimeChatId = trim(params?.runtime?.chatId);
  const runtimeSessionId = trim(params?.runtime?.sessionId);
  const runtimeHasTelegramContext = runtimeChannel === "telegram" && Boolean(runtimeChatId);
  const runtimeTimezoneFromStore = runtimeHasTelegramContext
    ? await getTelegramChatTimezone({
        customConfigPath: params?.configPath,
        chatId: runtimeChatId,
      })
    : "";
  const schedulerTimezone = runtimeTimezoneFromStore || "";
  const schedulerRuntimeEnabled =
    schedulerEnabled && Boolean(runtimeChannel && runtimeChatId && runtimeSessionId);
  const timeContextEnabled = runtimeHasTelegramContext;
  const nowUtcIso = new Date().toISOString();
  const localNow = schedulerTimezone ? formatDateTimeInTimezone(Date.now(), schedulerTimezone) : "";
  const runtimeClockPrompt = buildRuntimeClockPrompt({
    nowUtcIso,
    timezone: schedulerTimezone,
    localNow,
    timezoneConfigured: Boolean(schedulerTimezone),
    timeContextEnabled,
  });

  if (!modelId) {
    throw new Error("Missing model id.");
  }
  const model = resolveModel(providerId, modelId, {
    providerConnection: params?.providerConnection,
  });
  const history = normalizeConversationMessages(params?.messages, model);

  if (providerId !== OLLAMA_PROVIDER_ID && !accessToken) {
    throw new Error("Missing access token.");
  }
  if (!message && history.length === 0) {
    throw new Error("Message is empty.");
  }
  if (reasoningEffortRaw && !REASONING_EFFORT_LEVELS.has(reasoningEffortRaw)) {
    throw new Error(
      `Invalid reasoning effort: ${reasoningEffortRaw}. Use none|minimal|low|medium|high|xhigh.`,
    );
  }
  const reasoningEffort = reasoningEffortRaw === "none" ? undefined : reasoningEffortRaw;

  try {
    await ensureWorkspaceScaffold(workspaceRoot, workspaceTemplateRoot);
  } catch (error) {
    throw new Error(`Workspace init failed: ${trim(error?.message) || String(error)}`);
  }

  const systemPrompt = buildSystemPrompt({
    instructions,
    notionEnabled,
    webSearchEnabled,
    webFetchEnabled,
    webSearchApiKey,
    schedulerEnabled: schedulerRuntimeEnabled,
    schedulerTimezoneConfigured: Boolean(schedulerTimezone),
    timeContextEnabled,
    workspaceRoot,
    isFirstTurn,
    runtimeClockPrompt,
  });

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

  const enabledTools = [];
  const toolHandlers = new Map();

  enabledTools.push(WORKSPACE_READ_TOOL);
  toolHandlers.set(WORKSPACE_READ_TOOL_NAME, async (rawArgs) =>
    executeWorkspaceReadToolCall({
      ...rawArgs,
      workspaceRoot,
    }),
  );

  enabledTools.push(WORKSPACE_WRITE_TOOL);
  toolHandlers.set(WORKSPACE_WRITE_TOOL_NAME, async (rawArgs) =>
    executeWorkspaceWriteToolCall({
      ...rawArgs,
      workspaceRoot,
    }),
  );

  enabledTools.push(WORKSPACE_DELETE_TOOL);
  toolHandlers.set(WORKSPACE_DELETE_TOOL_NAME, async (rawArgs) =>
    executeWorkspaceDeleteToolCall({
      ...rawArgs,
      workspaceRoot,
    }),
  );

  if (timeContextEnabled) {
    enabledTools.push(TIMEZONE_GET_TOOL);
    toolHandlers.set(TIMEZONE_GET_TOOL_NAME, async (rawArgs) =>
      executeTimezoneGetToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
      }),
    );

    enabledTools.push(TIMEZONE_SET_TOOL);
    toolHandlers.set(TIMEZONE_SET_TOOL_NAME, async (rawArgs) =>
      executeTimezoneSetToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
      }),
    );

    enabledTools.push(CURRENT_TIME_GET_TOOL);
    toolHandlers.set(CURRENT_TIME_GET_TOOL_NAME, async (rawArgs) =>
      executeCurrentTimeGetToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
      }),
    );
  }

  if (notionEnabled) {
    enabledTools.push(NOTION_TOOL);
    toolHandlers.set(NOTION_TOOL_NAME, async (rawArgs) =>
      executeNotionToolCall({
        ...rawArgs,
        apiKey: notionApiKey,
      }),
    );
  }

  if (webSearchEnabled) {
    enabledTools.push(WEB_SEARCH_TOOL);
    toolHandlers.set(WEB_SEARCH_TOOL_NAME, async (rawArgs) =>
      executeWebSearchToolCall({
        ...rawArgs,
        apiKey: webSearchApiKey,
      }),
    );
  }

  if (webFetchEnabled) {
    enabledTools.push(WEB_FETCH_TOOL);
    toolHandlers.set(WEB_FETCH_TOOL_NAME, async (rawArgs) => executeWebFetchToolCall(rawArgs));
  }

  if (schedulerRuntimeEnabled) {
    enabledTools.push(SCHEDULE_CREATE_TOOL);
    toolHandlers.set(SCHEDULE_CREATE_TOOL_NAME, async (rawArgs) =>
      executeScheduleCreateToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
        displayTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_LIST_TOOL);
    toolHandlers.set(SCHEDULE_LIST_TOOL_NAME, async (rawArgs) =>
      executeScheduleListToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_DELETE_TOOL);
    toolHandlers.set(SCHEDULE_DELETE_TOOL_NAME, async (rawArgs) =>
      executeScheduleDeleteToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_RECURRING_CREATE_TOOL);
    toolHandlers.set(SCHEDULE_RECURRING_CREATE_TOOL_NAME, async (rawArgs) =>
      executeScheduleRecurringCreateToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
        displayTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_RECURRING_LIST_TOOL);
    toolHandlers.set(SCHEDULE_RECURRING_LIST_TOOL_NAME, async (rawArgs) =>
      executeScheduleRecurringListToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_RECURRING_DELETE_TOOL);
    toolHandlers.set(SCHEDULE_RECURRING_DELETE_TOOL_NAME, async (rawArgs) =>
      executeScheduleRecurringDeleteToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_RECURRING_PAUSE_TOOL);
    toolHandlers.set(SCHEDULE_RECURRING_PAUSE_TOOL_NAME, async (rawArgs) =>
      executeScheduleRecurringPauseToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );

    enabledTools.push(SCHEDULE_RECURRING_RESUME_TOOL);
    toolHandlers.set(SCHEDULE_RECURRING_RESUME_TOOL_NAME, async (rawArgs) =>
      executeScheduleRecurringResumeToolCall({
        ...rawArgs,
        runtime: {
          channel: runtimeChannel,
          chatId: runtimeChatId,
          sessionId: runtimeSessionId,
        },
        configPath: params?.configPath,
        defaultTimezone: schedulerTimezone,
      }),
    );
  }

  const enabledToolNames = Array.from(toolHandlers.keys());

  let response = null;
  const toolEvents = [];
  const toolResults = [];
  let usage = buildZeroUsage();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    try {
      response = await completeSimple(
        model,
        {
          systemPrompt,
          messages,
          tools: enabledTools.length > 0 ? enabledTools : undefined,
        },
        {
          apiKey: accessToken,
          reasoningEffort,
        },
      );
    } catch (error) {
      throw new Error(`Model API error: ${trim(error?.message) || String(error)}`);
    }

    validateAssistantResponse(response);
    usage = sumUsage(usage, response?.usage);

    if (enabledToolNames.length === 0) {
      break;
    }

    const toolCalls = collectToolCalls(response, enabledToolNames);
    if (toolCalls.length === 0) {
      break;
    }
    if (round === MAX_TOOL_ROUNDS - 1) {
      throw new Error("Tool call limit reached.");
    }

    messages.push(response);

    for (let i = 0; i < toolCalls.length; i += 1) {
      const toolCall = toolCalls[i];
      const toolName = trim(toolCall?.name);
      const handler = toolHandlers.get(toolName);
      if (typeof handler !== "function") {
        continue;
      }

      const rawArgs = normalizeToolCallArguments(toolCall?.arguments);
      const toolCallId = trim(toolCall?.id) || `tool-${Date.now()}-${i + 1}`;
      const target = resolveToolTarget(toolName, rawArgs);

      await emitToolEvent(params?.onToolEvent, {
        phase: "start",
        toolName,
        toolCallId,
        method: target.method,
        path: target.path,
        round: round + 1,
        index: i + 1,
        total: toolCalls.length,
      });

      const startedAt = Date.now();
      const result = await handler(rawArgs);
      const event = {
        phase: "result",
        toolName,
        toolCallId,
        method: target.method,
        path: target.path,
        round: round + 1,
        index: i + 1,
        total: toolCalls.length,
        ok: Boolean(result?.ok),
        status: Number.isFinite(Number(result?.status)) ? Number(result.status) : undefined,
        error: trim(result?.error),
        durationMs: Date.now() - startedAt,
      };
      toolEvents.push(event);
      toolResults.push({
        toolName,
        toolCallId,
        ok: Boolean(result?.ok),
        status: Number.isFinite(Number(result?.status)) ? Number(result.status) : undefined,
        text: buildToolResultText(result),
        round: round + 1,
        index: i + 1,
        total: toolCalls.length,
      });
      await emitToolEvent(params?.onToolEvent, event);
      messages.push(buildToolResultMessage(toolCall, result));
    }
  }

  if (!response) {
    throw new Error("Model API returned no response.");
  }

  const text = extractResponseText(response);
  if (!text) {
    throw new Error("Model API returned no text output.");
  }

  return {
    text,
    payload: response,
    toolEvents,
    toolResults,
    usage,
  };
}
