export const CODEX_PROVIDER_ID = "openai-codex";
export const QWEN_PROVIDER_ID = "qwen-portal";
export const OLLAMA_PROVIDER_ID = "ollama";
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const GROQ_PROVIDER_ID = "groq";
export const OPENAI_API_PROVIDER_ID = "openai-api";

export const CODEX_MODEL_IDS = [
  "gpt-5.1",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
];

export const LEGACY_CODEX_MODEL_ID_ALIASES = {
  "gpt-5.1-codex": "gpt-5.1",
};

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api";
export const QWEN_API_BASE_URL = "https://portal.qwen.ai/v1";
export const OLLAMA_API_BASE_URL = "http://127.0.0.1:11434";
export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_ENV_NAME = "OPENROUTER_API_KEY";
export const GROQ_API_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_API_ENV_NAME = "GROQ_API_KEY";
export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export const QWEN_MODEL_IDS = ["coder-model", "vision-model"];

export const TELEGRAM_API_BASE_URL = "https://api.telegram.org";

export const CONFIG_DIR_NAME = ".codexclaw";
export const CONFIG_FILE_NAME = "config.json";

export const CONFIG_VERSION = 1;

export const NOTION_SKILL_KEY = "notion";
export const NOTION_SKILL_DIR = "notion";
export const NOTION_API_ENV_NAME = "NOTION_API_KEY";
export const NOTION_API_BASE_URL = "https://api.notion.com";
export const NOTION_API_VERSION = "2025-09-03";

export const WEB_SEARCH_SKILL_KEY = "web_search";
export const WEB_SEARCH_SKILL_DIR = "web-search";
export const BRAVE_API_ENV_NAME = "BRAVE_API_KEY";
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const WEB_FETCH_SKILL_KEY = "web_fetch";
export const WEB_FETCH_SKILL_DIR = "web-fetch";

export const SCHEDULER_SKILL_KEY = "scheduler";
export const SCHEDULER_SKILL_DIR = "scheduler";
export const SCHEDULER_DEFAULT_TIMEZONE = "UTC";

export const TIME_CONTEXT_SKILL_KEY = "time_context";
export const TIME_CONTEXT_SKILL_DIR = "time-context";

export const WORKSPACE_FILES_SKILL_KEY = "workspace_files";
export const WORKSPACE_FILES_SKILL_DIR = "workspace-files";
export const WORKSPACE_DEFAULT_ROOT_DIR = ".codexclaw/workspace";
export const WORKSPACE_TEMPLATE_ROOT_DIR = ".codexclaw/initial-workspace";
export const WORKSPACE_MEMORY_FILE_NAME = "MEMORY.md";
export const WORKSPACE_INSTRUCTIONS_FILE_NAME = "INSTRUCTIONS.md";
