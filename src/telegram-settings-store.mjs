import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "./config-store.mjs";
import { isValidSchedulerTimezone, resolveSchedulerTimezone } from "./schedule-store.mjs";

const STORE_FILE_NAME = "telegram-settings.json";
const STORE_VERSION = 1;

function trim(value) {
  return String(value ?? "").trim();
}

function resolveStorePath(customConfigPath) {
  return path.join(path.dirname(resolveConfigPath(customConfigPath)), STORE_FILE_NAME);
}

function normalizeStore(raw) {
  const chats = {};
  const input = raw?.chats && typeof raw.chats === "object" ? raw.chats : {};
  for (const [rawChatId, rawEntry] of Object.entries(input)) {
    const chatId = trim(rawChatId);
    if (!chatId || !rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const timezone = trim(rawEntry.timezone);
    if (!timezone || !isValidSchedulerTimezone(timezone)) {
      continue;
    }
    chats[chatId] = {
      timezone: resolveSchedulerTimezone(timezone),
      updatedAt: trim(rawEntry.updatedAt) || new Date().toISOString(),
    };
  }
  return {
    version: STORE_VERSION,
    chats,
  };
}

async function loadStore(customConfigPath) {
  const filePath = resolveStorePath(customConfigPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return {
      path: filePath,
      store: normalizeStore(JSON.parse(raw)),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {
        path: filePath,
        store: normalizeStore({ version: STORE_VERSION, chats: {} }),
      };
    }
    throw error;
  }
}

async function saveStore(store, customConfigPath) {
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
  return {
    path: filePath,
    store: normalized,
  };
}

export async function getTelegramChatTimezone(params) {
  const chatId = trim(params?.chatId);
  if (!chatId) {
    return "";
  }
  const loaded = await loadStore(params?.customConfigPath);
  const timezone = trim(loaded.store?.chats?.[chatId]?.timezone);
  return timezone && isValidSchedulerTimezone(timezone) ? resolveSchedulerTimezone(timezone) : "";
}

export async function setTelegramChatTimezone(params) {
  const chatId = trim(params?.chatId);
  const timezone = trim(params?.timezone);
  if (!chatId) {
    return {
      ok: false,
      error: "chatId is required.",
    };
  }
  if (!timezone || !isValidSchedulerTimezone(timezone)) {
    return {
      ok: false,
      error:
        "Invalid timezone. Use IANA timezone like Asia/Seoul, Europe/London, or America/New_York.",
    };
  }

  const normalizedTimezone = resolveSchedulerTimezone(timezone);
  const loaded = await loadStore(params?.customConfigPath);
  const nextStore = normalizeStore({
    ...loaded.store,
    chats: {
      ...(loaded.store?.chats ?? {}),
      [chatId]: {
        timezone: normalizedTimezone,
        updatedAt: new Date().toISOString(),
      },
    },
  });
  await saveStore(nextStore, params?.customConfigPath);
  return {
    ok: true,
    timezone: normalizedTimezone,
  };
}
