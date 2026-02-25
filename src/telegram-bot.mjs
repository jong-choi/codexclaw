import { requestCodexResponse } from "./codex-api.mjs";
import {
  appendConversationTurn,
  clearConversationHistory,
  countConversationMessages,
  getConversationHistory,
  loadConversationStore,
  saveConversationStore,
} from "./conversation-store.mjs";
import { loadConfig, saveConfig } from "./config-store.mjs";
import {
  CODEX_PROVIDER_ID,
  OLLAMA_PROVIDER_ID,
  QWEN_PROVIDER_ID,
  TELEGRAM_API_BASE_URL,
} from "./constants.mjs";
import {
  assignProviderConnection,
  assignModelSelection,
  assignProviderOAuth,
  ensureProviderState,
  listModelProviders,
  normalizeProviderModelId,
  providerRequiresOAuth,
  providerSupportsUsageSnapshot,
  resolveConfiguredProviderId,
  resolveProviderConnection,
  resolveModelRef,
  resolveProviderModelIds,
  resolveProviderOAuth,
  resolveProviderShortLabel,
} from "./model-provider.mjs";
import {
  buildOllamaEndpointHintLines,
  deleteOllamaModel,
  listOllamaModels,
  normalizeOllamaBaseUrl,
  pullOllamaModel,
  resolveOllamaBaseUrlFromConfig,
} from "./ollama.mjs";
import {
  beginQwenDeviceOAuth,
  createCodexCallbackOAuthSession,
  pollQwenDeviceOAuth,
  resolveFreshProviderAccessToken,
} from "./oauth.mjs";
import { buildPairingReply } from "./pairing-messages.mjs";
import {
  approveChannelPairingCode,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "./pairing-store.mjs";
import {
  claimDueScheduledJobs,
  markScheduledJobCompleted,
  markScheduledJobFailed,
  resolveSecondsUntilNextScheduledJob,
} from "./schedule-store.mjs";
import { resolveWorkspaceRoot, resolveWorkspaceTemplateRoot } from "./workspace.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

function resolveRuntimeWorkspaceRoot(config) {
  const fromEnv = trim(process.env.CODEXCLAW_WORKSPACE_ROOT);
  if (fromEnv) {
    return resolveWorkspaceRoot(fromEnv);
  }
  return resolveWorkspaceRoot(trim(config?.workspace?.root));
}

function resolveRuntimeWorkspaceTemplateRoot(config) {
  const fromEnv = trim(process.env.CODEXCLAW_WORKSPACE_TEMPLATE_ROOT);
  if (fromEnv) {
    return resolveWorkspaceTemplateRoot(fromEnv);
  }
  return resolveWorkspaceTemplateRoot(trim(config?.workspace?.templateRoot));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_STATUS_TEXT_CHARS = 3900;
const PROACTIVE_STATUS_INTERVAL_MS = 10_000;
const PROACTIVE_STATUS_QUIET_AFTER_TOOL_MS = 8_000;
const CODEX_USAGE_API_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_TIMEOUT_MS = 6_000;
const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];

const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show quick help" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Reset context for this chat" },
  { command: "context", description: "Show stored context message count" },
  { command: "usage", description: "Show usage limits (Codex only)" },
  { command: "think", description: "Show or set reasoning effort" },
  { command: "provider", description: "Show or switch provider (/provider <id|alias|number>)" },
  { command: "models", description: "List available models for current provider" },
  { command: "model", description: "Show or switch model (/model <id|number>)" },
  { command: "ollama", description: "Manage Ollama models (/ollama list|pull|rm)" },
];

const PROVIDER_CANCEL_TOKENS = new Set(["cancel", "abort", "stop"]);
const PROVIDER_ALIAS_TO_ID = new Map([
  ["codex", CODEX_PROVIDER_ID],
  ["openai", CODEX_PROVIDER_ID],
  ["openai-codex", CODEX_PROVIDER_ID],
  ["openai_codex", CODEX_PROVIDER_ID],
  ["qwen", QWEN_PROVIDER_ID],
  ["qwen-portal", QWEN_PROVIDER_ID],
  ["qwen_portal", QWEN_PROVIDER_ID],
  ["ollama", OLLAMA_PROVIDER_ID],
]);

function isInlineExitCommand(value) {
  const token = trim(value).toLowerCase();
  return token === "bye" || token === "exit" || token === "/bye" || token === "/exit";
}

function startInlinePairingApproval(params) {
  const configPath = params?.configPath;
  const onExitRequest = typeof params?.onExitRequest === "function" ? params.onExitRequest : null;
  if (!process.stdin || !process.stdin.isTTY) {
    process.stdout.write("Inline pairing input disabled (non-interactive terminal).\n");
    return () => {};
  }

  process.stdout.write(
    "Enter pairing code in this terminal and press Enter to approve sender (empty line = ignore, bye/exit = stop bot).\n",
  );

  process.stdin.setEncoding("utf8");
  let buffer = "";
  const queue = [];
  let processing = false;

  const processQueue = async () => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      while (queue.length > 0) {
        const raw = queue.shift();
        const line = trim(raw);
        if (!line) {
          continue;
        }
        if (isInlineExitCommand(line)) {
          onExitRequest?.();
          break;
        }
        const code = line.toUpperCase();

        try {
          const approved = await approveChannelPairingCode({
            channel: "telegram",
            code,
            configPath,
          });
          if (!approved) {
            process.stdout.write(`No pending pairing request found for code: ${code}\n`);
            continue;
          }
          process.stdout.write(`Approved telegram sender ${approved.id}.\n`);
        } catch (error) {
          process.stderr.write(`Pairing approve failed: ${trim(error?.message) || String(error)}\n`);
        }
      }
    } finally {
      processing = false;
    }
  };

  const onData = (chunk) => {
    buffer += String(chunk ?? "");
    while (true) {
      const next = buffer.indexOf("\n");
      if (next < 0) {
        break;
      }
      let line = buffer.slice(0, next);
      buffer = buffer.slice(next + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      queue.push(line);
    }
    void processQueue();
  };

  process.stdin.on("data", onData);

  return () => {
    process.stdin.off("data", onData);
  };
}

function normalizeAllowToken(value) {
  const raw = trim(value).toLowerCase();
  if (!raw) {
    return "";
  }
  if (raw === "*") {
    return "*";
  }

  let next = raw;
  if (next.startsWith("telegram:")) {
    next = next.slice("telegram:".length);
  } else if (next.startsWith("tg:")) {
    next = next.slice("tg:".length);
  }

  return trim(next);
}

function normalizeAllowList(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .map((value) => normalizeAllowToken(value))
        .filter(Boolean),
    ),
  );
}

function canUseSender(senderId, allowFrom) {
  if (!Array.isArray(allowFrom) || allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSender = trim(senderId);
  if (!normalizedSender) {
    return false;
  }
  return allowFrom.includes(normalizedSender);
}

async function telegramApi(token, method, body, options = {}) {
  const url = `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: options?.signal,
  });

  let payload = null;
  let rawText = "";
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const description = trim(payload?.description) || trim(rawText);
    throw new Error(
      `Telegram HTTP error (${response.status})${description ? `: ${description}` : ""}`,
    );
  }

  if (!payload?.ok) {
    throw new Error(`Telegram API error: ${trim(payload?.description) || "unknown"}`);
  }

  return payload.result;
}

async function sendMessage(token, chatId, text) {
  const message = trim(text);
  if (!message) {
    return null;
  }
  return await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
  });
}

async function editMessage(token, chatId, messageId, text) {
  const message = trim(text);
  const numericMessageId = Number(messageId);
  if (!message || !Number.isInteger(numericMessageId)) {
    return null;
  }
  return await telegramApi(token, "editMessageText", {
    chat_id: chatId,
    message_id: numericMessageId,
    text: message,
  });
}

function extractTelegramMessageId(payload) {
  const value = Number(payload?.message_id);
  return Number.isInteger(value) ? value : null;
}

function isMessageNotModifiedError(error) {
  return /message is not modified/i.test(trim(error?.message));
}

async function sendTyping(token, chatId) {
  await telegramApi(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

function startTypingHeartbeat(token, chatId, intervalMs = 4_500) {
  const timer = setInterval(() => {
    void sendTyping(token, chatId).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return () => clearInterval(timer);
}

async function getUpdates(token, offset, signal, timeoutSeconds = 30) {
  const timeout = Number.isFinite(Number(timeoutSeconds))
    ? Math.max(1, Math.min(30, Math.floor(Number(timeoutSeconds))))
    : 30;
  return await telegramApi(
    token,
    "getUpdates",
    {
      timeout,
      offset,
      allowed_updates: ["message"],
    },
    { signal },
  );
}

async function clearWebhook(token) {
  return await telegramApi(token, "deleteWebhook", {
    drop_pending_updates: false,
  });
}

async function syncTelegramCommandMenu(token) {
  return await telegramApi(token, "setMyCommands", {
    commands: TELEGRAM_BOT_COMMANDS,
  });
}

function normalizeReasoningEffort(value) {
  const raw = trim(value).toLowerCase();
  if (!raw) {
    return "";
  }
  if (raw === "off") {
    return "none";
  }
  const collapsed = raw.replaceAll("_", "").replaceAll("-", "").replaceAll(" ", "");
  if (collapsed === "xhigh" || collapsed === "extrahigh") {
    return "xhigh";
  }
  return raw;
}

function resolveReasoningEffort(config) {
  const normalized = normalizeReasoningEffort(config?.codex?.reasoningEffort);
  if (REASONING_EFFORT_LEVELS.includes(normalized)) {
    return normalized;
  }
  return "none";
}

function parseFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampPercent(value) {
  const parsed = parseFiniteNumber(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  if (parsed < 0) {
    return 0;
  }
  if (parsed > 100) {
    return 100;
  }
  return parsed;
}

function resolveCodexAccountId(oauth) {
  if (!oauth || typeof oauth !== "object") {
    return "";
  }
  const candidates = [
    oauth.accountId,
    oauth.account_id,
    oauth.chatgptAccountId,
    oauth.chatgpt_account_id,
  ];
  for (const candidate of candidates) {
    const value = trim(candidate);
    if (value) {
      return value;
    }
  }
  return "";
}

function toResetAtMs(value) {
  const parsed = parseFiniteNumber(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  if (parsed > 1_000_000_000_000) {
    return Math.round(parsed);
  }
  return Math.round(parsed * 1000);
}

function formatWindowLabel(limitWindowSeconds, fallbackLabel) {
  const seconds = parseFiniteNumber(limitWindowSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return fallbackLabel;
  }
  const rounded = Math.round(seconds);
  if (rounded % 604800 === 0) {
    const weeks = Math.max(1, Math.round(rounded / 604800));
    return `${weeks}w`;
  }
  if (rounded % 86400 === 0) {
    const days = Math.max(1, Math.round(rounded / 86400));
    return `${days}d`;
  }
  if (rounded % 3600 === 0) {
    const hours = Math.max(1, Math.round(rounded / 3600));
    return `${hours}h`;
  }
  return `${Math.max(1, Math.round(rounded / 3600))}h`;
}

function formatResetRemaining(targetMs, now = Date.now()) {
  if (!Number.isFinite(targetMs) || targetMs <= 0) {
    return "";
  }
  const diffMs = targetMs - now;
  if (diffMs <= 0) {
    return "now";
  }
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) {
    return "<1m";
  }
  if (diffMins < 60) {
    return `${diffMins}m`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ${hours % 24}h`;
  }
  return new Date(targetMs).toISOString();
}

function normalizeCodexUsageSnapshot(rawPayload) {
  const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const rateLimit = payload.rate_limit && typeof payload.rate_limit === "object" ? payload.rate_limit : {};
  const primary = rateLimit.primary_window && typeof rateLimit.primary_window === "object" ? rateLimit.primary_window : null;
  const secondary =
    rateLimit.secondary_window && typeof rateLimit.secondary_window === "object"
      ? rateLimit.secondary_window
      : null;

  const windows = [];
  if (primary) {
    const usedPercent = clampPercent(primary.used_percent);
    windows.push({
      label: formatWindowLabel(primary.limit_window_seconds ?? 18_000, "5h"),
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetAt: toResetAtMs(primary.reset_at),
    });
  }
  if (secondary) {
    const usedPercent = clampPercent(secondary.used_percent);
    windows.push({
      label: formatWindowLabel(secondary.limit_window_seconds ?? 604_800, "1w"),
      usedPercent,
      remainingPercent: clampPercent(100 - usedPercent),
      resetAt: toResetAtMs(secondary.reset_at),
    });
  }

  let plan = trim(payload.plan_type);
  const credits = payload.credits && typeof payload.credits === "object" ? payload.credits : null;
  const balance = parseFiniteNumber(credits?.balance);
  if (Number.isFinite(balance)) {
    const formatted = `$${Number(balance).toFixed(2)}`;
    plan = plan ? `${plan} (${formatted})` : formatted;
  }

  return { plan, windows };
}

async function fetchCodexUsageSnapshot(params) {
  const accessToken = trim(params?.accessToken);
  if (!accessToken) {
    throw new Error("Missing Codex access token.");
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "CodexClaw",
  };
  const accountId = resolveCodexAccountId(params?.oauthCredentials);
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CODEX_USAGE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(CODEX_USAGE_API_URL, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  let payload = null;
  let rawText = "";
  try {
    rawText = await response.text();
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const description = trim(payload?.description) || trim(payload?.error) || trim(rawText);
    throw new Error(
      `Codex usage API error (${response.status})${description ? `: ${description}` : ""}`,
    );
  }

  return normalizeCodexUsageSnapshot(payload);
}

function formatCodexUsageLines(snapshot, now = Date.now()) {
  const lines = ["Codex usage limits"];
  if (trim(snapshot?.plan)) {
    lines.push(`Plan: ${trim(snapshot.plan)}`);
  }
  lines.push("");
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  if (windows.length === 0) {
    lines.push("- no window data returned by Codex API.");
    return lines;
  }
  for (const window of windows) {
    const reset = formatResetRemaining(window?.resetAt, now);
    const resetSuffix = reset ? ` · resets in ${reset}` : "";
    lines.push(
      `- ${trim(window?.label) || "window"}: ${Math.round(clampPercent(window?.remainingPercent))}% left${resetSuffix}`,
    );
  }
  return lines;
}

function buildUsageReport(snapshot) {
  return formatCodexUsageLines(snapshot).join("\n");
}

function formatCurrentModelRef(providerId, modelId) {
  return resolveModelRef(providerId, modelId) || "(not set)";
}

function buildModelStatusMessage(config, providerId, modelId, usageLines) {
  const providerShortLabel = resolveProviderShortLabel(providerId);
  const lines =
    Array.isArray(usageLines) && usageLines.length > 0
      ? usageLines
      : providerSupportsUsageSnapshot(providerId)
        ? ["Codex usage limits", "- unavailable"]
        : [`${providerShortLabel} usage limits`, "- unavailable (not provided by this API)."];
  const reasoningEffort = resolveReasoningEffort(config);
  return [
    `Current provider: ${providerShortLabel}`,
    `Current model: ${formatCurrentModelRef(providerId, modelId)}`,
    `Reasoning effort: ${reasoningEffort}`,
    "",
    ...lines,
    "",
    "Change model with /model <id|number>.",
    "Change reasoning with /think <none|minimal|low|medium|high|xhigh>.",
  ].join("\n");
}

async function resolveFreshProviderSessionAccess(params) {
  const providerId = trim(params?.providerId) || resolveConfiguredProviderId(params?.config);
  const fresh = await resolveFreshProviderAccessToken(providerId, params?.oauth);
  const oauth = fresh.credentials;
  if (fresh.changed) {
    assignProviderOAuth(params.config, providerId, oauth);
    params.config.telegram = {
      ...params.config.telegram,
      offset: params.offset,
    };
    await saveConfig(params.config, params.configPath);
  }
  return {
    accessToken: fresh.accessToken,
    oauth,
  };
}

function buildModelListMessage(params) {
  const providerId = trim(params?.providerId);
  const currentModelId = trim(params?.currentModelId);
  const modelIds = Array.isArray(params?.modelIds) ? params.modelIds : [];
  const providerShortLabel = resolveProviderShortLabel(providerId);
  const normalizedCurrent = normalizeProviderModelId(providerId, currentModelId);
  const lines = [`Available ${providerShortLabel} models:`];
  for (let i = 0; i < modelIds.length; i += 1) {
    const modelId = modelIds[i];
    const current = modelId === normalizedCurrent ? " (current)" : "";
    lines.push(`${i + 1}. ${resolveModelRef(providerId, modelId)}${current}`);
  }
  lines.push("");
  lines.push("Use /model <id|number> to switch.");
  const firstExample = modelIds[0] ? `/model ${modelIds[0]}` : "/model <id>";
  lines.push(`Examples: /model 1, ${firstExample}`);
  return lines.join("\n");
}

async function resolveProviderModelIdsRuntime(providerId, config) {
  const resolvedProviderId = trim(providerId);
  if (resolvedProviderId === OLLAMA_PROVIDER_ID) {
    const baseUrl = resolveOllamaBaseUrlFromConfig(config);
    return await listOllamaModels({ baseUrl });
  }
  return resolveProviderModelIds(resolvedProviderId);
}

function resolveModelSelection(params) {
  const providerId = trim(params?.providerId);
  const modelIds = Array.isArray(params?.modelIds) ? params.modelIds : [];
  const raw = trim(params?.value).toLowerCase();
  if (!raw) {
    return "";
  }

  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10);
    if (Number.isInteger(index) && index >= 1 && index <= modelIds.length) {
      return modelIds[index - 1];
    }
    return "";
  }

  let candidate = raw;
  if (candidate.includes("/")) {
    const slash = candidate.indexOf("/");
    const maybeProvider = trim(candidate.slice(0, slash));
    if (maybeProvider === providerId) {
      candidate = trim(candidate.slice(slash + 1));
    } else if (providerId !== OLLAMA_PROVIDER_ID) {
      candidate = candidate.slice(candidate.lastIndexOf("/") + 1);
    }
  }
  const normalized = normalizeProviderModelId(providerId, candidate);
  if (modelIds.includes(normalized)) {
    return normalized;
  }
  return "";
}

function resolveCommandToken(text) {
  const first = trim(text).split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first.startsWith("/")) {
    return "";
  }
  const at = first.indexOf("@");
  return at >= 0 ? first.slice(0, at) : first;
}

function resolveCommandArgs(text) {
  const raw = trim(text);
  const firstSpace = raw.indexOf(" ");
  if (firstSpace < 0) {
    return "";
  }
  return trim(raw.slice(firstSpace + 1));
}

function resolveProviderArgToken(value) {
  return trim(value).toLowerCase().split(/\s+/)[0] ?? "";
}

function isProviderCancelArg(value) {
  return PROVIDER_CANCEL_TOKENS.has(resolveProviderArgToken(value));
}

function resolveProviderSelection(value) {
  const token = resolveProviderArgToken(value);
  if (!token) {
    return "";
  }

  const providers = listModelProviders();
  if (/^\d+$/.test(token)) {
    const index = Number.parseInt(token, 10);
    if (Number.isInteger(index) && index >= 1 && index <= providers.length) {
      return providers[index - 1].id;
    }
    return "";
  }

  const aliased = PROVIDER_ALIAS_TO_ID.get(token);
  if (aliased) {
    return aliased;
  }

  for (const provider of providers) {
    if (trim(provider?.id).toLowerCase() === token) {
      return provider.id;
    }
  }
  return "";
}

function resolveProviderTargetModelId(providerId, currentModelId, modelIds) {
  const resolvedModelIds = Array.isArray(modelIds) ? modelIds : [];
  if (resolvedModelIds.length === 0) {
    return "";
  }
  const normalizedCurrent = normalizeProviderModelId(providerId, currentModelId);
  if (normalizedCurrent && resolvedModelIds.includes(normalizedCurrent)) {
    return normalizedCurrent;
  }
  return resolvedModelIds[0];
}

function resolveOllamaStatusSuffix(config) {
  const connection = resolveProviderConnection(config, OLLAMA_PROVIDER_ID);
  const baseUrl = trim(connection?.baseUrl);
  if (baseUrl) {
    return `endpoint ${baseUrl}`;
  }
  return "endpoint required";
}

function buildOllamaEndpointPrompt() {
  return [
    "Enter Ollama base URL as your next non-command message.",
    ...buildOllamaEndpointHintLines(),
    "Examples: http://ollama:11434, http://127.0.0.1:11434",
    "Use /provider cancel to abort.",
  ].join("\n");
}

function parseOllamaCommandArgs(text) {
  const raw = trim(text);
  const arg = resolveCommandArgs(raw);
  if (!arg) {
    return { command: "", value: "" };
  }
  const firstSpace = arg.indexOf(" ");
  if (firstSpace < 0) {
    return { command: arg.toLowerCase(), value: "" };
  }
  return {
    command: trim(arg.slice(0, firstSpace)).toLowerCase(),
    value: trim(arg.slice(firstSpace + 1)),
  };
}

function buildOllamaCommandHelp() {
  return [
    "Ollama commands:",
    "/ollama list",
    "/ollama pull <model>",
    "/ollama rm <model>",
    "",
    "Examples:",
    "/ollama pull gpt-oss:20b",
    "/ollama rm gpt-oss:20b",
  ].join("\n");
}

function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return "";
  }
  if (num < 1024) {
    return `${Math.round(num)} B`;
  }
  const kb = num / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

async function handleOllamaCommand(params) {
  const botToken = params?.botToken;
  const chatId = params?.chatId;
  const activeProviderId = params?.activeProviderId;
  const activeModelId = params?.activeModelId;
  const config = params?.config;
  const configPath = params?.configPath;
  const args = parseOllamaCommandArgs(params?.text);

  if (!args.command || args.command === "help") {
    await sendMessage(botToken, chatId, buildOllamaCommandHelp());
    return {
      handled: true,
      activeModelId,
    };
  }

  const baseUrl = resolveOllamaBaseUrlFromConfig(config);

  if (args.command === "list") {
    try {
      const models = await listOllamaModels({ baseUrl });
      if (models.length === 0) {
        await sendMessage(
          botToken,
          chatId,
          `No Ollama models found on ${baseUrl}.\nPull one first: /ollama pull gpt-oss:20b`,
        );
        return { handled: true, activeModelId };
      }
      const lines = [`Ollama models (${baseUrl}):`];
      const normalizedCurrent =
        activeProviderId === OLLAMA_PROVIDER_ID
          ? normalizeProviderModelId(OLLAMA_PROVIDER_ID, activeModelId)
          : "";
      for (let i = 0; i < models.length; i += 1) {
        const model = models[i];
        const current = model === normalizedCurrent ? " (current)" : "";
        lines.push(`${i + 1}. ${model}${current}`);
      }
      lines.push("");
      lines.push("Use /model <id|number> after switching provider to ollama.");
      await sendMessage(botToken, chatId, lines.join("\n"));
    } catch (error) {
      await sendMessage(
        botToken,
        chatId,
        `Failed to list Ollama models: ${trim(error?.message) || "unknown error"}`,
      );
    }
    return {
      handled: true,
      activeModelId,
    };
  }

  if (args.command === "pull") {
    const model = trim(args.value);
    if (!model) {
      await sendMessage(
        botToken,
        chatId,
        ["Missing model name.", "Usage: /ollama pull <model>", "Example: /ollama pull gpt-oss:20b"].join("\n"),
      );
      return { handled: true, activeModelId };
    }

    const startMessage = await sendMessage(botToken, chatId, `Pulling Ollama model: ${model}`);
    const statusMessageId = extractTelegramMessageId(startMessage);
    let lastStatus = "";
    let lastStatusAt = 0;
    try {
      await pullOllamaModel({
        baseUrl,
        model,
        onProgress: async (event) => {
          const now = Date.now();
          const status = trim(event?.status) || "pulling";
          const parts = [status];
          if (Number.isFinite(Number(event?.completed)) && Number.isFinite(Number(event?.total))) {
            const completed = Number(event.completed);
            const total = Number(event.total);
            const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
            const progress = `${percent}% (${formatBytes(completed)}/${formatBytes(total) || total})`;
            parts.push(progress);
          }
          const nextStatus = parts.join(" · ");
          if (nextStatus === lastStatus || now - lastStatusAt < 1500) {
            return;
          }
          lastStatus = nextStatus;
          lastStatusAt = now;
          if (Number.isInteger(statusMessageId)) {
            await editMessage(botToken, chatId, statusMessageId, `Pulling ${model}\n${nextStatus}`).catch(
              () => {},
            );
          }
        },
      });
      const models = await listOllamaModels({ baseUrl });
      let nextActiveModelId = activeModelId;
      if (activeProviderId === OLLAMA_PROVIDER_ID) {
        const normalizedCurrent = normalizeProviderModelId(OLLAMA_PROVIDER_ID, activeModelId);
        if (!normalizedCurrent || !models.includes(normalizedCurrent)) {
          const fallbackModel = models.includes(model) ? model : models[0];
          if (fallbackModel) {
            assignModelSelection(config, OLLAMA_PROVIDER_ID, fallbackModel);
            nextActiveModelId = fallbackModel;
            config.telegram = {
              ...config.telegram,
            };
            await saveConfig(config, configPath);
          }
        }
      }
      await sendMessage(
        botToken,
        chatId,
        `Ollama pull completed: ${model}\nModels available: ${models.length}`,
      );
      return {
        handled: true,
        activeModelId: nextActiveModelId,
      };
    } catch (error) {
      await sendMessage(
        botToken,
        chatId,
        `Failed to pull model ${model}: ${trim(error?.message) || "unknown error"}`,
      );
      return { handled: true, activeModelId };
    }
  }

  if (args.command === "rm" || args.command === "remove" || args.command === "delete") {
    const model = trim(args.value);
    if (!model) {
      await sendMessage(
        botToken,
        chatId,
        ["Missing model name.", "Usage: /ollama rm <model>", "Example: /ollama rm gpt-oss:20b"].join("\n"),
      );
      return { handled: true, activeModelId };
    }
    try {
      await deleteOllamaModel({ baseUrl, model });
      const models = await listOllamaModels({ baseUrl });
      let nextActiveModelId = activeModelId;
      if (activeProviderId === OLLAMA_PROVIDER_ID) {
        const normalizedCurrent = normalizeProviderModelId(OLLAMA_PROVIDER_ID, activeModelId);
        if (normalizedCurrent === model && models.length > 0) {
          assignModelSelection(config, OLLAMA_PROVIDER_ID, models[0]);
          nextActiveModelId = models[0];
          await saveConfig(config, configPath);
        }
      }
      await sendMessage(
        botToken,
        chatId,
        `Deleted Ollama model: ${model}\nModels remaining: ${models.length}`,
      );
      return {
        handled: true,
        activeModelId: nextActiveModelId,
      };
    } catch (error) {
      await sendMessage(
        botToken,
        chatId,
        `Failed to delete model ${model}: ${trim(error?.message) || "unknown error"}`,
      );
      return { handled: true, activeModelId };
    }
  }

  await sendMessage(
    params?.botToken,
    params?.chatId,
    [`Unknown /ollama command: ${args.command}`, "", buildOllamaCommandHelp()].join("\n"),
  );
  return {
    handled: true,
    activeModelId,
  };
}

function buildProviderPendingMessage(pending) {
  if (!pending) {
    return "";
  }
  if (pending.kind === "codex-callback") {
    return "Paste callback URL as your next non-command message, or run /provider cancel.";
  }
  if (pending.kind === "ollama-base-url") {
    return "Send Ollama base URL as your next non-command message, or run /provider cancel.";
  }
  return "Complete browser approval, or run /provider cancel.";
}

function buildProviderCommandMessage(params) {
  const providers = listModelProviders();
  const currentProviderId = trim(params?.providerId) || resolveConfiguredProviderId(params?.config);
  const currentModelId = trim(params?.modelId);
  const pending = params?.pendingProviderOAuth;
  const chatId = trim(params?.chatId);
  const senderId = trim(params?.senderId);
  const ownsPending =
    pending &&
    trim(pending?.chatId) === chatId &&
    trim(pending?.senderId) === senderId;

  const lines = [
    `Current provider: ${resolveProviderShortLabel(currentProviderId)} (${currentProviderId})`,
    `Current model: ${formatCurrentModelRef(currentProviderId, currentModelId)}`,
    `Reasoning effort: ${resolveReasoningEffort(params?.config)}`,
    "",
  ];

  if (pending) {
    const pendingProviderLabel = resolveProviderShortLabel(pending.providerId);
    const ownerLabel = ownsPending ? "this chat" : `chat ${trim(pending.chatId) || "unknown"}`;
    lines.push(`Pending provider setup: ${pendingProviderLabel} (${ownerLabel})`);
    if (ownsPending) {
      lines.push(buildProviderPendingMessage(pending));
    } else {
      lines.push("Another session is already running provider setup.");
    }
    lines.push("");
  }

  lines.push("Available providers:");
  for (let i = 0; i < providers.length; i += 1) {
    const provider = providers[i];
    const current = provider.id === currentProviderId ? " (current)" : "";
    const status = providerRequiresOAuth(provider.id)
      ? Boolean(resolveProviderOAuth(params?.config, provider.id)?.access)
        ? "oauth ready"
        : "oauth required"
      : resolveOllamaStatusSuffix(params?.config);
    lines.push(`${i + 1}. ${provider.shortLabel} (${provider.id})${current} - ${status}`);
  }
  lines.push("");
  lines.push("Usage:");
  lines.push("/provider");
  lines.push("/provider <id|alias|number>");
  lines.push("/provider cancel");
  lines.push("Aliases: codex, openai, qwen, ollama");
  return lines.join("\n");
}

function buildProviderUpdatedMessage(config, providerId, modelId, unchanged = false) {
  const connection = providerId === OLLAMA_PROVIDER_ID ? resolveProviderConnection(config, providerId) : null;
  const endpointLine =
    providerId === OLLAMA_PROVIDER_ID && trim(connection?.baseUrl)
      ? `Ollama endpoint: ${trim(connection.baseUrl)}`
      : null;
  return [
    unchanged ? "Provider unchanged." : "Provider updated.",
    `Current provider: ${resolveProviderShortLabel(providerId)} (${providerId})`,
    `Current model: ${formatCurrentModelRef(providerId, modelId)}`,
    endpointLine,
    `Reasoning effort: ${resolveReasoningEffort(config)}`,
    "Use /models and /model <id|number> to manage model selection.",
  ]
    .filter(Boolean)
    .join("\n");
}

function isResetCommand(token) {
  return token === "/new" || token === "/clear" || token === "/reset";
}

function isHelpCommand(token) {
  return token === "/help" || token === "/commands";
}

function isReasoningCommand(token) {
  return (
    token === "/think" ||
    token === "/thinking" ||
    token === "/t" ||
    token === "/reasoning" ||
    token === "/reason"
  );
}

function isKnownChatCommand(token) {
  return (
    token === "/start" ||
    isHelpCommand(token) ||
    isResetCommand(token) ||
    token === "/context" ||
    token === "/usage" ||
    isReasoningCommand(token) ||
    token === "/provider" ||
    token === "/models" ||
    token === "/model" ||
    token === "/ollama"
  );
}

function buildHelpMessage(providerId) {
  const providerShortLabel = resolveProviderShortLabel(providerId);
  const providerModelIds = resolveProviderModelIds(providerId);
  const exampleModel =
    providerModelIds[0] || (providerId === OLLAMA_PROVIDER_ID ? "gpt-oss:20b" : "<id>");
  return [
    "CodexClaw Telegram commands",
    "",
    "/help - Show this command guide.",
    "/new (/clear, /reset) - Reset context for this chat.",
    "/context - Show stored context message count.",
    "/usage - Show live usage limits (Codex only).",
    "/think <level> - Set reasoning effort.",
    "/provider - Show provider status and pending setup state.",
    "/provider <id|alias|number> - Switch provider (OAuth or Ollama endpoint setup).",
    "/provider cancel - Cancel pending provider setup request.",
    "/models - List available models for current provider.",
    `/model - Show current provider/model (${providerShortLabel}) + reasoning + usage summary.`,
    "/model <id|number> - Switch model immediately.",
    "/ollama list|pull|rm - Manage Ollama models.",
    "",
    `Reasoning levels: ${REASONING_EFFORT_LEVELS.join(", ")}`,
    "Think aliases: /thinking, /reasoning, /reason, /t",
    "",
    "Examples:",
    "/provider qwen",
    "/provider ollama",
    "/provider 1",
    "/provider cancel",
    "/think medium",
    "/model 1",
    `/model ${exampleModel}`,
    "/ollama pull gpt-oss:20b",
    "",
    "If a command fails, run /help and follow the exact format above.",
  ].join("\n");
}

function resolveConversationSessionId(message) {
  const chatId = trim(message?.chat?.id);
  if (!chatId) {
    return "";
  }
  const chatType = trim(message?.chat?.type).toLowerCase();
  const senderId = trim(message?.from?.id);
  const threadId = trim(message?.message_thread_id);
  const base =
    !chatType || chatType === "private"
      ? `dm:${senderId || chatId}`
      : `chat:${chatId}:sender:${senderId || "unknown"}`;
  return threadId ? `${base}:thread:${threadId}` : base;
}

function resolveStatusLocale(text) {
  return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(trim(text)) ? "ko" : "en";
}

function truncateStatusText(value) {
  const text = trim(value);
  if (!text) {
    return "";
  }
  if (text.length <= MAX_STATUS_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_STATUS_TEXT_CHARS - 12)}\n...[truncated]`;
}

function formatElapsedSeconds(elapsedMs) {
  const ms = Number(elapsedMs);
  if (!Number.isFinite(ms) || ms < 0) {
    return 0;
  }
  return Math.max(0, Math.round(ms / 1000));
}

function buildInitialStatus(locale) {
  if (locale === "ko") {
    return "요청 수신\n상태: 처리 시작";
  }
  return "Request received\nstatus: processing";
}

function buildWorkingStatus(locale, elapsedMs) {
  const seconds = formatElapsedSeconds(elapsedMs);
  if (locale === "ko") {
    return `상태: 처리 중 (${seconds}s)`;
  }
  return `status: processing (${seconds}s)`;
}

function buildCompletedStatus(locale, elapsedMs) {
  const seconds = formatElapsedSeconds(elapsedMs);
  if (locale === "ko") {
    return `상태: 완료 (${seconds}s)`;
  }
  return `status: completed (${seconds}s)`;
}

function buildFailedStatus(locale, elapsedMs) {
  const seconds = formatElapsedSeconds(elapsedMs);
  if (locale === "ko") {
    return `상태: 실패 (${seconds}s)`;
  }
  return `status: failed (${seconds}s)`;
}

function formatToolTarget(event) {
  return [trim(event?.method), trim(event?.path)].filter(Boolean).join(" ");
}

function buildToolRunningStatus(event, locale) {
  const target = formatToolTarget(event) || trim(event?.toolName) || "tool";
  if (event?.phase === "start") {
    if (locale === "ko") {
      return `스킬 호출 진행 중 (${event.index ?? 1}/${event.total ?? 1})\n${target}`;
    }
    return `Skill call in progress (${event.index ?? 1}/${event.total ?? 1})\n${target}`;
  }
  const status = event?.ok ? (locale === "ko" ? "성공" : "ok") : locale === "ko" ? "실패" : "failed";
  const statusCode = Number.isFinite(Number(event?.status)) ? ` (${Number(event.status)})` : "";
  if (locale === "ko") {
    return `스킬 호출 ${status}${statusCode}\n${target}`;
  }
  return `Skill call ${status}${statusCode}\n${target}`;
}

function buildToolSummary(toolEvents, locale) {
  const events = Array.isArray(toolEvents) ? toolEvents.filter((entry) => entry && typeof entry === "object") : [];
  if (events.length === 0) {
    return "";
  }
  const success = events.filter((entry) => entry.ok).length;
  const fail = events.length - success;
  const lines =
    locale === "ko"
      ? ["스킬 실행 로그", `호출: ${events.length}회 (성공 ${success}, 실패 ${fail})`]
      : ["Skill execution log", `calls: ${events.length} (ok ${success}, failed ${fail})`];
  const listed = events.slice(0, 4);
  for (const entry of listed) {
    const target = formatToolTarget(entry) || trim(entry?.toolName) || "tool";
    const statusCode = Number.isFinite(Number(entry?.status)) ? ` (${Number(entry.status)})` : "";
    const duration =
      Number.isFinite(Number(entry?.durationMs)) && Number(entry.durationMs) >= 0
        ? `, ${Math.round(Number(entry.durationMs))}ms`
        : "";
    const error =
      !entry?.ok && trim(entry?.error)
        ? locale === "ko"
          ? `, 오류: ${trim(entry.error)}`
          : `, error: ${trim(entry.error)}`
        : "";
    lines.push(
      `- ${target}: ${
        entry?.ok ? (locale === "ko" ? "성공" : "ok") : locale === "ko" ? "실패" : "failed"
      }${statusCode}${duration}${error}`,
    );
  }
  if (events.length > listed.length) {
    lines.push(
      locale === "ko"
        ? `- ... 외 ${events.length - listed.length}건`
        : `- ... and ${events.length - listed.length} more`,
    );
  }
  return lines.join("\n");
}

function buildToolContextHistoryTexts(toolResults) {
  const rows = Array.isArray(toolResults)
    ? toolResults.filter((entry) => entry && typeof entry === "object")
    : [];
  if (rows.length === 0) {
    return [];
  }
  return rows.map((entry) => {
    const toolName = trim(entry?.toolName) || "tool";
    const toolCallId = trim(entry?.toolCallId);
    const status = entry?.ok ? "ok" : "failed";
    const header = `[tool_result] ${toolName}${toolCallId ? ` (${toolCallId})` : ""} status=${status}`;
    const body = trim(entry?.text);
    return body ? `${header}\n${body}` : header;
  });
}

function resolveProactiveStatusEnabled(config) {
  if (typeof config?.telegram?.proactiveStatus === "boolean") {
    return config.telegram.proactiveStatus;
  }
  return true;
}

function formatErrorAsJson(error) {
  const payload = {
    name: trim(error?.name) || "Error",
    message: trim(error?.message) || String(error),
  };
  if (trim(error?.stack)) {
    payload.stack = trim(error.stack);
  }
  if (error?.cause !== undefined) {
    payload.cause =
      error.cause && typeof error.cause === "object"
        ? {
            name: trim(error.cause?.name),
            message: trim(error.cause?.message) || String(error.cause),
            code: trim(error.cause?.code),
            errno: error.cause?.errno,
            syscall: trim(error.cause?.syscall),
            hostname: trim(error.cause?.hostname),
          }
        : String(error.cause);
  }
  return JSON.stringify(payload);
}

function buildScheduledTriggerPrompt(job) {
  return [
    "[Scheduled task trigger]",
    `scheduled_at_utc: ${trim(job?.runAt)}`,
    `current_utc: ${new Date().toISOString()}`,
    `instruction: ${trim(job?.prompt)}`,
    "Generate the message to send now.",
  ].join("\n");
}

async function runDueScheduledJobs(params) {
  let oauth = params?.oauth;
  let conversationStore = params?.conversationStore;
  let conversationStoreDirty = false;

  const dueJobs = await claimDueScheduledJobs({
    customConfigPath: params?.configPath,
    channel: "telegram",
    limit: 3,
  });
  if (!Array.isArray(dueJobs) || dueJobs.length === 0) {
    return {
      oauth,
      conversationStore,
      conversationStoreDirty,
    };
  }

  process.stdout.write(`Running ${dueJobs.length} scheduled task(s).\n`);

  for (const job of dueJobs) {
    const chatId = trim(job?.chatId);
    const sessionId = trim(job?.sessionId);
    const scheduledPrompt = buildScheduledTriggerPrompt(job);
    if (!chatId || !sessionId || !scheduledPrompt) {
      await markScheduledJobFailed({
        customConfigPath: params?.configPath,
        jobId: job?.id,
        error: "Invalid scheduled job payload.",
      });
      continue;
    }

    try {
      await sendTyping(params?.botToken, chatId).catch(() => {});
      const fresh = await resolveFreshProviderAccessToken(params?.providerId, oauth);
      oauth = fresh.credentials;

      if (fresh.changed) {
        assignProviderOAuth(params.config, params?.providerId, oauth);
        await saveConfig(params.config, params.configPath);
      }

      const now = Date.now();
      const history = getConversationHistory(conversationStore, sessionId);
      const response = await requestCodexResponse({
        accessToken: fresh.accessToken,
        providerId: params?.providerId,
        modelId: params?.modelId,
        providerConnection: resolveProviderConnection(params?.config, params?.providerId),
        reasoningEffort: resolveReasoningEffort(params?.config),
        instructions: params?.codexInstructions,
        workspaceRoot: resolveRuntimeWorkspaceRoot(params?.config),
        workspaceTemplateRoot: resolveRuntimeWorkspaceTemplateRoot(params?.config),
        isFirstTurn: false,
        messages: [
          ...history,
          {
            role: "user",
            content: scheduledPrompt,
            timestamp: now,
          },
        ],
        skills: params?.config?.skills,
        runtime: {
          channel: "telegram",
          chatId,
          sessionId,
        },
        configPath: params?.configPath,
      });

      await sendMessage(params?.botToken, chatId, response.text);
      const toolContextTexts = buildToolContextHistoryTexts(response?.toolResults);
      conversationStore = appendConversationTurn({
        store: conversationStore,
        sessionId,
        userText: `[scheduled] ${trim(job?.prompt)}`,
        assistantText: response.text,
        toolContextTexts,
      });
      conversationStoreDirty = true;

      await markScheduledJobCompleted({
        customConfigPath: params?.configPath,
        jobId: job?.id,
      });
    } catch (error) {
      await markScheduledJobFailed({
        customConfigPath: params?.configPath,
        jobId: job?.id,
        error: trim(error?.message) || String(error),
      });
      process.stderr.write(
        `Scheduled task failed (${trim(job?.id)}): ${trim(error?.message) || String(error)}\n`,
      );
    }
  }

  return {
    oauth,
    conversationStore,
    conversationStoreDirty,
  };
}

export async function runTelegramBot(options = {}) {
  const loaded = await loadConfig(options.configPath);
  const configPath = loaded.path;
  const config = loaded.config;

  if (!config) {
    throw new Error(`Config not found at ${configPath}. Run \`codexclaw onboard\` first.`);
  }

  const botToken = trim(config?.telegram?.botToken);
  if (!botToken) {
    throw new Error("telegram.botToken is missing. Run `codexclaw onboard`.");
  }

  const providerState = ensureProviderState(config);
  if (providerState.changed) {
    await saveConfig(config, configPath);
  }

  let activeProviderId = providerState.providerId;
  let activeModelId = providerState.modelId;
  if (!activeModelId) {
    if (activeProviderId === OLLAMA_PROVIDER_ID) {
      process.stdout.write(
        "No Ollama model selected yet. Use /ollama pull gpt-oss:20b and /model <id|number> in Telegram.\n",
      );
    } else {
      throw new Error("model selection is missing. Run `codexclaw onboard`.");
    }
  }

  let oauth = resolveProviderOAuth(config, activeProviderId);
  if (providerRequiresOAuth(activeProviderId) && (!oauth || typeof oauth !== "object")) {
    throw new Error(`${resolveProviderShortLabel(activeProviderId)} OAuth is missing. Run \`codexclaw onboard\`.`);
  }

  const dmPolicy = trim(config?.telegram?.dmPolicy || "pairing").toLowerCase();
  if (!["pairing", "allowlist", "open", "disabled"].includes(dmPolicy)) {
    throw new Error(
      `Invalid telegram.dmPolicy: ${config?.telegram?.dmPolicy}. Use pairing|allowlist|open|disabled.`,
    );
  }
  let offset = Number(config?.telegram?.offset ?? 0);
  const codexInstructions = trim(config?.codex?.instructions);
  const proactiveStatusEnabled = resolveProactiveStatusEnabled(config);
  const conversationState = await loadConversationStore(configPath);
  let conversationStore = conversationState.store;
  let triedWebhookReset = false;
  let shouldStop = false;
  let pollingAbortController = null;
  let pendingProviderOAuth = null;
  const requestStop = () => {
    if (shouldStop) {
      return;
    }
    shouldStop = true;
    pollingAbortController?.abort();
    pollingAbortController = null;
    process.stdout.write("Exit command received. Stopping CodexClaw Telegram bot.\n");
    process.exit(0);
  };

  const ownsPendingProviderOAuth = (pending, chatId, senderId) => {
    if (!pending) {
      return false;
    }
    return trim(pending.chatId) === trim(chatId) && trim(pending.senderId) === trim(senderId);
  };

  const clearPendingProviderOAuth = (pending = null) => {
    if (!pending || pendingProviderOAuth === pending) {
      pendingProviderOAuth = null;
    }
  };

  const applyProviderSwitch = async ({ providerId, oauthCredentials, modelIds }) => {
    const nextProviderId = trim(providerId) || activeProviderId;
    const needsOAuth = providerRequiresOAuth(nextProviderId);
    const nextOauth =
      oauthCredentials && typeof oauthCredentials === "object" ? { ...oauthCredentials } : null;
    if (needsOAuth && (!nextOauth || !trim(nextOauth.access))) {
      throw new Error(`${resolveProviderShortLabel(nextProviderId)} OAuth credentials are missing.`);
    }

    const resolvedModelIds =
      Array.isArray(modelIds) && modelIds.length > 0
        ? modelIds
        : await resolveProviderModelIdsRuntime(nextProviderId, config);
    const nextModelId = resolveProviderTargetModelId(nextProviderId, activeModelId, resolvedModelIds);
    if (!nextModelId) {
      throw new Error(`No models are registered for provider ${nextProviderId}.`);
    }

    const unchanged = nextProviderId === activeProviderId && nextModelId === activeModelId;
    if (needsOAuth) {
      assignProviderOAuth(config, nextProviderId, nextOauth);
    } else {
      assignProviderOAuth(config, nextProviderId, null);
    }
    const modelAssigned = assignModelSelection(config, nextProviderId, nextModelId);
    if (!modelAssigned) {
      throw new Error(`Failed to assign model ${nextModelId} for provider ${nextProviderId}.`);
    }

    activeProviderId = nextProviderId;
    activeModelId = nextModelId;
    oauth = needsOAuth ? nextOauth : null;
    config.telegram = {
      ...config.telegram,
      offset,
    };
    await saveConfig(config, configPath);

    process.stdout.write(
      `${unchanged ? "Provider confirmed" : "Provider switched"}: ${
        resolveProviderShortLabel(activeProviderId)
      } (${activeProviderId}), model ${resolveModelRef(activeProviderId, activeModelId)}.\n`,
    );
    return {
      providerId: activeProviderId,
      modelId: activeModelId,
      unchanged,
    };
  };

  const startOllamaProviderSetup = async ({ providerId, chatId, senderId, initialBaseUrl }) => {
    const fallbackBaseUrl = resolveOllamaBaseUrlFromConfig(config);
    const pending = {
      kind: "ollama-base-url",
      providerId,
      chatId,
      senderId,
      suggestedBaseUrl: normalizeOllamaBaseUrl(initialBaseUrl || fallbackBaseUrl),
      canceled: false,
    };
    pendingProviderOAuth = pending;
    process.stdout.write(`Started Ollama provider setup for chat ${chatId} (sender ${senderId}).\n`);

    await sendMessage(
      botToken,
      chatId,
      [
        "Ollama provider setup started.",
        `Current endpoint: ${pending.suggestedBaseUrl}`,
        buildOllamaEndpointPrompt(),
      ].join("\n"),
    );
  };

  const startQwenProviderOAuth = async ({ providerId, chatId, senderId }) => {
    const started = await beginQwenDeviceOAuth();
    const pending = {
      kind: "qwen-device",
      providerId,
      chatId,
      senderId,
      verifier: started.verifier,
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUrl: started.verificationUrl,
      expiresAt: started.expiresAt,
      pollIntervalMs: started.pollIntervalMs,
      canceled: false,
    };
    pendingProviderOAuth = pending;
    process.stdout.write(
      `Started Qwen OAuth device flow for chat ${chatId} (sender ${senderId}).\n`,
    );

    await sendMessage(
      botToken,
      chatId,
      [
        "Qwen OAuth started.",
        `1) Open: ${pending.verificationUrl}`,
        `2) Enter code: ${pending.userCode}`,
        "After approval, provider switch completes automatically.",
        "Use /provider cancel to abort this request.",
      ].join("\n"),
    );

    void (async () => {
      let pollIntervalMs = pending.pollIntervalMs;
      while (pendingProviderOAuth === pending && !pending.canceled && Date.now() < pending.expiresAt) {
        await sleep(pollIntervalMs);
        if (pendingProviderOAuth !== pending || pending.canceled) {
          return;
        }

        let polled;
        try {
          polled = await pollQwenDeviceOAuth({
            deviceCode: pending.deviceCode,
            verifier: pending.verifier,
          });
        } catch (error) {
          if (pendingProviderOAuth !== pending) {
            return;
          }
          clearPendingProviderOAuth(pending);
          await sendMessage(
            botToken,
            chatId,
            `Qwen OAuth failed: ${trim(error?.message) || "polling error"}`,
          ).catch(() => {});
          return;
        }

        if (pendingProviderOAuth !== pending || pending.canceled) {
          return;
        }

        if (polled.status === "success") {
          clearPendingProviderOAuth(pending);
          try {
            const switched = await applyProviderSwitch({
              providerId,
              oauthCredentials: polled.token,
            });
            await sendMessage(
              botToken,
              chatId,
              buildProviderUpdatedMessage(
                config,
                switched.providerId,
                switched.modelId,
                switched.unchanged,
              ),
            ).catch(() => {});
          } catch (error) {
            await sendMessage(
              botToken,
              chatId,
              `Provider switch failed: ${trim(error?.message) || "unknown error"}`,
            ).catch(() => {});
          }
          return;
        }

        if (polled.status === "error") {
          clearPendingProviderOAuth(pending);
          await sendMessage(
            botToken,
            chatId,
            `Qwen OAuth failed: ${trim(polled.message) || "authorization error"}`,
          ).catch(() => {});
          return;
        }

        if (polled.slowDown) {
          pollIntervalMs = Math.min(Math.round(pollIntervalMs * 1.5), 10_000);
        }
      }

      if (pendingProviderOAuth === pending && !pending.canceled) {
        clearPendingProviderOAuth(pending);
        await sendMessage(
          botToken,
          chatId,
          "Qwen OAuth timed out. Run /provider qwen to start again.",
        ).catch(() => {});
      }
    })();
  };

  const startCodexProviderOAuth = async ({ providerId, chatId, senderId }) => {
    const pending = {
      kind: "codex-callback",
      providerId,
      chatId,
      senderId,
      callbackSubmitted: false,
      session: null,
    };
    pendingProviderOAuth = pending;
    process.stdout.write(`Started Codex callback OAuth flow for chat ${chatId} (sender ${senderId}).\n`);

    const session = createCodexCallbackOAuthSession({
      onAuthUrl: async (url) => {
        if (pendingProviderOAuth !== pending) {
          return;
        }
        try {
          await sendMessage(
            botToken,
            chatId,
            [
              "OpenAI Codex OAuth URL:",
              url,
              "",
              "Complete browser login, then paste the callback URL here as your next message.",
              "Use /provider cancel to abort this request.",
            ].join("\n"),
          );
        } catch (error) {
          process.stderr.write(
            `Failed to send Codex OAuth URL message: ${trim(error?.message) || String(error)}\n`,
          );
        }
      },
      onProgress: (message) => {
        const status = trim(message);
        if (status) {
          process.stdout.write(`Codex OAuth progress: ${status}\n`);
        }
      },
    });
    pending.session = session;

    await sendMessage(
      botToken,
      chatId,
      "Starting OpenAI Codex OAuth. Waiting for login URL...",
    );

    void (async () => {
      try {
        const credentials = await session.waitForCredentials();
        if (pendingProviderOAuth !== pending) {
          return;
        }
        clearPendingProviderOAuth(pending);
        const switched = await applyProviderSwitch({
          providerId,
          oauthCredentials: credentials,
        });
        await sendMessage(
          botToken,
          chatId,
          buildProviderUpdatedMessage(
            config,
            switched.providerId,
            switched.modelId,
            switched.unchanged,
          ),
        ).catch(() => {});
      } catch (error) {
        if (pendingProviderOAuth !== pending) {
          return;
        }
        clearPendingProviderOAuth(pending);
        await sendMessage(
          botToken,
          chatId,
          `OpenAI Codex OAuth failed: ${trim(error?.message) || "unknown error"}`,
        ).catch(() => {});
      }
    })();
  };

  process.stdout.write(`CodexClaw Telegram bot is running.\n`);
  process.stdout.write(
    `Provider: ${resolveProviderShortLabel(activeProviderId)} (${activeProviderId})\n`,
  );
  process.stdout.write(`Model: ${resolveModelRef(activeProviderId, activeModelId)}\n`);
  process.stdout.write(`DM policy: ${dmPolicy}\n`);
  process.stdout.write(`Proactive status: ${proactiveStatusEnabled ? "on" : "off"}\n`);
  process.stdout.write(`Conversation store: ${conversationState.path}\n`);
  if (dmPolicy === "pairing") {
    process.stdout.write("Unknown DM senders will receive a pairing code.\n");
  }
  const stopInlinePairingApproval =
    dmPolicy === "pairing" ? startInlinePairingApproval({ configPath, onExitRequest: requestStop }) : () => {};

  try {
    await syncTelegramCommandMenu(botToken);
    process.stdout.write(`Telegram command menu synced (${TELEGRAM_BOT_COMMANDS.length}).\n`);
  } catch (error) {
    process.stderr.write(
      `Telegram command menu sync failed: ${trim(error?.message) || String(error)}\n`,
    );
  }

  while (!shouldStop) {
    try {
      let conversationStoreDirty = false;
      const scheduledRun = await runDueScheduledJobs({
        botToken,
        providerId: activeProviderId,
        modelId: activeModelId,
        codexInstructions,
        config,
        configPath,
        oauth,
        conversationStore,
      });
      oauth = scheduledRun.oauth;
      conversationStore = scheduledRun.conversationStore;
      if (scheduledRun.conversationStoreDirty) {
        const savedConversations = await saveConversationStore(conversationStore, configPath);
        conversationStore = savedConversations.store;
      }

      const pollingTimeoutSeconds =
        (await resolveSecondsUntilNextScheduledJob({
          customConfigPath: configPath,
          channel: "telegram",
          maxSeconds: 30,
        })) ?? 30;

      pollingAbortController = new AbortController();
      const updates = await getUpdates(
        botToken,
        offset,
        pollingAbortController.signal,
        pollingTimeoutSeconds,
      );
      pollingAbortController = null;
      for (const update of updates) {
        if (shouldStop) {
          break;
        }
        const updateId = Number(update?.update_id);
        if (Number.isFinite(updateId)) {
          offset = Math.max(offset, updateId + 1);
        }

        const message = update?.message;
        const chatId = trim(message?.chat?.id);
        const chatType = trim(message?.chat?.type).toLowerCase();
        const isDirectMessage = !chatType || chatType === "private";
        const senderId = trim(message?.from?.id);
        const text = trim(message?.text);
        const command = resolveCommandToken(text);
        const sessionId = resolveConversationSessionId(message);

        if (!chatId || !text) {
          continue;
        }

        if (dmPolicy === "disabled") {
          continue;
        }

        const configAllowFrom = normalizeAllowList(config?.telegram?.allowFrom);
        const storeAllowFrom =
          dmPolicy === "allowlist" ? [] : await readChannelAllowFromStore("telegram", configPath);
        const effectiveAllowFrom = Array.from(new Set([...configAllowFrom, ...storeAllowFrom]));
        const senderAllowed = canUseSender(senderId, effectiveAllowFrom);

        if (dmPolicy !== "open" && !senderAllowed) {
          if (dmPolicy === "pairing" && isDirectMessage) {
            const senderUserId = trim(message?.from?.id);
            const senderUsername = trim(message?.from?.username);
            const senderFirstName = trim(message?.from?.first_name);
            const senderLastName = trim(message?.from?.last_name);
            const pairing = await upsertChannelPairingRequest({
              channel: "telegram",
              id: senderUserId || senderId || chatId,
              configPath,
              meta: {
                username: senderUsername,
                firstName: senderFirstName,
                lastName: senderLastName,
              },
            });
            if (pairing.created && pairing.code) {
              await sendMessage(
                botToken,
                chatId,
                buildPairingReply({
                  channel: "telegram",
                  idLine: `Your Telegram user id: ${senderUserId || senderId || chatId}`,
                  code: pairing.code,
                }),
              );
            }
          }
          continue;
        }

        const senderPendingProviderOAuth = ownsPendingProviderOAuth(
          pendingProviderOAuth,
          chatId,
          senderId,
        )
          ? pendingProviderOAuth
          : null;
        if (senderPendingProviderOAuth && command && command !== "/provider") {
          await sendMessage(
            botToken,
            chatId,
            [
              `${resolveProviderShortLabel(senderPendingProviderOAuth.providerId)} setup is in progress.`,
              buildProviderPendingMessage(senderPendingProviderOAuth),
            ].join("\n"),
          );
          continue;
        }

        if (senderPendingProviderOAuth && !command) {
          if (senderPendingProviderOAuth.kind === "codex-callback") {
            senderPendingProviderOAuth.session?.submitCallbackUrl(text);
            if (!senderPendingProviderOAuth.callbackSubmitted) {
              senderPendingProviderOAuth.callbackSubmitted = true;
              await sendMessage(
                botToken,
                chatId,
                "Callback URL received. Completing OpenAI Codex OAuth...",
              );
            }
          } else if (senderPendingProviderOAuth.kind === "ollama-base-url") {
            let normalizedBaseUrl;
            try {
              normalizedBaseUrl = normalizeOllamaBaseUrl(text);
            } catch (error) {
              await sendMessage(
                botToken,
                chatId,
                `Invalid Ollama URL: ${trim(error?.message) || "unknown error"}\n${buildOllamaEndpointPrompt()}`,
              );
              continue;
            }

            senderPendingProviderOAuth.suggestedBaseUrl = normalizedBaseUrl;
            let discoveredModels;
            try {
              discoveredModels = await listOllamaModels({ baseUrl: normalizedBaseUrl });
            } catch (error) {
              await sendMessage(
                botToken,
                chatId,
                `Failed to connect Ollama: ${trim(error?.message) || "unknown error"}\n${buildOllamaEndpointPrompt()}`,
              );
              continue;
            }

            if (!Array.isArray(discoveredModels) || discoveredModels.length === 0) {
              await sendMessage(
                botToken,
                chatId,
                [
                  `Connected to Ollama (${normalizedBaseUrl}) but no models were found.`,
                  "Pull a model first (example: /ollama pull gpt-oss:20b) and then send the URL again.",
                  "Use /provider cancel to abort.",
                ].join("\n"),
              );
              continue;
            }

            assignProviderConnection(config, OLLAMA_PROVIDER_ID, {
              baseUrl: normalizedBaseUrl,
            });
            try {
              const switched = await applyProviderSwitch({
                providerId: OLLAMA_PROVIDER_ID,
                oauthCredentials: null,
                modelIds: discoveredModels,
              });
              clearPendingProviderOAuth(senderPendingProviderOAuth);
              await sendMessage(
                botToken,
                chatId,
                buildProviderUpdatedMessage(
                  config,
                  switched.providerId,
                  switched.modelId,
                  switched.unchanged,
                ),
              );
            } catch (error) {
              await sendMessage(
                botToken,
                chatId,
                `Failed to activate Ollama provider: ${trim(error?.message) || "unknown error"}`,
              );
            }
          } else {
            await sendMessage(
              botToken,
              chatId,
              "Qwen OAuth is pending. Complete browser approval or run /provider cancel.",
            );
          }
          continue;
        }

        if (command === "/start") {
          const providerLabel = resolveProviderShortLabel(activeProviderId);
          await sendMessage(
            botToken,
            chatId,
            [
              `CodexClaw is connected. Send a message to talk to ${providerLabel}.`,
              "Use /help to see all available commands.",
              "Use /new to reset context for this chat.",
              "Use /context to inspect stored context size.",
              "Use /usage to inspect usage limits (Codex only).",
              "Use /think to inspect or set reasoning effort.",
              "Use /provider to inspect or switch provider.",
              "Use /models to list models, /model to inspect current model.",
              "Use /ollama list|pull|rm to manage Ollama models.",
            ].join("\n"),
          );
          continue;
        }

        if (isHelpCommand(command)) {
          await sendMessage(botToken, chatId, buildHelpMessage(activeProviderId));
          continue;
        }

        if (isResetCommand(command)) {
          conversationStore = clearConversationHistory(conversationStore, sessionId);
          conversationStoreDirty = true;
          await sendMessage(botToken, chatId, "Context cleared for this chat.");
          continue;
        }

        if (command === "/context") {
          const arg = resolveCommandArgs(text);
          if (arg) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Invalid usage: /context ${arg}`,
                "Usage: /context",
                "Tip: run /help to see all commands.",
              ].join("\n"),
            );
            continue;
          }
          const count = countConversationMessages(conversationStore, sessionId);
          await sendMessage(
            botToken,
            chatId,
            `Stored context messages for this chat: ${count}\nUse /new to reset context.`,
          );
          continue;
        }

        if (command === "/usage") {
          const arg = resolveCommandArgs(text);
          if (arg) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Invalid usage: /usage ${arg}`,
                "Usage: /usage",
                "Tip: run /help to see all commands.",
              ].join("\n"),
            );
            continue;
          }
          if (!providerSupportsUsageSnapshot(activeProviderId)) {
            await sendMessage(
              botToken,
              chatId,
              `${resolveProviderShortLabel(activeProviderId)} usage API is not available in this runtime.`,
            );
            continue;
          }
          try {
            const fresh = await resolveFreshProviderSessionAccess({
              providerId: activeProviderId,
              oauth,
              config,
              configPath,
              offset,
            });
            oauth = fresh.oauth;
            const snapshot = await fetchCodexUsageSnapshot({
              accessToken: fresh.accessToken,
              oauthCredentials: oauth,
            });
            await sendMessage(botToken, chatId, buildUsageReport(snapshot));
          } catch (error) {
            await sendMessage(
              botToken,
              chatId,
              `Usage lookup failed: ${trim(error?.message) || "unknown error"}`,
            );
          }
          continue;
        }

        if (isReasoningCommand(command)) {
          const arg = resolveCommandArgs(text);
          if (!arg) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Current reasoning effort: ${resolveReasoningEffort(config)}`,
                `Options: ${REASONING_EFFORT_LEVELS.join(", ")}`,
                "Set with /think <level>.",
              ].join("\n"),
            );
            continue;
          }
          const nextEffort = normalizeReasoningEffort(arg);
          if (!REASONING_EFFORT_LEVELS.includes(nextEffort)) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Invalid reasoning effort: ${trim(arg)}`,
                `Options: ${REASONING_EFFORT_LEVELS.join(", ")}`,
              ].join("\n"),
            );
            continue;
          }
          config.codex = {
            ...(config.codex ?? {}),
            reasoningEffort: nextEffort,
          };
          await saveConfig(config, configPath);
          await sendMessage(botToken, chatId, `Reasoning effort set to ${nextEffort}.`);
          continue;
        }

        if (command === "/provider") {
          const arg = resolveCommandArgs(text);
          if (!arg) {
            await sendMessage(
              botToken,
              chatId,
              buildProviderCommandMessage({
                config,
                providerId: activeProviderId,
                modelId: activeModelId,
                pendingProviderOAuth,
                chatId,
                senderId,
              }),
            );
            continue;
          }

          if (isProviderCancelArg(arg)) {
            const pending = pendingProviderOAuth;
            if (!pending) {
              await sendMessage(
                botToken,
                chatId,
                "No pending provider setup request.\nUse /provider to check current status.",
              );
              continue;
            }
            if (!ownsPendingProviderOAuth(pending, chatId, senderId)) {
              await sendMessage(
                botToken,
                chatId,
                "Another sender is handling provider setup right now. Wait for completion.",
              );
              continue;
            }
            clearPendingProviderOAuth(pending);
            pending.canceled = true;
            if (pending.kind === "codex-callback") {
              pending.session?.cancel("OAuth canceled by user.");
            }
            await sendMessage(
              botToken,
              chatId,
              `Canceled pending ${resolveProviderShortLabel(pending.providerId)} setup request.`,
            );
            continue;
          }

          const selectedProviderId = resolveProviderSelection(arg);
          if (!selectedProviderId) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Unknown provider: ${trim(arg)}`,
                "",
                buildProviderCommandMessage({
                  config,
                  providerId: activeProviderId,
                  modelId: activeModelId,
                  pendingProviderOAuth,
                  chatId,
                  senderId,
                }),
              ].join("\n"),
            );
            continue;
          }

          if (pendingProviderOAuth) {
            if (ownsPendingProviderOAuth(pendingProviderOAuth, chatId, senderId)) {
              await sendMessage(
                botToken,
                chatId,
                [
                  `${resolveProviderShortLabel(pendingProviderOAuth.providerId)} setup is already in progress.`,
                  buildProviderPendingMessage(pendingProviderOAuth),
                ].join("\n"),
              );
            } else {
              await sendMessage(
                botToken,
                chatId,
                "Another sender is already running provider setup. Wait for completion.",
              );
            }
            continue;
          }

          if (selectedProviderId === OLLAMA_PROVIDER_ID) {
            try {
              await startOllamaProviderSetup({
                providerId: selectedProviderId,
                chatId,
                senderId,
                initialBaseUrl: resolveProviderConnection(config, OLLAMA_PROVIDER_ID)?.baseUrl,
              });
            } catch (error) {
              clearPendingProviderOAuth();
              await sendMessage(
                botToken,
                chatId,
                `Failed to start Ollama setup: ${trim(error?.message) || "unknown error"}`,
              );
            }
            continue;
          }

          const selectedRequiresOAuth = providerRequiresOAuth(selectedProviderId);
          const existingOAuth = resolveProviderOAuth(config, selectedProviderId);
          if (selectedRequiresOAuth && existingOAuth && trim(existingOAuth.access)) {
            try {
              const switched = await applyProviderSwitch({
                providerId: selectedProviderId,
                oauthCredentials: existingOAuth,
              });
              await sendMessage(
                botToken,
                chatId,
                buildProviderUpdatedMessage(
                  config,
                  switched.providerId,
                  switched.modelId,
                  switched.unchanged,
                ),
              );
            } catch (error) {
              await sendMessage(
                botToken,
                chatId,
                `Provider switch failed: ${trim(error?.message) || "unknown error"}`,
              );
            }
            continue;
          }

          try {
            if (selectedProviderId === QWEN_PROVIDER_ID) {
              await startQwenProviderOAuth({
                providerId: selectedProviderId,
                chatId,
                senderId,
              });
            } else if (selectedProviderId === CODEX_PROVIDER_ID) {
              await startCodexProviderOAuth({
                providerId: selectedProviderId,
                chatId,
                senderId,
              });
            } else {
              await sendMessage(botToken, chatId, `Unsupported provider setup flow: ${selectedProviderId}`);
            }
          } catch (error) {
            clearPendingProviderOAuth();
            await sendMessage(
              botToken,
              chatId,
              `Failed to start provider setup: ${trim(error?.message) || "unknown error"}`,
            );
          }
          continue;
        }

        if (command === "/models") {
          const arg = resolveCommandArgs(text);
          if (arg) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Invalid usage: /models ${arg}`,
                "Usage: /models",
                "Tip: run /help to see all commands.",
              ].join("\n"),
            );
            continue;
          }
          try {
            const providerModelIds = await resolveProviderModelIdsRuntime(activeProviderId, config);
            if (!Array.isArray(providerModelIds) || providerModelIds.length === 0) {
              await sendMessage(
                botToken,
                chatId,
                `No models are available for ${resolveProviderShortLabel(activeProviderId)} right now.`,
              );
              continue;
            }
            await sendMessage(
              botToken,
              chatId,
              buildModelListMessage({
                providerId: activeProviderId,
                currentModelId: activeModelId,
                modelIds: providerModelIds,
              }),
            );
          } catch (error) {
            await sendMessage(
              botToken,
              chatId,
              `Failed to load model list: ${trim(error?.message) || "unknown error"}`,
            );
          }
          continue;
        }

        if (command === "/model") {
          const arg = resolveCommandArgs(text);
          if (!arg) {
            let usageLines = [
              `${resolveProviderShortLabel(activeProviderId)} usage limits`,
              "",
              "- unavailable (not provided by this API).",
            ];
            if (providerSupportsUsageSnapshot(activeProviderId)) {
              try {
                const fresh = await resolveFreshProviderSessionAccess({
                  providerId: activeProviderId,
                  oauth,
                  config,
                  configPath,
                  offset,
                });
                oauth = fresh.oauth;
                const snapshot = await fetchCodexUsageSnapshot({
                  accessToken: fresh.accessToken,
                  oauthCredentials: oauth,
                });
                usageLines = formatCodexUsageLines(snapshot);
              } catch (error) {
                usageLines = [
                  "Codex usage limits",
                  "",
                  `- unavailable (${trim(error?.message) || "unknown error"})`,
                ];
              }
            }
            await sendMessage(
              botToken,
              chatId,
              buildModelStatusMessage(config, activeProviderId, activeModelId, usageLines),
            );
            continue;
          }
          let providerModelIds = [];
          try {
            providerModelIds = await resolveProviderModelIdsRuntime(activeProviderId, config);
          } catch (error) {
            await sendMessage(
              botToken,
              chatId,
              `Failed to load models for selection: ${trim(error?.message) || "unknown error"}`,
            );
            continue;
          }
          const selectedModelId = resolveModelSelection({
            providerId: activeProviderId,
            modelIds: providerModelIds,
            value: arg,
          });
          if (!selectedModelId) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Unknown model: ${trim(arg)}`,
                "Usage: /model <id|number>",
                "Use /models to see valid options.",
                `Examples: /model 1, /model ${providerModelIds[0] || "<id>"}`,
              ].join("\n"),
            );
            continue;
          }
          if (selectedModelId === activeModelId) {
            await sendMessage(
              botToken,
              chatId,
              `Model unchanged: ${resolveModelRef(activeProviderId, activeModelId)}`,
            );
            continue;
          }
          activeModelId = selectedModelId;
          assignModelSelection(config, activeProviderId, selectedModelId);
          await saveConfig(config, configPath);
          process.stdout.write(
            `Model switched to ${resolveModelRef(activeProviderId, activeModelId)}.\n`,
          );
          await sendMessage(
            botToken,
            chatId,
            `Model updated: ${resolveModelRef(activeProviderId, activeModelId)}`,
          );
          continue;
        }

        if (command === "/ollama") {
          const handled = await handleOllamaCommand({
            text,
            botToken,
            chatId,
            activeProviderId,
            activeModelId,
            config,
            configPath,
          });
          if (handled?.activeModelId && handled.activeModelId !== activeModelId) {
            activeModelId = handled.activeModelId;
          }
          continue;
        }

        if (command && command.startsWith("/") && !isKnownChatCommand(command)) {
          await sendMessage(
            botToken,
            chatId,
            [
              `Unknown command: ${command}`,
              "Use /help to see available commands and exact usage.",
            ].join("\n"),
          );
          continue;
        }

        if (!activeModelId) {
          const guidance =
            activeProviderId === OLLAMA_PROVIDER_ID
              ? [
                  "No Ollama model is selected yet.",
                  "Run /ollama pull gpt-oss:20b, then /models and /model <id|number>.",
                ].join("\n")
              : [
                  `No model is selected for ${resolveProviderShortLabel(activeProviderId)}.`,
                  "Use /models and /model <id|number> first.",
                ].join("\n");
          await sendMessage(botToken, chatId, guidance);
          continue;
        }

        await sendTyping(botToken, chatId);
        let stopTypingHeartbeat = startTypingHeartbeat(botToken, chatId);
        const stopTypingNow = () => {
          stopTypingHeartbeat();
          stopTypingHeartbeat = () => {};
        };
        const requestStartedAt = Date.now();
        const locale = resolveStatusLocale(text);
        let statusMessageId = null;
        const seenToolEvents = [];
        let lastToolStatusAt = 0;
        const upsertStatus = async (statusText) => {
          const next = truncateStatusText(statusText);
          if (!next) {
            return;
          }
          if (statusMessageId === null) {
            const created = await sendMessage(botToken, chatId, next);
            statusMessageId = extractTelegramMessageId(created);
            return;
          }
          try {
            await editMessage(botToken, chatId, statusMessageId, next);
          } catch (error) {
            if (isMessageNotModifiedError(error)) {
              return;
            }
            statusMessageId = null;
          }
        };
        let stopProactivePulse = () => {};
        if (proactiveStatusEnabled) {
          await upsertStatus(buildInitialStatus(locale));
          const pulse = setInterval(() => {
            const quietSinceTool = Date.now() - lastToolStatusAt;
            if (lastToolStatusAt > 0 && quietSinceTool < PROACTIVE_STATUS_QUIET_AFTER_TOOL_MS) {
              return;
            }
            void upsertStatus(buildWorkingStatus(locale, Date.now() - requestStartedAt));
          }, PROACTIVE_STATUS_INTERVAL_MS);
          if (typeof pulse.unref === "function") {
            pulse.unref();
          }
          stopProactivePulse = () => clearInterval(pulse);
        }

        try {
          const fresh = await resolveFreshProviderAccessToken(activeProviderId, oauth);
          oauth = fresh.credentials;

          if (fresh.changed) {
            assignProviderOAuth(config, activeProviderId, oauth);
            config.telegram = {
              ...config.telegram,
              offset,
            };
            await saveConfig(config, configPath);
          }

          const now = Date.now();
          const history = getConversationHistory(conversationStore, sessionId);
          const response = await requestCodexResponse({
            accessToken: fresh.accessToken,
            providerId: activeProviderId,
            modelId: activeModelId,
            providerConnection: resolveProviderConnection(config, activeProviderId),
            reasoningEffort: resolveReasoningEffort(config),
            instructions: codexInstructions,
            workspaceRoot: resolveRuntimeWorkspaceRoot(config),
            workspaceTemplateRoot: resolveRuntimeWorkspaceTemplateRoot(config),
            isFirstTurn: history.length === 0,
            messages: [
              ...history,
              {
                role: "user",
                content: text,
                timestamp: now,
              },
            ],
            skills: config?.skills,
            runtime: {
              channel: "telegram",
              chatId,
              sessionId,
            },
            configPath,
            onToolEvent: async (event) => {
              if (event?.phase === "start" || event?.phase === "result") {
                lastToolStatusAt = Date.now();
                await upsertStatus(buildToolRunningStatus(event, locale));
              }
              if (event?.phase === "result") {
                seenToolEvents.push(event);
              }
            },
          });

          stopTypingNow();
          await sendMessage(botToken, chatId, response.text);
          const toolContextTexts = buildToolContextHistoryTexts(response?.toolResults);
          conversationStore = appendConversationTurn({
            store: conversationStore,
            sessionId,
            userText: text,
            assistantText: response.text,
            toolContextTexts,
          });
          conversationStoreDirty = true;

          const toolEvents =
            Array.isArray(response?.toolEvents) && response.toolEvents.length > 0
              ? response.toolEvents
              : seenToolEvents;
          const toolSummary = buildToolSummary(toolEvents, locale);
          const doneLine = buildCompletedStatus(locale, Date.now() - requestStartedAt);
          if (toolSummary && proactiveStatusEnabled) {
            await upsertStatus(`${toolSummary}\n${doneLine}`);
          } else if (toolSummary) {
            await upsertStatus(toolSummary);
          } else if (proactiveStatusEnabled) {
            await upsertStatus(doneLine);
          }
        } catch (error) {
          const toolSummary = buildToolSummary(seenToolEvents, locale);
          const failedLine = buildFailedStatus(locale, Date.now() - requestStartedAt);
          if (toolSummary && proactiveStatusEnabled) {
            await upsertStatus(`${toolSummary}\n${failedLine}`);
          } else if (toolSummary) {
            await upsertStatus(`${toolSummary}\n${failedLine}`);
          } else if (proactiveStatusEnabled) {
            await upsertStatus(failedLine);
          }
          stopTypingNow();
          await sendMessage(
            botToken,
            chatId,
            `Model request failed: ${trim(error?.message) || "unknown error"}`,
          );
        } finally {
          stopTypingNow();
          stopProactivePulse();
        }
      }

      config.telegram = {
        ...config.telegram,
        offset,
      };
      await saveConfig(config, configPath);
      if (conversationStoreDirty) {
        const savedConversations = await saveConversationStore(conversationStore, configPath);
        conversationStore = savedConversations.store;
      }
    } catch (error) {
      pollingAbortController = null;
      if (shouldStop && error?.name === "AbortError") {
        break;
      }
      if (shouldStop) {
        break;
      }
      const message = trim(error?.message) || String(error);

      if (
        !triedWebhookReset &&
        /telegram http error \(409\)/i.test(message) &&
        /webhook/i.test(message)
      ) {
        triedWebhookReset = true;
        process.stderr.write(
          "Polling conflict: webhook is active. Trying to disable webhook for long polling...\n",
        );
        try {
          await clearWebhook(botToken);
          process.stderr.write("Webhook disabled. Retrying polling.\n");
          continue;
        } catch (hookError) {
          process.stderr.write(
            `Webhook disable failed: ${trim(hookError?.message) || String(hookError)}\n`,
          );
        }
      }

      if (/telegram http error \(409\)/i.test(message)) {
        process.stderr.write(
          "Polling conflict (409): another bot instance may already be polling this token.\n",
        );
      }
      process.stderr.write(`Polling error details: ${formatErrorAsJson(error)}\n`);
      await sleep(3_000);
    }
  }

  stopInlinePairingApproval();
  process.stdout.write("CodexClaw Telegram bot stopped.\n");
}
