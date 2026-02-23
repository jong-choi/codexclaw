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
const JOB_KIND_ONE_TIME = "one_time";
const JOB_KIND_RECURRING = "recurring";
const RECURRING_FREQUENCY_DAILY = "daily";
const RECURRING_FREQUENCY_WEEKLY = "weekly";
const RECURRING_STATE_ACTIVE = "active";
const RECURRING_STATE_PAUSED = "paused";
const RECURRING_STATE_RUNNING = "running";
const RECURRING_STATE_CANCELED = "canceled";
const RECURRING_STATES = new Set([
  RECURRING_STATE_ACTIVE,
  RECURRING_STATE_PAUSED,
  RECURRING_STATE_RUNNING,
  RECURRING_STATE_CANCELED,
  "all",
]);
const WEEKDAY_TOKENS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const WEEKDAY_ALIAS = new Map([
  ["SU", "SU"],
  ["SUN", "SU"],
  ["SUNDAY", "SU"],
  ["MO", "MO"],
  ["MON", "MO"],
  ["MONDAY", "MO"],
  ["TU", "TU"],
  ["TUE", "TU"],
  ["TUES", "TU"],
  ["TUESDAY", "TU"],
  ["WE", "WE"],
  ["WED", "WE"],
  ["WEDNESDAY", "WE"],
  ["TH", "TH"],
  ["THU", "TH"],
  ["THUR", "TH"],
  ["THURS", "TH"],
  ["THURSDAY", "TH"],
  ["FR", "FR"],
  ["FRI", "FR"],
  ["FRIDAY", "FR"],
  ["SA", "SA"],
  ["SAT", "SA"],
  ["SATURDAY", "SA"],
]);

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

function normalizeJobKind(value) {
  return trim(value).toLowerCase() === JOB_KIND_RECURRING ? JOB_KIND_RECURRING : JOB_KIND_ONE_TIME;
}

function normalizeRecurringFrequency(value) {
  const frequency = trim(value).toLowerCase();
  if (frequency === RECURRING_FREQUENCY_DAILY || frequency === RECURRING_FREQUENCY_WEEKLY) {
    return frequency;
  }
  return "";
}

function normalizeNumberInRange(value, min, max, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const integer = Math.floor(parsed);
  if (integer < min || integer > max) {
    return fallback;
  }
  return integer;
}

function normalizeWeekdayToken(value) {
  const token = trim(value).toUpperCase().replaceAll(".", "");
  return WEEKDAY_ALIAS.get(token) || "";
}

function normalizeRecurringWeekdays(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(/[,\s]+/g)
          .map((entry) => trim(entry))
          .filter(Boolean)
      : [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const out = [];
  for (const entry of raw) {
    const token = normalizeWeekdayToken(entry);
    if (!token) {
      continue;
    }
    if (!out.includes(token)) {
      out.push(token);
    }
  }
  return WEEKDAY_TOKENS.filter((token) => out.includes(token));
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

function normalizeRecurringSpec(raw, fallbackTimezone = DEFAULT_TIMEZONE) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const frequency = normalizeRecurringFrequency(raw.frequency);
  if (!frequency) {
    return null;
  }

  const hour = normalizeNumberInRange(raw.hour, 0, 23);
  const minute = normalizeNumberInRange(raw.minute, 0, 59, 0);
  const second = normalizeNumberInRange(raw.second, 0, 59, 0);
  if (hour === null || minute === null || second === null) {
    return null;
  }

  const timezone = resolveSchedulerTimezone(raw.timezone, fallbackTimezone);
  const paused = Boolean(raw.paused);
  const runCountRaw = Number(raw.runCount);
  const runCount = Number.isFinite(runCountRaw) && runCountRaw >= 0 ? Math.floor(runCountRaw) : 0;

  const weekdays =
    frequency === RECURRING_FREQUENCY_WEEKLY ? normalizeRecurringWeekdays(raw.weekdays) : [];
  if (frequency === RECURRING_FREQUENCY_WEEKLY && weekdays.length === 0) {
    return null;
  }

  return {
    frequency,
    weekdays,
    hour,
    minute,
    second,
    timezone,
    paused,
    runCount,
    lastScheduledAt: trim(raw.lastScheduledAt) || undefined,
    lastCompletedAt: trim(raw.lastCompletedAt) || undefined,
    lastFailedAt: trim(raw.lastFailedAt) || undefined,
    pausedAt: trim(raw.pausedAt) || undefined,
    resumedAt: trim(raw.resumedAt) || undefined,
  };
}

function resolveRecurringState(job) {
  if (job?.status === JOB_STATUS_CANCELED) {
    return RECURRING_STATE_CANCELED;
  }
  if (job?.status === JOB_STATUS_RUNNING) {
    return RECURRING_STATE_RUNNING;
  }
  if (job?.recurring?.paused) {
    return RECURRING_STATE_PAUSED;
  }
  return RECURRING_STATE_ACTIVE;
}

function matchesRecurringStateFilter(job, state) {
  const normalized = trim(state).toLowerCase();
  if (!normalized || normalized === "all") {
    return true;
  }
  if (!RECURRING_STATES.has(normalized)) {
    return false;
  }
  return resolveRecurringState(job) === normalized;
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

  const kind = normalizeJobKind(raw.kind);
  const recurring =
    kind === JOB_KIND_RECURRING
      ? normalizeRecurringSpec(raw.recurring ?? raw.rule, trim(raw.timezone) || DEFAULT_TIMEZONE)
      : null;
  if (kind === JOB_KIND_RECURRING && !recurring) {
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

  const timezone =
    kind === JOB_KIND_RECURRING
      ? recurring?.timezone || resolveSchedulerTimezone(raw.timezone, DEFAULT_TIMEZONE)
      : resolveSchedulerTimezone(raw.timezone, DEFAULT_TIMEZONE);
  const status = normalizeStatus(raw.status);
  const attemptsRaw = Number(raw.attempts);
  const attempts = Number.isFinite(attemptsRaw) && attemptsRaw >= 0 ? Math.floor(attemptsRaw) : 0;

  return {
    id,
    channel,
    chatId,
    sessionId,
    kind,
    prompt,
    runAtMs,
    runAt: new Date(runAtMs).toISOString(),
    timezone,
    recurring: recurring || undefined,
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

function formatLocalDateTime(local) {
  return `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(
    2,
    "0",
  )} ${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}:${String(local.second).padStart(
    2,
    "0",
  )}`;
}

function resolveLocalDateFromUtcMs(utcMs, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const map = Object.create(null);
  for (const entry of parts) {
    map[entry.type] = entry.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
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
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
  };
}

function addDaysToLocalDate(localDate, days) {
  const baseUtc = Date.UTC(localDate.year, localDate.month - 1, localDate.day);
  const next = new Date(baseUtc + Math.floor(days) * 24 * 60 * 60 * 1000);
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function resolveWeekdayTokenFromLocalDate(localDate) {
  const utcDay = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day)).getUTCDay();
  return WEEKDAY_TOKENS[utcDay] || "";
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

export function formatDateTimeInTimezone(utcMs, timezone) {
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

function resolveUtcFromLocalDateTime(local, timezone) {
  const utcGuess = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const offset1 = resolveTimezoneOffsetMinutes(utcGuess, timezone);
  let runAtMs = utcGuess - offset1 * 60_000;
  const offset2 = resolveTimezoneOffsetMinutes(runAtMs, timezone);
  if (offset2 !== offset1) {
    runAtMs = utcGuess - offset2 * 60_000;
  }

  const renderedLocal = formatDateTimeInTimezone(runAtMs, timezone);
  const expectedLocal = formatLocalDateTime(local);
  if (renderedLocal !== expectedLocal) {
    return {
      ok: false,
      error: `The local time ${expectedLocal} is not valid in timezone ${timezone}.`,
    };
  }
  return {
    ok: true,
    runAtMs,
  };
}

function resolveNextRecurringRunAtMs({ recurring, afterUtcMs }) {
  const safeAfterUtcMs = Number.isFinite(Number(afterUtcMs)) ? Number(afterUtcMs) : Date.now();
  const timezone = resolveSchedulerTimezone(recurring?.timezone, DEFAULT_TIMEZONE);
  const frequency = normalizeRecurringFrequency(recurring?.frequency);
  const hour = normalizeNumberInRange(recurring?.hour, 0, 23);
  const minute = normalizeNumberInRange(recurring?.minute, 0, 59, 0);
  const second = normalizeNumberInRange(recurring?.second, 0, 59, 0);
  if (!frequency || hour === null || minute === null || second === null) {
    return {
      ok: false,
      error: "Invalid recurring schedule settings.",
    };
  }

  const weekdays =
    frequency === RECURRING_FREQUENCY_WEEKLY ? normalizeRecurringWeekdays(recurring?.weekdays) : [];
  if (frequency === RECURRING_FREQUENCY_WEEKLY && weekdays.length === 0) {
    return {
      ok: false,
      error: "weekdays is required for weekly recurring schedules.",
    };
  }

  const baseLocal = resolveLocalDateFromUtcMs(safeAfterUtcMs + 1_000, timezone);
  if (!baseLocal) {
    return {
      ok: false,
      error: `Could not resolve local date in timezone ${timezone}.`,
    };
  }

  const weekdaysSet = new Set(weekdays);
  const maxDays = frequency === RECURRING_FREQUENCY_DAILY ? 370 : 380;
  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset += 1) {
    const day = addDaysToLocalDate(baseLocal, dayOffset);
    if (frequency === RECURRING_FREQUENCY_WEEKLY) {
      const weekday = resolveWeekdayTokenFromLocalDate(day);
      if (!weekdaysSet.has(weekday)) {
        continue;
      }
    }
    const localCandidate = {
      year: day.year,
      month: day.month,
      day: day.day,
      hour,
      minute,
      second,
    };
    const resolved = resolveUtcFromLocalDateTime(localCandidate, timezone);
    if (!resolved.ok) {
      continue;
    }
    if (resolved.runAtMs > safeAfterUtcMs) {
      return {
        ok: true,
        runAtMs: resolved.runAtMs,
        timezone,
      };
    }
  }

  return {
    ok: false,
    error: "Could not resolve the next recurring run time.",
  };
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

  const fromArg = trim(timezone);
  const fromDefault = trim(defaultTimezone);
  if (!fromArg && !fromDefault) {
    return {
      ok: false,
      error:
        "Timezone is required for local runAt without offset. Set timezone first, or include offset in runAt.",
    };
  }
  const targetTimezone = resolveSchedulerTimezone(fromArg, fromDefault || DEFAULT_TIMEZONE);
  const resolved = resolveUtcFromLocalDateTime(local, targetTimezone);
  if (!resolved.ok) {
    return {
      ok: false,
      error: `The local time ${rawRunAt} is not valid in timezone ${targetTimezone}.`,
    };
  }
  const runAtMs = resolved.runAtMs;

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
    kind: job?.kind || JOB_KIND_ONE_TIME,
    status: job.status,
    prompt: job.prompt,
    timezone: targetTimezone,
    runAtUtc: new Date(runAtMs).toISOString(),
    runAtLocal: formatDateTimeInTimezone(runAtMs, targetTimezone),
    secondsUntilRun:
      Number.isFinite(runAtMs) && runAtMs > nowMs ? Math.max(0, Math.round((runAtMs - nowMs) / 1000)) : 0,
    createdAtUtc: createdAtMs ? new Date(createdAtMs).toISOString() : undefined,
    updatedAtUtc: updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined,
    attempts: Number(job?.attempts) || 0,
    lastError: trim(job?.lastError) || undefined,
  };
}

function serializeRecurringJob(job, timezone, nowMs = Date.now()) {
  const recurring = normalizeRecurringSpec(job?.recurring, job?.timezone || DEFAULT_TIMEZONE);
  const targetTimezone = resolveSchedulerTimezone(timezone, recurring?.timezone || job?.timezone || DEFAULT_TIMEZONE);
  const runAtMs = Number(job?.runAtMs);
  const createdAtMs = parseTimestamp(job?.createdAt);
  const updatedAtMs = parseTimestamp(job?.updatedAt);
  return {
    id: job.id,
    kind: JOB_KIND_RECURRING,
    state: resolveRecurringState(job),
    status: job.status,
    prompt: job.prompt,
    timezone: targetTimezone,
    frequency: recurring?.frequency || "",
    weekdays: Array.isArray(recurring?.weekdays) ? recurring.weekdays : [],
    hour: Number.isFinite(Number(recurring?.hour)) ? Number(recurring.hour) : null,
    minute: Number.isFinite(Number(recurring?.minute)) ? Number(recurring.minute) : null,
    second: Number.isFinite(Number(recurring?.second)) ? Number(recurring.second) : null,
    nextRunUtc: Number.isFinite(runAtMs) ? new Date(runAtMs).toISOString() : undefined,
    nextRunLocal: Number.isFinite(runAtMs) ? formatDateTimeInTimezone(runAtMs, targetTimezone) : undefined,
    secondsUntilRun:
      Number.isFinite(runAtMs) && runAtMs > nowMs ? Math.max(0, Math.round((runAtMs - nowMs) / 1000)) : 0,
    paused: Boolean(recurring?.paused),
    runCount: Number.isFinite(Number(recurring?.runCount)) ? Number(recurring.runCount) : 0,
    createdAtUtc: createdAtMs ? new Date(createdAtMs).toISOString() : undefined,
    updatedAtUtc: updatedAtMs ? new Date(updatedAtMs).toISOString() : undefined,
    lastScheduledAtUtc: trim(recurring?.lastScheduledAt) || undefined,
    lastCompletedAtUtc: trim(recurring?.lastCompletedAt) || undefined,
    lastFailedAtUtc: trim(recurring?.lastFailedAt) || undefined,
    pausedAtUtc: trim(recurring?.pausedAt) || undefined,
    resumedAtUtc: trim(recurring?.resumedAt) || undefined,
    attempts: Number(job?.attempts) || 0,
    lastError: trim(job?.lastError) || undefined,
  };
}

export async function createScheduledJob(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  const sessionId = trim(params?.sessionId);
  const prompt = clampText(params?.prompt, MAX_PROMPT_CHARS);
  const rawDefaultTimezone = trim(params?.defaultTimezone);
  const defaultTimezone = rawDefaultTimezone && isValidTimezone(rawDefaultTimezone) ? rawDefaultTimezone : "";
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
    kind: JOB_KIND_ONE_TIME,
    prompt,
    runAtMs,
    timezone: resolvedRunAt.timezone || defaultTimezone,
    status: JOB_STATUS_PENDING,
    attempts: 0,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  });
  if (!job) {
    return {
      ok: false,
      error: "Failed to build scheduled job payload.",
    };
  }

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

export async function createRecurringScheduledJob(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  const sessionId = trim(params?.sessionId);
  const prompt = clampText(params?.prompt, MAX_PROMPT_CHARS);
  const rawDefaultTimezone = trim(params?.defaultTimezone);
  const defaultTimezone = rawDefaultTimezone && isValidTimezone(rawDefaultTimezone) ? rawDefaultTimezone : "";
  const timezoneArg = trim(params?.timezone);
  const timezone = resolveSchedulerTimezone(timezoneArg, defaultTimezone || DEFAULT_TIMEZONE);
  const frequency = normalizeRecurringFrequency(params?.frequency);
  const hour = normalizeNumberInRange(params?.hour, 0, 23);
  const minute = normalizeNumberInRange(params?.minute, 0, 59, 0);
  const weekdays = normalizeRecurringWeekdays(params?.weekdays);
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
  if (timezoneArg && !isValidTimezone(timezoneArg)) {
    return {
      ok: false,
      error: "Invalid timezone. Use IANA timezone like Asia/Seoul, Europe/London, or America/New_York.",
    };
  }
  if (!timezoneArg && !defaultTimezone) {
    return {
      ok: false,
      error: "Timezone is required for recurring schedules. Set timezone first, or pass timezone explicitly.",
    };
  }
  if (!frequency) {
    return {
      ok: false,
      error: "frequency is required. Use daily or weekly.",
    };
  }
  if (hour === null) {
    return {
      ok: false,
      error: "hour is required (0-23).",
    };
  }
  if (minute === null) {
    return {
      ok: false,
      error: "minute must be between 0 and 59.",
    };
  }
  if (frequency === RECURRING_FREQUENCY_WEEKLY && weekdays.length === 0) {
    return {
      ok: false,
      error: "weekdays is required for weekly recurring schedules (MO..SU).",
    };
  }

  const recurring = normalizeRecurringSpec(
    {
      frequency,
      weekdays,
      hour,
      minute,
      second: 0,
      timezone,
      paused: false,
      runCount: 0,
    },
    timezone,
  );
  if (!recurring) {
    return {
      ok: false,
      error: "Invalid recurring schedule settings.",
    };
  }

  const nextRun = resolveNextRecurringRunAtMs({
    recurring,
    afterUtcMs: nowMs,
  });
  if (!nextRun.ok) {
    return {
      ok: false,
      error: nextRun.error,
    };
  }

  recurring.lastScheduledAt = new Date(nextRun.runAtMs).toISOString();
  const job = normalizeJob({
    id: buildJobId(),
    channel,
    chatId,
    sessionId,
    kind: JOB_KIND_RECURRING,
    prompt,
    runAtMs: nextRun.runAtMs,
    timezone,
    recurring,
    status: JOB_STATUS_PENDING,
    attempts: 0,
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  });
  if (!job) {
    return {
      ok: false,
      error: "Failed to build recurring scheduled job payload.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const nextStore = normalizeStore({
    ...loaded.store,
    jobs: [...(loaded.store.jobs ?? []), job],
  });
  await saveStore(nextStore, params?.customConfigPath);

  const displayTimezone = resolveSchedulerTimezone(params?.displayTimezone, timezone);
  return {
    ok: true,
    recurring: serializeRecurringJob(job, displayTimezone, nowMs),
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
    .filter((job) => job.channel === channel && job.chatId === chatId && job.kind !== JOB_KIND_RECURRING)
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

export async function listRecurringScheduledJobs(params) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  if (!channel || !chatId) {
    return {
      ok: false,
      error: "Missing runtime channel/chat context.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const stateRaw = trim(params?.state).toLowerCase();
  const state = RECURRING_STATES.has(stateRaw) ? stateRaw : "all";
  const limitRaw = Number(params?.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : DEFAULT_LIST_LIMIT;
  const nowMs = Date.now();
  const displayTimezone = resolveSchedulerTimezone(params?.displayTimezone, params?.defaultTimezone);

  const filtered = (loaded.store.jobs ?? [])
    .filter((job) => job.channel === channel && job.chatId === chatId && job.kind === JOB_KIND_RECURRING)
    .filter((job) => matchesRecurringStateFilter(job, state))
    .sort((a, b) => a.runAtMs - b.runAtMs)
    .slice(0, limit);

  return {
    ok: true,
    state,
    timezone: displayTimezone,
    count: filtered.length,
    jobs: filtered.map((job) => serializeRecurringJob(job, displayTimezone, nowMs)),
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
    if (job.kind === JOB_KIND_RECURRING) {
      return job;
    }
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
  if (found.kind === JOB_KIND_RECURRING) {
    return {
      ok: false,
      error: "Use schedule_recurring_delete for recurring schedules.",
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

async function updateRecurringSchedule(params, updater) {
  const channel = trim(params?.channel).toLowerCase();
  const chatId = trim(params?.chatId);
  const recurringId = trim(params?.recurringId);
  if (!channel || !chatId || !recurringId) {
    return {
      ok: false,
      error: "channel/chatId/recurringId are required.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let found = null;
  let transformed = null;

  const nextJobs = (loaded.store.jobs ?? []).map((job) => {
    if (
      job.id !== recurringId ||
      job.channel !== channel ||
      job.chatId !== chatId ||
      job.kind !== JOB_KIND_RECURRING
    ) {
      return job;
    }
    found = job;
    const result = updater(job, { nowMs, nowIso });
    if (!result?.ok) {
      transformed = result;
      return job;
    }
    transformed = result;
    return normalizeJob({
      ...job,
      ...result.jobPatch,
      updatedAt: nowIso,
    });
  });

  if (!found) {
    return {
      ok: false,
      error: "recurring_not_found",
    };
  }
  if (!transformed?.ok) {
    return transformed || { ok: false, error: "recurring_update_failed" };
  }

  const nextStore = normalizeStore({
    ...loaded.store,
    jobs: nextJobs,
  });
  await saveStore(nextStore, params?.customConfigPath);
  const updated = nextStore.jobs.find((job) => job.id === recurringId);
  const displayTimezone = resolveSchedulerTimezone(params?.displayTimezone, params?.defaultTimezone);
  return {
    ok: true,
    recurring: serializeRecurringJob(updated, displayTimezone, nowMs),
  };
}

export async function deleteRecurringScheduledJob(params) {
  return await updateRecurringSchedule(params, (job, ctx) => {
    if (job.status === JOB_STATUS_CANCELED) {
      return {
        ok: false,
        error: "Recurring schedule is already canceled.",
      };
    }
    const recurring = normalizeRecurringSpec(job.recurring, job.timezone);
    return {
      ok: true,
      jobPatch: {
        status: JOB_STATUS_CANCELED,
        canceledAt: ctx.nowIso,
        recurring: recurring
          ? {
              ...recurring,
              paused: false,
            }
          : job.recurring,
      },
    };
  });
}

export async function pauseRecurringScheduledJob(params) {
  return await updateRecurringSchedule(params, (job, ctx) => {
    if (job.status === JOB_STATUS_CANCELED) {
      return {
        ok: false,
        error: "Cannot pause a canceled recurring schedule.",
      };
    }
    const recurring = normalizeRecurringSpec(job.recurring, job.timezone);
    if (!recurring) {
      return {
        ok: false,
        error: "Recurring schedule payload is invalid.",
      };
    }
    if (recurring.paused) {
      return {
        ok: true,
        jobPatch: {
          recurring,
        },
      };
    }
    return {
      ok: true,
      jobPatch: {
        recurring: {
          ...recurring,
          paused: true,
          pausedAt: ctx.nowIso,
        },
      },
    };
  });
}

export async function resumeRecurringScheduledJob(params) {
  return await updateRecurringSchedule(params, (job, ctx) => {
    if (job.status === JOB_STATUS_CANCELED) {
      return {
        ok: false,
        error: "Cannot resume a canceled recurring schedule.",
      };
    }
    const recurring = normalizeRecurringSpec(job.recurring, job.timezone);
    if (!recurring) {
      return {
        ok: false,
        error: "Recurring schedule payload is invalid.",
      };
    }

    const nextRun = resolveNextRecurringRunAtMs({
      recurring: {
        ...recurring,
        paused: false,
      },
      afterUtcMs: ctx.nowMs,
    });
    if (!nextRun.ok) {
      return {
        ok: false,
        error: nextRun.error,
      };
    }

    return {
      ok: true,
      jobPatch: {
        status: JOB_STATUS_PENDING,
        runAtMs: nextRun.runAtMs,
        runAt: new Date(nextRun.runAtMs).toISOString(),
        recurring: {
          ...recurring,
          paused: false,
          resumedAt: ctx.nowIso,
          lastScheduledAt: new Date(nextRun.runAtMs).toISOString(),
        },
      },
    };
  });
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
    .filter((job) => !(job.kind === JOB_KIND_RECURRING && job.recurring?.paused))
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

async function finalizeScheduledJob(params, options = {}) {
  const jobId = trim(params?.jobId);
  if (!jobId) {
    return {
      ok: false,
      error: "jobId is required.",
    };
  }

  const loaded = await loadStore(params?.customConfigPath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const failed = Boolean(options?.failed);
  const failureError = clampText(options?.error, MAX_ERROR_CHARS);
  let found = null;
  const nextJobs = (loaded.store.jobs ?? []).map((job) => {
    if (job.id !== jobId) {
      return job;
    }
    found = job;

    if (job.kind === JOB_KIND_RECURRING) {
      const recurring = normalizeRecurringSpec(job.recurring, job.timezone);
      if (!recurring) {
        return normalizeJob({
          ...job,
          status: JOB_STATUS_FAILED,
          failedAt: nowIso,
          lastError: "Recurring schedule payload is invalid.",
          updatedAt: nowIso,
        });
      }

      const nextRun = resolveNextRecurringRunAtMs({
        recurring,
        afterUtcMs: nowMs,
      });
      if (!nextRun.ok) {
        return normalizeJob({
          ...job,
          status: JOB_STATUS_FAILED,
          failedAt: nowIso,
          lastError: clampText(nextRun.error, MAX_ERROR_CHARS),
          updatedAt: nowIso,
        });
      }

      const nextRunIso = new Date(nextRun.runAtMs).toISOString();
      const runCount = Number.isFinite(Number(recurring.runCount)) ? Number(recurring.runCount) : 0;
      return normalizeJob({
        ...job,
        status: JOB_STATUS_PENDING,
        runAtMs: nextRun.runAtMs,
        runAt: nextRunIso,
        recurring: {
          ...recurring,
          runCount: failed ? runCount : runCount + 1,
          lastScheduledAt: nextRunIso,
          ...(failed ? { lastFailedAt: nowIso } : { lastCompletedAt: nowIso }),
        },
        lastError: failed ? failureError : "",
        completedAt: undefined,
        failedAt: undefined,
        updatedAt: nowIso,
      });
    }

    return normalizeJob({
      ...job,
      status: failed ? JOB_STATUS_FAILED : JOB_STATUS_COMPLETED,
      updatedAt: nowIso,
      ...(failed ? { failedAt: nowIso, lastError: failureError } : { completedAt: nowIso, lastError: "" }),
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
  return await finalizeScheduledJob(params, {
    failed: false,
  });
}

export async function markScheduledJobFailed(params) {
  return await finalizeScheduledJob(params, {
    failed: true,
    error: params?.error,
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
    .filter((job) => !(job.kind === JOB_KIND_RECURRING && job.recurring?.paused))
    .sort((a, b) => a.runAtMs - b.runAtMs)[0];
  if (!next) {
    return null;
  }
  const diffMs = Math.max(0, next.runAtMs - nowMs);
  const seconds = Math.max(1, Math.ceil(diffMs / 1000));
  return Math.min(maxSeconds, seconds);
}
