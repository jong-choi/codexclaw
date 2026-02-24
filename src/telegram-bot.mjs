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
  TELEGRAM_API_BASE_URL,
} from "./constants.mjs";
import {
  assignModelSelection,
  assignProviderOAuth,
  ensureProviderState,
  normalizeProviderModelId,
  providerSupportsUsageSnapshot,
  resolveConfiguredProviderId,
  resolveModelRef,
  resolveProviderModelIds,
  resolveProviderOAuth,
  resolveProviderShortLabel,
} from "./model-provider.mjs";
import { resolveFreshProviderAccessToken } from "./oauth.mjs";
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
  { command: "models", description: "List available models for current provider" },
  { command: "model", description: "Show or switch model (/model <id|number>)" },
];

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
    `Current model: ${resolveModelRef(providerId, modelId)}`,
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

function buildModelListMessage(providerId, currentModelId) {
  const modelIds = resolveProviderModelIds(providerId);
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

function resolveModelSelection(providerId, value) {
  const modelIds = resolveProviderModelIds(providerId);
  const raw = trim(value).toLowerCase();
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
    } else {
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
    token === "/models" ||
    token === "/model"
  );
}

function buildHelpMessage(providerId) {
  const providerShortLabel = resolveProviderShortLabel(providerId);
  const providerModelIds = resolveProviderModelIds(providerId);
  const exampleModel = providerModelIds[0] || "<id>";
  return [
    "CodexClaw Telegram commands",
    "",
    "/help - Show this command guide.",
    "/new (/clear, /reset) - Reset context for this chat.",
    "/context - Show stored context message count.",
    "/usage - Show live usage limits (Codex only).",
    "/think <level> - Set reasoning effort.",
    "/models - List available models for current provider.",
    `/model - Show current provider/model (${providerShortLabel}) + reasoning + usage summary.`,
    "/model <id|number> - Switch model immediately.",
    "",
    `Reasoning levels: ${REASONING_EFFORT_LEVELS.join(", ")}`,
    "Think aliases: /thinking, /reasoning, /reason, /t",
    "",
    "Examples:",
    "/think medium",
    "/model 1",
    `/model ${exampleModel}`,
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
    throw new Error("model selection is missing. Run `codexclaw onboard`.");
  }

  let oauth = resolveProviderOAuth(config, activeProviderId);
  if (!oauth || typeof oauth !== "object") {
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
              "Use /models to list models, /model to inspect current model.",
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
          await sendMessage(botToken, chatId, buildModelListMessage(activeProviderId, activeModelId));
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
          const selectedModelId = resolveModelSelection(activeProviderId, arg);
          if (!selectedModelId) {
            const providerModelIds = resolveProviderModelIds(activeProviderId);
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
