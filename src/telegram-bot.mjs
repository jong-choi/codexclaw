import { requestCodexResponse } from "./codex-api.mjs";
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

  if (!response.ok) {
    throw new Error(`Telegram HTTP error (${response.status})`);
  }

  const payload = await response.json();
  if (!payload?.ok) {
    throw new Error(`Telegram API error: ${trim(payload?.description) || "unknown"}`);
  }

  return payload.result;
}

async function sendMessage(token, chatId, text) {
  const message = trim(text);
  if (!message) {
    return;
  }
  await telegramApi(token, "sendMessage", {
    chat_id: chatId,
    text: message,
  });
}

async function sendTyping(token, chatId) {
  await telegramApi(token, "sendChatAction", {
    chat_id: chatId,
    action: "typing",
  });
}

async function getUpdates(token, offset) {
  return await telegramApi(token, "getUpdates", {
    timeout: 30,
    offset,
    allowed_updates: ["message"],
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

  process.stdout.write(`CodexClaw Telegram bot is running.\n`);
  process.stdout.write(`Model: openai-codex/${modelId}\n`);
  process.stdout.write(`DM policy: ${dmPolicy}\n`);
  if (dmPolicy === "pairing") {
    process.stdout.write("Unknown DM senders will receive a pairing code.\n");
  }
  if (dmPolicy === "pairing") {
    startInlinePairingApproval({ configPath });
  }

  while (true) {
    try {
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

        if (text === "/start") {
          await sendMessage(botToken, chatId, "CodexClaw is connected. Send a message to talk to Codex.");
          continue;
        }

        await sendTyping(botToken, chatId);

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

          const response = await requestCodexResponse({
            accessToken: fresh.accessToken,
            modelId,
            instructions: codexInstructions,
            message: text,
          });

          await sendMessage(botToken, chatId, response.text);
        } catch (error) {
          await sendMessage(
            botToken,
            chatId,
            `Codex request failed: ${trim(error?.message) || "unknown error"}`,
          );
        }
      }

      config.telegram = {
        ...config.telegram,
        offset,
      };
      await saveConfig(config, configPath);
    } catch (error) {
      process.stderr.write(`Polling error: ${trim(error?.message) || String(error)}\n`);
      await sleep(3_000);
    }
  }
}
