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
  CODEX_MODEL_IDS,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
  TELEGRAM_API_BASE_URL,
} from "./constants.mjs";
import { resolveFreshCodexAccessToken } from "./oauth.mjs";
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_STATUS_TEXT_CHARS = 3900;
const PROACTIVE_STATUS_INTERVAL_MS = 10_000;
const PROACTIVE_STATUS_QUIET_AFTER_TOOL_MS = 8_000;
const TELEGRAM_USAGE_VERSION = 1;
const REASONING_EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];

const TELEGRAM_BOT_COMMANDS = [
  { command: "start", description: "Show quick help" },
  { command: "help", description: "Show available commands" },
  { command: "new", description: "Reset context for this chat" },
  { command: "context", description: "Show stored context message count" },
  { command: "usage", description: "Show Codex usage (requests/tokens/cost)" },
  { command: "think", description: "Show or set reasoning effort" },
  { command: "models", description: "List available Codex models" },
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

function resolveModelId(config) {
  const fromStructured = normalizeCodexModelId(config?.codex?.model?.id);
  if (fromStructured) {
    return fromStructured;
  }

  const ref = trim(config?.codex?.model?.ref);
  if (!ref) {
    return "";
  }
  const slash = ref.indexOf("/");
  if (slash < 0) {
    return ref;
  }
  return normalizeCodexModelId(ref.slice(slash + 1));
}

function resolveModelRef(modelId) {
  return `${CODEX_PROVIDER_ID}/${trim(modelId)}`;
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

function asFiniteNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function formatInteger(value) {
  return Math.round(asFiniteNumber(value)).toLocaleString("en-US");
}

function formatUsd(value) {
  return asFiniteNumber(value).toFixed(6);
}

function createEmptyUsageBucket() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
    updatedAt: "",
  };
}

function normalizeUsageBucket(raw) {
  const bucket = raw && typeof raw === "object" ? raw : {};
  return {
    requests: Math.max(0, Math.floor(asFiniteNumber(bucket.requests))),
    inputTokens: asFiniteNumber(bucket.inputTokens),
    outputTokens: asFiniteNumber(bucket.outputTokens),
    cacheReadTokens: asFiniteNumber(bucket.cacheReadTokens),
    cacheWriteTokens: asFiniteNumber(bucket.cacheWriteTokens),
    totalTokens: asFiniteNumber(bucket.totalTokens),
    costInput: asFiniteNumber(bucket.costInput),
    costOutput: asFiniteNumber(bucket.costOutput),
    costCacheRead: asFiniteNumber(bucket.costCacheRead),
    costCacheWrite: asFiniteNumber(bucket.costCacheWrite),
    costTotal: asFiniteNumber(bucket.costTotal),
    updatedAt: trim(bucket.updatedAt),
  };
}

function normalizeUsageState(raw) {
  const usage = raw && typeof raw === "object" ? raw : {};
  const chatsRaw = usage.chats && typeof usage.chats === "object" ? usage.chats : {};
  const chats = {};
  for (const [key, value] of Object.entries(chatsRaw)) {
    const chatId = trim(key);
    if (!chatId) {
      continue;
    }
    chats[chatId] = normalizeUsageBucket(value);
  }
  return {
    version: TELEGRAM_USAGE_VERSION,
    total: normalizeUsageBucket(usage.total),
    chats,
  };
}

function normalizeUsageSnapshot(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost : {};
  const inputTokens = asFiniteNumber(usage.input);
  const outputTokens = asFiniteNumber(usage.output);
  const cacheReadTokens = asFiniteNumber(usage.cacheRead);
  const cacheWriteTokens = asFiniteNumber(usage.cacheWrite);
  const derivedTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: asFiniteNumber(usage.totalTokens) || derivedTotal,
    costInput: asFiniteNumber(cost.input),
    costOutput: asFiniteNumber(cost.output),
    costCacheRead: asFiniteNumber(cost.cacheRead),
    costCacheWrite: asFiniteNumber(cost.cacheWrite),
    costTotal: asFiniteNumber(cost.total),
  };
}

function applyUsageToBucket(bucket, snapshot, nowIso) {
  const current = normalizeUsageBucket(bucket);
  return {
    requests: current.requests + 1,
    inputTokens: current.inputTokens + snapshot.inputTokens,
    outputTokens: current.outputTokens + snapshot.outputTokens,
    cacheReadTokens: current.cacheReadTokens + snapshot.cacheReadTokens,
    cacheWriteTokens: current.cacheWriteTokens + snapshot.cacheWriteTokens,
    totalTokens: current.totalTokens + snapshot.totalTokens,
    costInput: current.costInput + snapshot.costInput,
    costOutput: current.costOutput + snapshot.costOutput,
    costCacheRead: current.costCacheRead + snapshot.costCacheRead,
    costCacheWrite: current.costCacheWrite + snapshot.costCacheWrite,
    costTotal: current.costTotal + snapshot.costTotal,
    updatedAt: nowIso,
  };
}

function applyUsageSnapshotToConfig(config, chatId, rawUsage) {
  if (!config || typeof config !== "object") {
    return;
  }
  const normalizedChatId = trim(chatId);
  if (!normalizedChatId) {
    return;
  }
  const snapshot = normalizeUsageSnapshot(rawUsage);
  const nowIso = new Date().toISOString();
  const usageState = normalizeUsageState(config?.telegram?.usage);
  usageState.total = applyUsageToBucket(usageState.total, snapshot, nowIso);
  usageState.chats[normalizedChatId] = applyUsageToBucket(
    usageState.chats[normalizedChatId],
    snapshot,
    nowIso,
  );
  config.telegram = {
    ...(config.telegram ?? {}),
    usage: usageState,
  };
}

function buildUsageSummaryLines(total, chat) {
  return [
    "Total:",
    `- requests: ${formatInteger(total.requests)}`,
    `- tokens: ${formatInteger(total.totalTokens)} (in ${formatInteger(total.inputTokens)}, out ${formatInteger(total.outputTokens)}, cache read ${formatInteger(total.cacheReadTokens)}, cache write ${formatInteger(total.cacheWriteTokens)})`,
    `- cost: $${formatUsd(total.costTotal)} (in $${formatUsd(total.costInput)}, out $${formatUsd(total.costOutput)}, cache read $${formatUsd(total.costCacheRead)}, cache write $${formatUsd(total.costCacheWrite)})`,
    "",
    "This chat:",
    `- requests: ${formatInteger(chat.requests)}`,
    `- tokens: ${formatInteger(chat.totalTokens)} (in ${formatInteger(chat.inputTokens)}, out ${formatInteger(chat.outputTokens)}, cache read ${formatInteger(chat.cacheReadTokens)}, cache write ${formatInteger(chat.cacheWriteTokens)})`,
    `- cost: $${formatUsd(chat.costTotal)} (in $${formatUsd(chat.costInput)}, out $${formatUsd(chat.costOutput)}, cache read $${formatUsd(chat.costCacheRead)}, cache write $${formatUsd(chat.costCacheWrite)})`,
  ];
}

function buildUsageReport(config, chatId) {
  const usageState = normalizeUsageState(config?.telegram?.usage);
  const total = usageState.total;
  const chat = normalizeUsageBucket(usageState.chats?.[trim(chatId)]);
  const lines = ["Codex usage", "", ...buildUsageSummaryLines(total, chat)];
  if (trim(total.updatedAt)) {
    lines.push("", `Last updated: ${trim(total.updatedAt)}`);
  }
  return lines.join("\n");
}

function buildModelStatusMessage(config, chatId, modelId) {
  const usageState = normalizeUsageState(config?.telegram?.usage);
  const total = usageState.total;
  const chat = normalizeUsageBucket(usageState.chats?.[trim(chatId)]);
  const reasoningEffort = resolveReasoningEffort(config);
  return [
    `Current model: ${resolveModelRef(modelId)}`,
    `Reasoning effort: ${reasoningEffort}`,
    "",
    "Usage summary:",
    ...buildUsageSummaryLines(total, chat),
    "",
    "Change model with /model <id|number>.",
    "Change reasoning with /think <none|minimal|low|medium|high|xhigh>.",
  ].join("\n");
}

function buildModelListMessage(currentModelId) {
  const normalizedCurrent = normalizeCodexModelId(currentModelId);
  const lines = ["Available Codex models:"];
  for (let i = 0; i < CODEX_MODEL_IDS.length; i += 1) {
    const modelId = CODEX_MODEL_IDS[i];
    const current = modelId === normalizedCurrent ? " (current)" : "";
    lines.push(`${i + 1}. ${resolveModelRef(modelId)}${current}`);
  }
  lines.push("");
  lines.push("Use /model <id|number> to switch.");
  lines.push("Examples: /model 3, /model gpt-5.3-codex");
  return lines.join("\n");
}

function resolveModelSelection(value) {
  const raw = trim(value).toLowerCase();
  if (!raw) {
    return "";
  }

  if (/^\d+$/.test(raw)) {
    const index = Number.parseInt(raw, 10);
    if (Number.isInteger(index) && index >= 1 && index <= CODEX_MODEL_IDS.length) {
      return CODEX_MODEL_IDS[index - 1];
    }
    return "";
  }

  let candidate = raw;
  if (candidate.includes("/")) {
    candidate = candidate.slice(candidate.lastIndexOf("/") + 1);
  }
  const normalized = normalizeCodexModelId(candidate);
  if (CODEX_MODEL_IDS.includes(normalized)) {
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

function buildHelpMessage() {
  return [
    "CodexClaw Telegram commands",
    "",
    "/help - Show this command guide.",
    "/new (/clear, /reset) - Reset context for this chat.",
    "/context - Show stored context message count.",
    "/usage - Show Codex usage (requests/tokens/cost).",
    "/think <level> - Set reasoning effort.",
    "/models - List available models.",
    "/model - Show current model + reasoning + usage summary.",
    "/model <id|number> - Switch model immediately.",
    "",
    `Reasoning levels: ${REASONING_EFFORT_LEVELS.join(", ")}`,
    "Think aliases: /thinking, /reasoning, /reason, /t",
    "",
    "Examples:",
    "/think medium",
    "/model 3",
    "/model gpt-5.3-codex",
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
      const fresh = await resolveFreshCodexAccessToken(oauth);
      oauth = fresh.credentials;

      if (fresh.changed) {
        params.config.codex = {
          ...params.config.codex,
          oauth,
        };
        await saveConfig(params.config, params.configPath);
      }

      const now = Date.now();
      const history = getConversationHistory(conversationStore, sessionId);
      const response = await requestCodexResponse({
        accessToken: fresh.accessToken,
        modelId: params?.modelId,
        reasoningEffort: resolveReasoningEffort(params?.config),
        instructions: params?.codexInstructions,
        workspaceRoot: trim(params?.config?.workspace?.root),
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
      if (typeof params?.onUsage === "function") {
        params.onUsage({
          chatId,
          usage: response?.usage,
        });
      }
      conversationStore = appendConversationTurn({
        store: conversationStore,
        sessionId,
        userText: `[scheduled] ${trim(job?.prompt)}`,
        assistantText: response.text,
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

  let activeModelId = resolveModelId(config);
  if (!activeModelId) {
    throw new Error("codex.model is missing. Run `codexclaw onboard`.");
  }

  let oauth = config?.codex?.oauth;
  if (!oauth || typeof oauth !== "object") {
    throw new Error("codex.oauth is missing. Run `codexclaw onboard`.");
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
  process.stdout.write(`Model: ${resolveModelRef(activeModelId)}\n`);
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
        modelId: activeModelId,
        codexInstructions,
        config,
        configPath,
        oauth,
        conversationStore,
        onUsage: ({ chatId, usage }) => {
          applyUsageSnapshotToConfig(config, chatId, usage);
        },
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
          await sendMessage(
            botToken,
            chatId,
            [
              "CodexClaw is connected. Send a message to talk to Codex.",
              "Use /help to see all available commands.",
              "Use /new to reset context for this chat.",
              "Use /context to inspect stored context size.",
              "Use /usage to inspect Codex usage.",
              "Use /think to inspect or set reasoning effort.",
              "Use /models to list models, /model to inspect current model.",
            ].join("\n"),
          );
          continue;
        }

        if (isHelpCommand(command)) {
          await sendMessage(botToken, chatId, buildHelpMessage());
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
          await sendMessage(botToken, chatId, buildUsageReport(config, chatId));
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
          await sendMessage(botToken, chatId, buildModelListMessage(activeModelId));
          continue;
        }

        if (command === "/model") {
          const arg = resolveCommandArgs(text);
          if (!arg) {
            await sendMessage(botToken, chatId, buildModelStatusMessage(config, chatId, activeModelId));
            continue;
          }
          const selectedModelId = resolveModelSelection(arg);
          if (!selectedModelId) {
            await sendMessage(
              botToken,
              chatId,
              [
                `Unknown model: ${trim(arg)}`,
                "Usage: /model <id|number>",
                "Use /models to see valid options.",
                "Examples: /model 3, /model gpt-5.3-codex",
              ].join("\n"),
            );
            continue;
          }
          if (selectedModelId === activeModelId) {
            await sendMessage(botToken, chatId, `Model unchanged: ${resolveModelRef(activeModelId)}`);
            continue;
          }
          activeModelId = selectedModelId;
          config.codex = {
            ...(config.codex ?? {}),
            model: {
              id: selectedModelId,
              ref: resolveModelRef(selectedModelId),
            },
          };
          await saveConfig(config, configPath);
          process.stdout.write(`Model switched to ${resolveModelRef(activeModelId)}.\n`);
          await sendMessage(
            botToken,
            chatId,
            `Model updated: ${resolveModelRef(activeModelId)}`,
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
          const fresh = await resolveFreshCodexAccessToken(oauth);
          oauth = fresh.credentials;

          if (fresh.changed) {
            config.codex = {
              ...config.codex,
              oauth,
            };
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
            modelId: activeModelId,
            reasoningEffort: resolveReasoningEffort(config),
            instructions: codexInstructions,
            workspaceRoot: trim(config?.workspace?.root),
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
          applyUsageSnapshotToConfig(config, chatId, response?.usage);
          conversationStore = appendConversationTurn({
            store: conversationStore,
            sessionId,
            userText: text,
            assistantText: response.text,
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
            `Codex request failed: ${trim(error?.message) || "unknown error"}`,
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
