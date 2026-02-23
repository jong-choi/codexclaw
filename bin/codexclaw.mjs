#!/usr/bin/env node
import { loadConfig } from "../src/config-store.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

function printHelp() {
  process.stdout.write(
    [
      "tele-codex - minimal Codex + Telegram bridge",
      "",
      "Usage:",
      "  tele-codex onboard [--config <path>]",
      "  tele-codex telegram run [--config <path>]",
      "  tele-codex config show [--config <path>]",
      "",
      "Notes:",
      "  - onboard: OAuth + model select + telegram setup + optional Notion skill key",
      "  - telegram run: start long-polling bot",
    ].join("\n"),
  );
}

function maskSecret(value) {
  const raw = trim(value);
  if (!raw) {
    return raw;
  }
  if (raw.length <= 8) {
    return "*".repeat(raw.length);
  }
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

function readGlobalOptions(args) {
  const rest = [];
  let configPath;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--config") {
      const next = args[i + 1];
      if (!next) {
        throw new Error("--config requires a path value");
      }
      configPath = next;
      i += 1;
      continue;
    }
    rest.push(arg);
  }

  return { rest, configPath };
}

function redactConfig(config) {
  const next = JSON.parse(JSON.stringify(config ?? {}));
  if (next?.telegram?.botToken) {
    next.telegram.botToken = maskSecret(next.telegram.botToken);
  }
  if (next?.codex?.oauth?.access) {
    next.codex.oauth.access = maskSecret(next.codex.oauth.access);
  }
  if (next?.codex?.oauth?.refresh) {
    next.codex.oauth.refresh = maskSecret(next.codex.oauth.refresh);
  }
  if (next?.skills?.entries && typeof next.skills.entries === "object") {
    for (const [skillKey, entry] of Object.entries(next.skills.entries)) {
      if (entry && typeof entry === "object" && "apiKey" in entry && entry.apiKey) {
        next.skills.entries[skillKey] = {
          ...entry,
          apiKey: maskSecret(entry.apiKey),
        };
      }
    }
  }
  return next;
}

async function main() {
  const parsed = readGlobalOptions(process.argv.slice(2));
  const [command, subcommand] = parsed.rest;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    printHelp();
    return;
  }

  if (command === "onboard") {
    const { runOnboard } = await import("../src/onboard.mjs");
    await runOnboard({ configPath: parsed.configPath });
    return;
  }

  if (command === "telegram" && subcommand === "run") {
    const { runTelegramBot } = await import("../src/telegram-bot.mjs");
    await runTelegramBot({ configPath: parsed.configPath });
    return;
  }

  if (command === "config" && subcommand === "show") {
    const loaded = await loadConfig(parsed.configPath);
    if (!loaded.config) {
      process.stdout.write(`No config found: ${loaded.path}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(redactConfig(loaded.config), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${parsed.rest.join(" ")}`);
}

main().catch((error) => {
  process.stderr.write(`${trim(error?.message) || String(error)}\n`);
  process.exitCode = 1;
});
