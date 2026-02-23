import { loadConfig, saveConfig } from "./config-store.mjs";
import {
  CODEX_MODEL_IDS,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
  NOTION_API_ENV_NAME,
  NOTION_SKILL_KEY,
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

function resolveSkillEntries(config) {
  if (!config || typeof config !== "object") {
    return {};
  }
  const entries = config.skills?.entries;
  if (!entries || typeof entries !== "object") {
    return {};
  }
  return { ...entries };
}

function resolveSkillApiKey(config, skillKey) {
  return trim(config?.skills?.entries?.[skillKey]?.apiKey);
}

function resolveNotionSkillEnabled(config) {
  return Boolean(resolveSkillApiKey(config, NOTION_SKILL_KEY));
}

export async function runOnboard(options = {}) {
  const loaded = await loadConfig(options.configPath);
  const existing = loaded.config ?? {};

  const next = {
    ...existing,
    codex: { ...(existing.codex ?? {}) },
    telegram: { ...(existing.telegram ?? {}) },
    skills: {
      ...(existing.skills ?? {}),
      entries: resolveSkillEntries(existing),
    },
  };

  await withPrompter(async (prompter) => {
    prompter.intro("CodexClaw onboarding");
    prompter.note(
      [
        "This setup includes only 4 steps:",
        "1) OpenAI Codex OAuth",
        "2) Choose one Codex model",
        "3) Configure Telegram bot",
        "4) Optional: configure Notion skill API key",
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

    const existingNotionKey = resolveSkillApiKey(next, NOTION_SKILL_KEY);
    let configureNotion = false;
    let notionApiKey = existingNotionKey;

    if (existingNotionKey) {
      const keep = await prompter.confirm({
        message: "Existing Notion API key found. Keep it?",
        initialValue: true,
      });
      if (keep) {
        configureNotion = true;
      } else {
        configureNotion = await prompter.confirm({
          message: "Configure Notion skill with a new API key now?",
          initialValue: false,
        });
        notionApiKey = "";
      }
    } else {
      configureNotion = await prompter.confirm({
        message: "Enable Notion skill now? (optional)",
        initialValue: false,
      });
    }

    if (configureNotion && !notionApiKey) {
      prompter.note(
        [
          "Create a Notion integration at https://notion.so/my-integrations",
          "Copy the internal integration token (starts with ntn_ or secret_).",
        ].join("\n"),
        "Notion API key",
      );
      notionApiKey = await prompter.text({
        message: "Notion API key",
        required: true,
      });
    }

    const nextSkillEntries = resolveSkillEntries(next);
    if (configureNotion) {
      nextSkillEntries[NOTION_SKILL_KEY] = {
        ...(nextSkillEntries[NOTION_SKILL_KEY] ?? {}),
        apiKey: trim(notionApiKey),
      };
    } else {
      delete nextSkillEntries[NOTION_SKILL_KEY];
    }

    if (Object.keys(nextSkillEntries).length > 0) {
      next.skills = {
        ...next.skills,
        entries: nextSkillEntries,
      };
    } else if (next.skills && typeof next.skills === "object") {
      const { entries, ...restSkills } = next.skills;
      if (Object.keys(restSkills).length > 0) {
        next.skills = restSkills;
      } else {
        delete next.skills;
      }
    }

    const saved = await saveConfig(next, loaded.path);
    const notionEnabled = resolveNotionSkillEnabled(saved.config);

    prompter.outro(
      [
        `Saved config: ${saved.path}`,
        `Model: ${saved.config?.codex?.model?.ref}`,
        "Telegram DM policy: pairing (default)",
        `Notion skill: ${notionEnabled ? "enabled" : "disabled"}`,
        notionEnabled
          ? `Notion auth source: skills.entries.${NOTION_SKILL_KEY}.apiKey -> ${NOTION_API_ENV_NAME}`
          : "Notion auth source: not configured",
        "First DM the bot in Telegram to receive a pairing code.",
        "Approve by entering the pairing code in the running bot terminal.",
        "Press Enter on an empty line to ignore.",
        "Conversation context is persisted between turns.",
        "Use /new to reset context, /context to inspect history size.",
        "Run: npm run telegram",
      ].join("\n"),
    );
  });
}
