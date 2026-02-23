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
import { LEGACY_CODEX_MODEL_ID_ALIASES, TELEGRAM_API_BASE_URL } from "./constants.mjs";
import { resolveFreshCodexAccessToken } from "./oauth.mjs";
import { buildPairingReply } from "./pairing-messages.mjs";
import {
  approveChannelPairingCode,
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "./pairing-store.mjs";

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

function startInlinePairingApproval(params) {
  const configPath = params?.configPath;
  if (!process.stdin || !process.stdin.isTTY) {
    process.stdout.write("Inline pairing input disabled (non-interactive terminal).\n");
    return () => {};
  }

  process.stdout.write(
    "Enter pairing code in this terminal and press Enter to approve sender (empty line = ignore).\n",
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
        const code = trim(raw).toUpperCase();
        if (!code) {
          continue;
        }

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

async function telegramApi(token, method, body) {
  const url = `${TELEGRAM_API_BASE_URL}/bot${token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
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

async function getUpdates(token, offset) {
  return await telegramApi(token, "getUpdates", {
    timeout: 30,
    offset,
    allowed_updates: ["message"],
  });
}

async function clearWebhook(token) {
  return await telegramApi(token, "deleteWebhook", {
    drop_pending_updates: false,
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

function resolveCommandToken(text) {
  const first = trim(text).split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!first.startsWith("/")) {
    return "";
  }
  const at = first.indexOf("@");
  return at >= 0 ? first.slice(0, at) : first;
}

function isResetCommand(token) {
  return token === "/new" || token === "/clear" || token === "/reset";
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

  const modelId = resolveModelId(config);
  if (!modelId) {
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

  process.stdout.write(`CodexClaw Telegram bot is running.\n`);
  process.stdout.write(`Model: openai-codex/${modelId}\n`);
  process.stdout.write(`DM policy: ${dmPolicy}\n`);
  process.stdout.write(`Proactive status: ${proactiveStatusEnabled ? "on" : "off"}\n`);
  process.stdout.write(`Conversation store: ${conversationState.path}\n`);
  if (dmPolicy === "pairing") {
    process.stdout.write("Unknown DM senders will receive a pairing code.\n");
  }
  if (dmPolicy === "pairing") {
    startInlinePairingApproval({ configPath });
  }

  while (true) {
    try {
      let conversationStoreDirty = false;
      const updates = await getUpdates(botToken, offset);
      for (const update of updates) {
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
              "Use /new to reset context for this chat.",
              "Use /context to inspect stored context size.",
            ].join("\n"),
          );
          continue;
        }

        if (isResetCommand(command)) {
          conversationStore = clearConversationHistory(conversationStore, sessionId);
          conversationStoreDirty = true;
          await sendMessage(botToken, chatId, "Context cleared for this chat.");
          continue;
        }

        if (command === "/context") {
          const count = countConversationMessages(conversationStore, sessionId);
          await sendMessage(
            botToken,
            chatId,
            `Stored context messages for this chat: ${count}\nUse /new to reset context.`,
          );
          continue;
        }

        await sendTyping(botToken, chatId);
        const stopTypingHeartbeat = startTypingHeartbeat(botToken, chatId);
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
            modelId,
            instructions: codexInstructions,
            messages: [
              ...history,
              {
                role: "user",
                content: text,
                timestamp: now,
              },
            ],
            skills: config?.skills,
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

          await sendMessage(botToken, chatId, response.text);
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
          await sendMessage(
            botToken,
            chatId,
            `Codex request failed: ${trim(error?.message) || "unknown error"}`,
          );
        } finally {
          stopTypingHeartbeat();
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
      process.stderr.write(`Polling error: ${message}\n`);
      await sleep(3_000);
    }
  }
}
