import path from "node:path";
import { loadConfig, saveConfig } from "./config-store.mjs";
import {
  BRAVE_API_ENV_NAME,
  CODEX_MODEL_IDS,
  CODEX_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
  NOTION_API_ENV_NAME,
  NOTION_SKILL_KEY,
  WORKSPACE_DEFAULT_ROOT_DIR,
  WEB_FETCH_SKILL_KEY,
  WEB_SEARCH_SKILL_KEY,
} from "./constants.mjs";
import { loginCodexOAuth } from "./oauth.mjs";
import { withPrompter } from "./prompt.mjs";
import { ensureWorkspaceInitialized, inspectWorkspace, resolveWorkspaceRoot } from "./workspace.mjs";

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

function resolveSkillEnabled(config, skillKey) {
  const entry = config?.skills?.entries?.[skillKey];
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (typeof entry.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveNotionSkillEnabled(config) {
  return Boolean(resolveSkillApiKey(config, NOTION_SKILL_KEY));
}

function resolveWebSearchSkillEnabled(config) {
  return resolveSkillEnabled(config, WEB_SEARCH_SKILL_KEY);
}

function resolveWebFetchSkillEnabled(config) {
  return resolveSkillEnabled(config, WEB_FETCH_SKILL_KEY);
}

function resolveConfiguredWorkspaceRoot(config) {
  const fromConfig = trim(config?.workspace?.root);
  if (fromConfig) {
    return resolveWorkspaceRoot(fromConfig);
  }
  return path.resolve(process.cwd(), WORKSPACE_DEFAULT_ROOT_DIR);
}

export async function runOnboard(options = {}) {
  const loaded = await loadConfig(options.configPath);
  const existing = loaded.config ?? {};
  const workspaceRoot = resolveConfiguredWorkspaceRoot(existing);

  const next = {
    ...existing,
    codex: { ...(existing.codex ?? {}) },
    telegram: { ...(existing.telegram ?? {}) },
    workspace: {
      ...(existing.workspace ?? {}),
      root: workspaceRoot,
    },
    skills: {
      ...(existing.skills ?? {}),
      entries: resolveSkillEntries(existing),
    },
  };

  await withPrompter(async (prompter) => {
    prompter.intro("CodexClaw onboarding");
    prompter.note(
      [
        "This setup includes only 5 steps:",
        "1) OpenAI Codex OAuth",
        "2) Choose one Codex model",
        "3) Configure Telegram bot",
        "4) Optional: configure Notion skill API key",
        "5) Optional: configure web_search/web_fetch skills",
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

    const existingWebSearchEnabled = resolveWebSearchSkillEnabled(next);
    const existingWebSearchApiKey = resolveSkillApiKey(next, WEB_SEARCH_SKILL_KEY);
    let enableWebSearch = false;
    let webSearchApiKey = existingWebSearchApiKey;

    if (existingWebSearchEnabled) {
      const keep = await prompter.confirm({
        message: "Web search skill is enabled. Keep it?",
        initialValue: true,
      });
      if (keep) {
        enableWebSearch = true;
      } else {
        enableWebSearch = await prompter.confirm({
          message: "Enable web_search skill now? (optional)",
          initialValue: false,
        });
        webSearchApiKey = "";
      }
    } else {
      enableWebSearch = await prompter.confirm({
        message: "Enable web_search skill now? (optional)",
        initialValue: false,
      });
    }

    if (enableWebSearch && existingWebSearchApiKey && webSearchApiKey) {
      const keep = await prompter.confirm({
        message: "Existing Brave Search API key found. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        webSearchApiKey = "";
      }
    }

    if (enableWebSearch && !webSearchApiKey) {
      prompter.note(
        [
          "Create a Brave Search API key at https://brave.com/search/api/",
          "Use the Data for Search plan and copy the API key.",
        ].join("\n"),
        "Brave API key",
      );
      webSearchApiKey = await prompter.text({
        message: "Brave Search API key",
        required: true,
      });
    }

    const existingWebFetchEnabled = resolveWebFetchSkillEnabled(next);
    let enableWebFetch = false;

    if (existingWebFetchEnabled) {
      const keep = await prompter.confirm({
        message: "Web fetch skill is enabled. Keep it?",
        initialValue: true,
      });
      if (keep) {
        enableWebFetch = true;
      } else {
        enableWebFetch = await prompter.confirm({
          message: "Enable web_fetch skill now? (optional)",
          initialValue: false,
        });
      }
    } else {
      enableWebFetch = await prompter.confirm({
        message: "Enable web_fetch skill now? (optional)",
        initialValue: false,
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

    if (enableWebSearch) {
      nextSkillEntries[WEB_SEARCH_SKILL_KEY] = {
        ...(nextSkillEntries[WEB_SEARCH_SKILL_KEY] ?? {}),
        enabled: true,
        apiKey: trim(webSearchApiKey),
      };
    } else {
      delete nextSkillEntries[WEB_SEARCH_SKILL_KEY];
    }

    if (enableWebFetch) {
      nextSkillEntries[WEB_FETCH_SKILL_KEY] = {
        ...(nextSkillEntries[WEB_FETCH_SKILL_KEY] ?? {}),
        enabled: true,
      };
    } else {
      delete nextSkillEntries[WEB_FETCH_SKILL_KEY];
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

    const workspaceState = await inspectWorkspace({
      workspaceRoot: next.workspace?.root,
    });
    let resetWorkspaceFromTemplate = false;
    if (workspaceState.populated) {
      resetWorkspaceFromTemplate = await prompter.confirm({
        message: `Existing workspace detected at ${workspaceState.workspaceRoot}. Initialize from template?`,
        initialValue: false,
      });
    }

    const saved = await saveConfig(next, loaded.path);
    const workspaceInit = await ensureWorkspaceInitialized({
      workspaceRoot: saved.config?.workspace?.root,
      forceReset: resetWorkspaceFromTemplate,
    });
    const notionEnabled = resolveNotionSkillEnabled(saved.config);
    const webSearchEnabled = resolveWebSearchSkillEnabled(saved.config);
    const webSearchKeyConfigured = Boolean(resolveSkillApiKey(saved.config, WEB_SEARCH_SKILL_KEY));
    const webFetchEnabled = resolveWebFetchSkillEnabled(saved.config);

    prompter.outro(
      [
        `Saved config: ${saved.path}`,
        `Model: ${saved.config?.codex?.model?.ref}`,
        "Telegram DM policy: pairing (default)",
        `Notion skill: ${notionEnabled ? "enabled" : "disabled"}`,
        notionEnabled
          ? `Notion auth source: skills.entries.${NOTION_SKILL_KEY}.apiKey -> ${NOTION_API_ENV_NAME}`
          : "Notion auth source: not configured",
        `Web search skill: ${webSearchEnabled ? "enabled" : "disabled"}`,
        webSearchEnabled
          ? webSearchKeyConfigured
            ? `Web search auth source: skills.entries.${WEB_SEARCH_SKILL_KEY}.apiKey -> ${BRAVE_API_ENV_NAME}`
            : `Web search auth source: missing (${BRAVE_API_ENV_NAME} not configured)`
          : "Web search auth source: not configured",
        `Web fetch skill: ${webFetchEnabled ? "enabled" : "disabled"}`,
        `Workspace root: ${workspaceInit.workspaceRoot}`,
        `Workspace template: ${workspaceInit.templateRoot}`,
        `Workspace template copied: ${workspaceInit.seededFromTemplate ? "yes" : "no (already initialized)"}`,
        `Workspace reset from template: ${workspaceInit.forceReset ? "yes" : "no"}`,
        "First DM the bot in Telegram to receive a pairing code.",
        "Approve by entering the pairing code in the running bot terminal.",
        "Press Enter on an empty line to ignore.",
        "Type bye or exit in the bot terminal to stop telegram run (/bye, /exit also work).",
        "Conversation context is persisted between turns.",
        "Use /new to reset context, /context to inspect history size.",
        "Bot sends proactive status updates by default (set telegram.proactiveStatus=false to disable).",
        "Run: npm run telegram",
      ].join("\n"),
    );
  });
}
