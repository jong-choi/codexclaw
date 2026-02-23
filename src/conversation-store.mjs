import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "./config-store.mjs";

const STORE_FILE_NAME = "telegram-conversations.json";
const STORE_VERSION = 1;
const MAX_CONVERSATIONS = 100;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 4_000;

function trim(value) {
  return String(value ?? "").trim();
}

function parseTimestamp(value) {
  const parsed = Date.parse(trim(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRole(value) {
  const role = trim(value).toLowerCase();
  if (role === "user" || role === "assistant") {
    return role;
  }
  return "";
}

function clampMessageContent(value) {
  const content = trim(value);
  if (!content) {
    return "";
  }
  if (content.length <= MAX_MESSAGE_CHARS) {
    return content;
  }
  return content.slice(0, MAX_MESSAGE_CHARS);
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const role = normalizeRole(raw.role);
  if (!role) {
    return null;
  }
  const content = clampMessageContent(raw.content);
  if (!content) {
    return null;
  }
  const timestampRaw = Number(raw.timestamp);
  const timestamp = Number.isFinite(timestampRaw) && timestampRaw > 0 ? timestampRaw : Date.now();
  return { role, content, timestamp };
}

function trimHistory(messages) {
  const normalized = Array.isArray(messages)
    ? messages.map((entry) => normalizeMessage(entry)).filter(Boolean)
    : [];

  let next = normalized;
  if (next.length > MAX_HISTORY_MESSAGES) {
    next = next.slice(-MAX_HISTORY_MESSAGES);
  }

  let totalChars = next.reduce((sum, entry) => sum + entry.content.length, 0);
  while (next.length > 1 && totalChars > MAX_HISTORY_CHARS) {
    totalChars -= next[0].content.length;
    next = next.slice(1);
  }

  return next;
}

function normalizeStore(raw) {
  const inputChats = raw?.chats && typeof raw.chats === "object" ? raw.chats : {};
  const rows = [];

  for (const [rawSessionId, rawEntry] of Object.entries(inputChats)) {
    const sessionId = trim(rawSessionId);
    if (!sessionId || !rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const messages = trimHistory(rawEntry.messages);
    if (messages.length === 0) {
      continue;
    }
    const updatedAtMs =
      parseTimestamp(rawEntry.updatedAt) || Number(messages[messages.length - 1]?.timestamp ?? 0) || Date.now();
    rows.push({
      sessionId,
      updatedAtMs,
      updatedAt: new Date(updatedAtMs).toISOString(),
      messages,
    });
  }

  rows.sort((a, b) => a.updatedAtMs - b.updatedAtMs);
  const kept = rows.slice(-MAX_CONVERSATIONS);
  const chats = {};
  for (const row of kept) {
    chats[row.sessionId] = {
      updatedAt: row.updatedAt,
      messages: row.messages,
    };
  }

  return {
    version: STORE_VERSION,
    chats,
  };
}

function resolveStorePath(customConfigPath) {
  return path.join(path.dirname(resolveConfigPath(customConfigPath)), STORE_FILE_NAME);
}

export async function loadConversationStore(customConfigPath) {
  const filePath = resolveStorePath(customConfigPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return { path: filePath, store: normalizeStore(parsed) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { path: filePath, store: normalizeStore({ version: STORE_VERSION, chats: {} }) };
    }
    throw error;
  }
}

export async function saveConversationStore(store, customConfigPath) {
  const filePath = resolveStorePath(customConfigPath);
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });

  const normalized = normalizeStore(store);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
  return { path: filePath, store: normalized };
}

export function getConversationHistory(store, sessionId) {
  const key = trim(sessionId);
  if (!key) {
    return [];
  }
  const history = store?.chats?.[key]?.messages;
  return trimHistory(history).map((entry) => ({ ...entry }));
}

export function clearConversationHistory(store, sessionId) {
  const key = trim(sessionId);
  const normalized = normalizeStore(store);
  if (!key || !normalized.chats?.[key]) {
    return normalized;
  }
  const chats = { ...normalized.chats };
  delete chats[key];
  return normalizeStore({
    ...normalized,
    chats,
  });
}

export function appendConversationTurn(params) {
  const normalized = normalizeStore(params?.store);
  const sessionId = trim(params?.sessionId);
  if (!sessionId) {
    return normalized;
  }

  const existing = getConversationHistory(normalized, sessionId);
  const now = Date.now();
  const userMessage = normalizeMessage({
    role: "user",
    content: params?.userText,
    timestamp: now,
  });
  const assistantMessage = normalizeMessage({
    role: "assistant",
    content: params?.assistantText,
    timestamp: now + 1,
  });
  const toolContextMessages = Array.isArray(params?.toolContextTexts)
    ? params.toolContextTexts
        .map((entry, index) =>
          normalizeMessage({
            role: "assistant",
            content: entry,
            timestamp: now + 2 + index,
          }),
        )
        .filter(Boolean)
    : [];

  const nextMessages = trimHistory([
    ...existing,
    ...(userMessage ? [userMessage] : []),
    ...(assistantMessage ? [assistantMessage] : []),
    ...toolContextMessages,
  ]);
  if (nextMessages.length === 0) {
    return normalized;
  }

  const chats = {
    ...normalized.chats,
    [sessionId]: {
      updatedAt: new Date(now).toISOString(),
      messages: nextMessages,
    },
  };
  return normalizeStore({
    ...normalized,
    chats,
  });
}

export function countConversationMessages(store, sessionId) {
  return getConversationHistory(store, sessionId).length;
}
