import { loadConfig, saveConfig } from "./config-store.mjs";
import {
  CODEX_MODEL_IDS,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
} from "./constants.mjs";
import { loginCodexOAuth } from "./oauth.mjs";
import { withPrompter } from "./prompt.mjs";

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

function normalizeAllowFrom(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return Array.from(
    new Set(
      raw
        .map((value) => trim(value))
        .filter(Boolean),
    ),
  );
}

function resolveCurrentModelId(config) {
  const direct = normalizeCodexModelId(config?.codex?.model?.id);
  if (direct) {
    return direct;
  }
  const ref = trim(config?.codex?.model?.ref);
  if (!ref) {
    return "";
  }
  const slash = ref.indexOf("/");
  return normalizeCodexModelId(slash < 0 ? ref : ref.slice(slash + 1));
}

function resolveModelRef(modelId) {
  return `${CODEX_PROVIDER_ID}/${trim(modelId)}`;
}

export async function runOnboard(options = {}) {
  const loaded = await loadConfig(options.configPath);
  const existing = loaded.config ?? {};

  const next = {
    ...existing,
    codex: { ...(existing.codex ?? {}) },
    telegram: { ...(existing.telegram ?? {}) },
  };

  await withPrompter(async (prompter) => {
    prompter.intro("CodexClaw onboarding");
    prompter.note(
      [
        "This setup includes only 3 steps:",
        "1) OpenAI Codex OAuth",
        "2) Choose one Codex model",
        "3) Configure Telegram bot",
      ].join("\n"),
      "Scope",
    );

    await prompter.select({
      message: "Auth provider",
      options: [
        {
          value: "openai-codex",
          label: "OpenAI Codex (OAuth)",
          hint: "ChatGPT OAuth login",
        },
      ],
    });

    const hasExistingOAuth = Boolean(next.codex?.oauth?.access);
    let shouldRunOAuth = true;
    if (hasExistingOAuth) {
      shouldRunOAuth = !(await prompter.confirm({
        message: "Existing Codex OAuth found. Keep it?",
        initialValue: true,
      }));
    }

    if (shouldRunOAuth) {
      const oauth = await loginCodexOAuth({
        prompter,
        log: (line) => process.stdout.write(`${line}\n`),
        error: (line) => process.stderr.write(`${line}\n`),
      });

      if (!oauth) {
        throw new Error("Codex OAuth did not return credentials.");
      }

      next.codex = {
        ...next.codex,
        oauth,
      };
    }

    const currentModelId = resolveCurrentModelId(next);
    const modelOptions = CODEX_MODEL_IDS.map((id) => ({
      value: id,
      label: resolveModelRef(id),
      hint: id === currentModelId ? "current" : undefined,
    }));

    const selectedModelId = await prompter.select({
      message: "Select Codex model",
      options: modelOptions,
    });

    next.codex = {
      ...next.codex,
      model: {
        id: trim(selectedModelId),
        ref: resolveModelRef(selectedModelId),
      },
    };

    const existingToken = trim(next.telegram?.botToken);
    let botToken = existingToken;
    if (existingToken) {
      const keepToken = await prompter.confirm({
        message: "Existing Telegram bot token found. Keep it?",
        initialValue: true,
      });
      if (!keepToken) {
        botToken = "";
      }
    }
    if (!botToken) {
      prompter.note(
        [
          "Create bot with @BotFather in Telegram.",
          "Use /newbot and copy bot token (format: 123456:ABC...).",
        ].join("\n"),
        "Telegram bot token",
      );
      botToken = await prompter.text({
        message: "Telegram bot token",
        required: true,
      });
    }

    const existingAllowFrom = normalizeAllowFrom(next.telegram?.allowFrom);
    const allowFrom = existingAllowFrom.filter((entry) => entry !== "*");

    next.telegram = {
      ...next.telegram,
      botToken: trim(botToken),
      dmPolicy: "pairing",
      allowFrom,
    };
    delete next.telegram.allowChatIds;

    const saved = await saveConfig(next, loaded.path);

    prompter.outro(
      [
        `Saved config: ${saved.path}`,
        `Model: ${saved.config?.codex?.model?.ref}`,
        "Telegram DM policy: pairing (default)",
        "First DM the bot in Telegram to receive a pairing code.",
        "Approve by entering the pairing code in the running bot terminal.",
        "Press Enter on an empty line to ignore.",
        "Run: npm run telegram",
      ].join("\n"),
    );
  });
}
