import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigPath } from "./config-store.mjs";

const STORE_FILE_NAME = "telegram-schedules.json";
const STORE_VERSION = 1;
const MAX_JOBS = 500;
const MAX_PROMPT_CHARS = 4000;
const MAX_ERROR_CHARS = 2000;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DEFAULT_TIMEZONE = "UTC";

const JOB_STATUS_PENDING = "pending";
const JOB_STATUS_RUNNING = "running";
const JOB_STATUS_COMPLETED = "completed";
const JOB_STATUS_FAILED = "failed";
const JOB_STATUS_CANCELED = "canceled";

const JOB_STATUSES = new Set([
  JOB_STATUS_PENDING,
  JOB_STATUS_RUNNING,
  JOB_STATUS_COMPLETED,
  JOB_STATUS_FAILED,
  JOB_STATUS_CANCELED,
]);

function trim(value) {
  return String(value ?? "").trim();
}

function clampText(value, maxChars) {
  const text = trim(value);
  if (!text) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function resolveStorePath(customConfigPath) {
  return path.join(path.dirname(resolveConfigPath(customConfigPath)), STORE_FILE_NAME);
}

function parseTimestamp(value) {
  const parsed = Date.parse(trim(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeStatus(value) {
  const status = trim(value).toLowerCase();
  if (JOB_STATUSES.has(status)) {
    return status;
  }
  return JOB_STATUS_PENDING;
}

function isValidTimezone(value) {
  const timezone = trim(value);
  if (!timezone) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function resolveSchedulerTimezone(value, fallback = DEFAULT_TIMEZONE) {
  const timezone = trim(value);
  if (timezone && isValidTimezone(timezone)) {
    return timezone;
  }
  const fallbackZone = trim(fallback);
  if (fallbackZone && isValidTimezone(fallbackZone)) {
    return fallbackZone;
  }
  return DEFAULT_TIMEZONE;
}

export function isValidSchedulerTimezone(value) {
  return isValidTimezone(value);
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const id = trim(raw.id);
  const channel = trim(raw.channel).toLowerCase();
  const chatId = trim(raw.chatId);
  const sessionId = trim(raw.sessionId);
  const prompt = clampText(raw.prompt, MAX_PROMPT_CHARS);
  if (!id || !channel || !chatId || !sessionId || !prompt) {
    return null;
  }

  const runAtMsRaw = Number(raw.runAtMs);
  const runAtMs =
    Number.isFinite(runAtMsRaw) && runAtMsRaw > 0 ? runAtMsRaw : parseTimestamp(raw.runAt);
  if (!runAtMs) {
    return null;
  }

  const createdAtMs = parseTimestamp(raw.createdAt) || Date.now();
  const updatedAtMs = parseTimestamp(raw.updatedAt) || createdAtMs;

  const timezone = resolveSchedulerTimezone(raw.timezone, DEFAULT_TIMEZONE);
  const status = normalizeStatus(raw.status);
  const attemptsRaw = Number(raw.attempts);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 0 ? Math.floor(attemptsRaw) : 0;

  return {
    id,
    channel,
    chatId,
    sessionId,
    prompt,
    runAtMs,
    runAt: new Date(runAtMs).toISOString(),
    timezone,
    status,
    createdAt: new Date(createdAtMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    attempts,
    lastRunAt: trim(raw.lastRunAt) || undefined,
    completedAt: trim(raw.completedAt) || undefined,
    failedAt: trim(raw.failedAt) || undefined,
    canceledAt: trim(raw.canceledAt) || undefined,
    lastError: clampText(raw.lastError, MAX_ERROR_CHARS) || undefined,
  };
}

function normalizeStore(raw) {
  const rows = Array.isArray(raw?.jobs) ? raw.jobs.map((entry) => normalizeJob(entry)).filter(Boolean) : [];

  rows.sort((a, b) => {
    if (a.status === JOB_STATUS_PENDING && b.status === JOB_STATUS_PENDING) {
      return a.runAtMs - b.runAtMs;
    }
    if (a.status === JOB_STATUS_PENDING) {
      return -1;
    }
    if (b.status === JOB_STATUS_PENDING) {
      return 1;
    }
    return parseTimestamp(a.updatedAt) - parseTimestamp(b.updatedAt);
  });

  const jobs = rows.slice(-MAX_JOBS);
  return {
    version: STORE_VERSION,
    jobs,
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
        store: normalizeStore({ version: STORE_VERSION, jobs: [] }),
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

function buildJobId() {
  return `sched_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function hasExplicitTimezoneOffset(value) {
  const text = trim(value);
  return /(?:z|[+-]\d{2}:\d{2})$/i.test(text);
}

function parseLocalDateTime(value) {
  const text = trim(value).replace(" ", "T");
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute) ||
    !Number.isFinite(second)
  ) {
    return null;
  }
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  return { year, month, day, hour, minute, second };
}

function parseTimezoneOffsetMinutes(value) {
  const token = trim(value).toUpperCase();
  if (!token || token === "GMT" || token === "UTC") {
    return 0;
  }
  const match = token.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    return 0;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }
  return sign * (hours * 60 + minutes);
}

function resolveTimezoneOffsetMinutes(utcMs, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const token = parts.find((entry) => entry.type === "timeZoneName")?.value;
  return parseTimezoneOffsetMinutes(token);
}

function formatUtcMsInTimezone(utcMs, timezone) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(new Date(utcMs)).replace("T", " ");
}

function parseRunAtUtcMs({ runAt, timezone, defaultTimezone, nowMs }) {
  const rawRunAt = trim(runAt);
  if (!rawRunAt) {
    return {
      ok: false,
      error: "runAt is required.",
    };
  }

  if (hasExplicitTimezoneOffset(rawRunAt)) {
    const parsed = Date.parse(rawRunAt);
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        error: "Invalid runAt. Use ISO 8601 with timezone offset, e.g. 2026-02-23T15:30:00+09:00.",
      };
    }
    return {
      ok: true,
      runAtMs: parsed,
      timezone: resolveSchedulerTimezone(timezone, defaultTimezone),
    };
  }

  const local = parseLocalDateTime(rawRunAt);
  if (!local) {
    return {
      ok: false,
      error:
        "Invalid runAt format. Use YYYY-MM-DDTHH:mm[:ss] with timezone, or ISO 8601 with timezone offset.",
    };
  }

  const targetTimezone = resolveSchedulerTimezone(timezone, defaultTimezone);
  const utcGuess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const offset1 = resolveTimezoneOffsetMinutes(utcGuess, targetTimezone);
  let runAtMs = utcGuess - offset1 * 60_000;
  const offset2 = resolveTimezoneOffsetMinutes(runAtMs, targetTimezone);
  if (offset2 !== offset1) {
    runAtMs = utcGuess - offset2 * 60_000;
  }

  const renderedLocal = formatUtcMsInTimezone(runAtMs, targetTimezone);
  const expectedLocal = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(
    local.day,
  ).padStart(2, "0")} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(
    local.second,
  ).padStart(2, "0")}`;
  if (renderedLocal !== expectedLocal) {
    return {
      ok: false,
      error: `The local time ${rawRunAt} is not valid in timezone ${targetTimezone}.`,
    };
  }

  if (runAtMs <= nowMs) {
    return {
      ok: false,
      error: "runAt must be in the future.",
    };
  }

  return {
    ok: true,
    runAtMs,
    timezone: targetTimezone,
  };
}

function resolveRunAtMs(params) {
  const nowMs = Number(params?.nowMs) > 0 ? Number(params.nowMs) : Date.now();
  const delayRaw = Number(params?.delaySeconds);
  const runAtRaw = trim(params?.runAt);
  const hasDelay = Number.isFinite(delayRaw) && delayRaw > 0;
  const hasRunAt = Boolean(runAtRaw);

  if (hasDelay && hasRunAt) {
    return {
      ok: false,
      error: "Use either delaySeconds or runAt, not both.",
    };
  }
  if (!hasDelay && !hasRunAt) {
    return {
      ok: false,
      error: "delaySeconds or runAt is required.",
    };
  }

  if (hasDelay) {
    const seconds = Math.floor(delayRaw);
    const runAtMs = nowMs + seconds * 1000;
    return {
      ok: true,
      runAtMs,
      timezone: resolveSchedulerTimezone(params?.timezone, params?.defaultTimezone),
    };
  }

  return parseRunAtUtcMs({
    runAt: runAtRaw,
    timezone: params?.timezone,
    defaultTimezone: params?.defaultTimezone,
    nowMs,
  });
}

function serializeJob(job, timezone, nowMs = Date.now()) {
  const targetTimezone = resolveSchedulerTimezone(timezone, job?.timezone || DEFAULT_TIMEZONE);
  const runAtMs = Number(job?.runAtMs);
  const createdAtMs = parseTimestamp(job?.createdAt);
  const updatedAtMs = parseTimestamp(job?.updatedAt);
  return {
    id: job.id,
    status: job.status,
    prompt: job.prompt,
    timezone: targetTimezone,
    runAtUtc: new Date(runAtMs).toISOString(),
    runAtLocal: formatUtcMsInTimezone(runAtMs, targetTimezone),
    secondsUntilRun:
      Number.isFinite(runAtMs) && runAtMs > nowMs ? Math.max(0, Math.round((runAtMs - nowMs) / 1000)) : 0,
    createdAtUtc: createdAtMs ? new Date(createdAtMs).toISOString() : undefined,
    updatedAtUtc: updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined,
    attempts: Number(job?.attempts) || 0,
    lastError: trim(job?.lastError) || undefined,
  };
}

export async function createScheduledJob(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  const sessionId = trim(params?.sessionId);
  const prompt = clampText(params?.prompt, MAX_PROMPT_CHARS);
  const defaultTimezone = resolveSchedulerTimezone(params?.defaultTimezone, DEFAULT_TIMEZONE);
  const nowMs = Date.now();

  if (!channel || !chatId || !sessionId) {
    return {
      ok: false,
      error: "Missing runtime channel/chat/session context.",
    };
  }
  if (!prompt) {
    return {
      ok: false,
      error: "prompt is required.",
    };
  }

  const resolvedRunAt = resolveRunAtMs({
    delaySeconds: params?.delaySeconds,
    runAt: params?.runAt,
    timezone: params?.timezone,
    defaultTimezone,
    nowMs,
  });
  if (!resolvedRunAt.ok) {
    return {
      ok: false,
      error: resolvedRunAt.error,
    };
  }

  const runAtMs = Number(resolvedRunAt.runAtMs);
  if (!Number.isFinite(runAtMs) || runAtMs <= nowMs) {
    return {
      ok: false,
      error: "Scheduled time must be in the future.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const store = loaded.store;
  const job = normalizeJob({
    id: buildJobId(),
    channel,
    chatId,
    sessionId,
    prompt,
    runAtMs,
    timezone: resolvedRunAt.timezone || defaultTimezone,
    status: JOB_STATUS_PENDING,
    attempts: 0,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  });

  const nextStore = normalizeStore({
    ...store,
    jobs: [...(store.jobs ?? []), job],
  });
  await saveStore(nextStore, params?.customConfigPath);

  const displayTimezone = resolveSchedulerTimezone(params?.displayTimezone, job.timezone);
  return {
    ok: true,
    job: serializeJob(job, displayTimezone, nowMs),
    storePath: loaded.path,
  };
}

export async function listScheduledJobs(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  if (!channel || !chatId) {
    return {
      ok: false,
      error: "Missing runtime channel/chat context.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const filterStatus = trim(params?.status).toLowerCase();
  const normalizedStatus = filterStatus === "all" ? "all" : normalizeStatus(filterStatus);
  const limitRaw = Number(params?.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_LIST_LIMIT;
  const nowMs = Date.now();
  const displayTimezone = resolveSchedulerTimezone(params?.displayTimezone, params?.defaultTimezone);

  const filtered = (loaded.store.jobs ?? [])
    .filter((job) => job.channel === channel && job.chatId === chatId)
    .filter((job) => (normalizedStatus === "all" ? true : job.status === normalizedStatus))
    .sort((a, b) => a.runAtMs - b.runAtMs)
    .slice(0, limit);

  return {
    ok: true,
    status: normalizedStatus,
    timezone: displayTimezone,
    count: filtered.length,
    jobs: filtered.map((job) => serializeJob(job, displayTimezone, nowMs)),
  };
}

export async function cancelScheduledJob(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  const jobId = trim(params?.jobId);
  const nowIso = new Date().toISOString();
  if (!channel || !chatId || !jobId) {
    return {
      ok: false,
      error: "channel/chatId/jobId are required.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  let found = null;
  const nextJobs = (loaded.store.jobs ?? []).map((job) => {
    if (job.id !== jobId || job.channel !== channel || job.chatId !== chatId) {
      return job;
    }
    found = job;
    if (job.status !== JOB_STATUS_PENDING && job.status !== JOB_STATUS_RUNNING) {
      return job;
    }
    return normalizeJob({
      ...job,
      status: JOB_STATUS_CANCELED,
      canceledAt: nowIso,
      updatedAt: nowIso,
    });
  });

  if (!found) {
    return {
      ok: false,
      error: "job_not_found",
    };
  }

  if (found.status !== JOB_STATUS_PENDING && found.status !== JOB_STATUS_RUNNING) {
    return {
      ok: false,
      error: `Job is already ${found.status}.`,
    };
  }

  const nextStore = normalizeStore({
    ...loaded.store,
    jobs: nextJobs,
  });
  await saveStore(nextStore, params?.customConfigPath);
  const canceled = nextStore.jobs.find((job) => job.id === jobId);
  return {
    ok: true,
    job: serializeJob(canceled, params?.displayTimezone),
  };
}

export async function claimDueScheduledJobs(params) {
  const channel = trim(params?.channel).toLowerCase();
  const nowMsRaw = Number(params?.nowMs);
  const nowMs = Number.isFinite(nowMsRaw) && nowMsRaw > 0 ? nowMsRaw : Date.now();
  const limitRaw = Number(params?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 3;
  if (!channel) {
    return [];
  }

  const loaded = await loadStore(params?.customConfigPath);
  const due = (loaded.store.jobs ?? [])
    .filter((job) => job.channel === channel && job.status === JOB_STATUS_PENDING && job.runAtMs <= nowMs)
    .sort((a, b) => a.runAtMs - b.runAtMs)
    .slice(0, limit);
  if (due.length === 0) {
    return [];
  }

  const dueIds = new Set(due.map((job) => job.id));
  const nowIso = new Date(nowMs).toISOString();
  const nextJobs = (loaded.store.jobs ?? []).map((job) => {
    if (!dueIds.has(job.id)) {
      return job;
    }
    return normalizeJob({
      ...job,
      status: JOB_STATUS_RUNNING,
      attempts: (Number(job.attempts) || 0) + 1,
      lastRunAt: nowIso,
      updatedAt: nowIso,
    });
  });

  const nextStore = normalizeStore({
    ...loaded.store,
    jobs: nextJobs,
  });
  await saveStore(nextStore, params?.customConfigPath);

  return nextStore.jobs.filter((job) => dueIds.has(job.id));
}

async function updateJobStatus(params, nextStatus, fields = {}) {
  const jobId = trim(params?.jobId);
  if (!jobId) {
    return {
      ok: false,
      error: "jobId is required.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const nowIso = new Date().toISOString();
  let found = null;
  const nextJobs = (loaded.store.jobs ?? []).map((job) => {
    if (job.id !== jobId) {
      return job;
    }
    found = job;
    return normalizeJob({
      ...job,
      ...fields,
      status: nextStatus,
      updatedAt: nowIso,
      ...(nextStatus === JOB_STATUS_COMPLETED ? { completedAt: nowIso } : {}),
      ...(nextStatus === JOB_STATUS_FAILED ? { failedAt: nowIso } : {}),
    });
  });

  if (!found) {
    return {
      ok: false,
      error: "job_not_found",
    };
  }

  const nextStore = normalizeStore({
    ...loaded.store,
    jobs: nextJobs,
  });
  await saveStore(nextStore, params?.customConfigPath);
  return {
    ok: true,
  };
}

export async function markScheduledJobCompleted(params) {
  return await updateJobStatus(params, JOB_STATUS_COMPLETED, {
    lastError: "",
  });
}

export async function markScheduledJobFailed(params) {
  return await updateJobStatus(params, JOB_STATUS_FAILED, {
    lastError: clampText(params?.error, MAX_ERROR_CHARS),
  });
}

export async function resolveSecondsUntilNextScheduledJob(params) {
  const channel = trim(params?.channel).toLowerCase();
  if (!channel) {
    return null;
  }
  const nowMsRaw = Number(params?.nowMs);
  const nowMs = Number.isFinite(nowMsRaw) && nowMsRaw > 0 ? nowMsRaw : Date.now();
  const maxSecondsRaw = Number(params?.maxSeconds);
  const maxSeconds =
    Number.isFinite(maxSecondsRaw) && maxSecondsRaw > 0 ? Math.floor(maxSecondsRaw) : 30;

  const loaded = await loadStore(params?.customConfigPath);
  const next = (loaded.store.jobs ?? [])
    .filter((job) => job.channel === channel && job.status === JOB_STATUS_PENDING)
    .sort((a, b) => a.runAtMs - b.runAtMs)[0];
  if (!next) {
    return null;
  }
  const diffMs = Math.max(0, next.runAtMs - nowMs);
  const seconds = Math.max(1, Math.ceil(diffMs / 1000));
  return Math.min(maxSeconds, seconds);
}
