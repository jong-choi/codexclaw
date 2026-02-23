import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "./config-store.mjs";

const PAIRING_CODE_LENGTH = 8;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_PENDING_TTL_MS = 60 * 60 * 1000;
const PAIRING_PENDING_MAX = 3;
const LOCK_RETRIES = 80;
const LOCK_DELAY_MS = 50;

function trim(value) {
  return String(value ?? "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureSupportedChannel(channel) {
  const normalized = trim(channel).toLowerCase();
  if (normalized !== "telegram") {
    throw new Error(`Unsupported pairing channel: ${channel}`);
  }
  return normalized;
}

function resolveStateDir(configPath) {
  return path.dirname(resolveConfigPath(configPath));
}

function resolvePairingPath(channel, configPath) {
  return path.join(resolveStateDir(configPath), `${ensureSupportedChannel(channel)}-pairing.json`);
}

function resolveAllowFromPath(channel, configPath) {
  return path.join(resolveStateDir(configPath), `${ensureSupportedChannel(channel)}-allowFrom.json`);
}

async function ensureParentDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return fallback;
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function writeJson(filePath, value) {
  await ensureParentDir(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tmp, filePath);
}

async function withFileLock(filePath, fn) {
  await ensureParentDir(filePath);
  const lockPath = `${filePath}.lock`;
  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      await sleep(LOCK_DELAY_MS);
    }
  }
  throw new Error(`Could not acquire lock: ${lockPath}`);
}

function parseTimestamp(value) {
  const parsed = Date.parse(trim(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeId(value) {
  return trim(value);
}

function normalizeAllowEntry(channel, value) {
  const entry = trim(value).toLowerCase();
  if (!entry || entry === "*") {
    return "";
  }
  if (ensureSupportedChannel(channel) === "telegram") {
    const stripped = entry.replace(/^(telegram|tg):/i, "");
    return /^\d+$/.test(stripped) ? stripped : "";
  }
  return entry;
}

function dedupe(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function pruneExpired(requests) {
  const now = Date.now();
  return requests.filter((item) => now - parseTimestamp(item.createdAt) <= PAIRING_PENDING_TTL_MS);
}

function randomCode() {
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i += 1) {
    out += PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

function generateUniqueCode(existing) {
  for (let i = 0; i < 500; i += 1) {
    const candidate = randomCode();
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("Failed to generate unique pairing code");
}

function normalizePairingStore(raw) {
  const requests = Array.isArray(raw?.requests)
    ? raw.requests
        .map((item) => ({
          id: normalizeId(item?.id),
          code: trim(item?.code).toUpperCase(),
          createdAt: trim(item?.createdAt),
          lastSeenAt: trim(item?.lastSeenAt),
          meta: item?.meta && typeof item.meta === "object" ? item.meta : undefined,
        }))
        .filter((item) => item.id && item.code && item.createdAt)
    : [];

  return {
    version: 1,
    requests,
  };
}

function normalizeAllowStore(raw, channel) {
  const list = Array.isArray(raw?.allowFrom)
    ? raw.allowFrom.map((entry) => normalizeAllowEntry(channel, entry)).filter(Boolean)
    : [];
  return {
    version: 1,
    allowFrom: dedupe(list),
  };
}

export async function readChannelAllowFromStore(channel, configPath) {
  const normalizedChannel = ensureSupportedChannel(channel);
  const filePath = resolveAllowFromPath(normalizedChannel, configPath);
  const store = normalizeAllowStore(
    await readJson(filePath, { version: 1, allowFrom: [] }),
    normalizedChannel,
  );
  return store.allowFrom;
}

export async function listChannelPairingRequests(channel, configPath) {
  const normalizedChannel = ensureSupportedChannel(channel);
  const filePath = resolvePairingPath(normalizedChannel, configPath);

  return await withFileLock(filePath, async () => {
    const store = normalizePairingStore(await readJson(filePath, { version: 1, requests: [] }));
    const pruned = pruneExpired(store.requests);
    const capped = pruned.slice(-PAIRING_PENDING_MAX);
    if (capped.length !== store.requests.length) {
      await writeJson(filePath, {
        version: 1,
        requests: capped,
      });
    }
    return capped.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });
}

export async function upsertChannelPairingRequest(params) {
  const channel = ensureSupportedChannel(params?.channel);
  const id = normalizeId(params?.id);
  if (!id) {
    return { code: "", created: false };
  }

  const filePath = resolvePairingPath(channel, params?.configPath);
  return await withFileLock(filePath, async () => {
    const now = new Date().toISOString();
    const store = normalizePairingStore(await readJson(filePath, { version: 1, requests: [] }));
    const pruned = pruneExpired(store.requests);

    const existingIndex = pruned.findIndex((entry) => entry.id === id);
    if (existingIndex >= 0) {
      const existing = pruned[existingIndex];
      const next = {
        ...existing,
        lastSeenAt: now,
        meta: params?.meta && typeof params.meta === "object" ? params.meta : existing.meta,
      };
      pruned[existingIndex] = next;
      await writeJson(filePath, { version: 1, requests: pruned.slice(-PAIRING_PENDING_MAX) });
      return { code: next.code, created: false };
    }

    const capped = pruned.slice(-PAIRING_PENDING_MAX);
    if (capped.length >= PAIRING_PENDING_MAX) {
      await writeJson(filePath, { version: 1, requests: capped });
      return { code: "", created: false };
    }

    const existingCodes = new Set(capped.map((entry) => trim(entry.code).toUpperCase()));
    const code = generateUniqueCode(existingCodes);
    const nextEntry = {
      id,
      code,
      createdAt: now,
      lastSeenAt: now,
      meta: params?.meta && typeof params.meta === "object" ? params.meta : undefined,
    };
    await writeJson(filePath, {
      version: 1,
      requests: [...capped, nextEntry],
    });
    return { code, created: true };
  });
}

async function addAllowFromEntry(params) {
  const channel = ensureSupportedChannel(params.channel);
  const normalized = normalizeAllowEntry(channel, params.entry);
  if (!normalized) {
    return;
  }

  const filePath = resolveAllowFromPath(channel, params.configPath);
  await withFileLock(filePath, async () => {
    const store = normalizeAllowStore(
      await readJson(filePath, { version: 1, allowFrom: [] }),
      channel,
    );
    if (store.allowFrom.includes(normalized)) {
      return;
    }
    await writeJson(filePath, {
      version: 1,
      allowFrom: [...store.allowFrom, normalized],
    });
  });
}

export async function approveChannelPairingCode(params) {
  const channel = ensureSupportedChannel(params?.channel);
  const code = trim(params?.code).toUpperCase();
  if (!code) {
    return null;
  }

  const filePath = resolvePairingPath(channel, params?.configPath);
  return await withFileLock(filePath, async () => {
    const store = normalizePairingStore(await readJson(filePath, { version: 1, requests: [] }));
    const pruned = pruneExpired(store.requests);
    const index = pruned.findIndex((entry) => trim(entry.code).toUpperCase() === code);
    if (index < 0) {
      if (pruned.length !== store.requests.length) {
        await writeJson(filePath, { version: 1, requests: pruned });
      }
      return null;
    }

    const [entry] = pruned.splice(index, 1);
    await writeJson(filePath, { version: 1, requests: pruned });
    await addAllowFromEntry({ channel, entry: entry.id, configPath: params?.configPath });
    return {
      id: entry.id,
      entry,
    };
  });
}
