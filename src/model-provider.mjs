import {
  CODEX_MODEL_IDS,
  CODEX_PROVIDER_ID,
  GROQ_PROVIDER_ID,
  LEGACY_CODEX_MODEL_ID_ALIASES,
  OLLAMA_PROVIDER_ID,
  OPENAI_API_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  QWEN_MODEL_IDS,
  QWEN_PROVIDER_ID,
} from "./constants.mjs";

function trim(value) {
  return String(value ?? "").trim();
}

const PROVIDER_SPECS = {
  [CODEX_PROVIDER_ID]: {
    id: CODEX_PROVIDER_ID,
    label: "OpenAI Codex",
    shortLabel: "Codex",
    modelIds: CODEX_MODEL_IDS,
    modelAliases: LEGACY_CODEX_MODEL_ID_ALIASES,
    supportsUsageSnapshot: true,
    authMode: "oauth",
    supportsNestedModelIds: false,
  },
  [OPENAI_API_PROVIDER_ID]: {
    id: OPENAI_API_PROVIDER_ID,
    label: "OpenAI API (Compatible)",
    shortLabel: "OpenAI API",
    modelIds: [],
    modelAliases: {},
    supportsUsageSnapshot: false,
    authMode: "none",
    supportsNestedModelIds: true,
  },
  [QWEN_PROVIDER_ID]: {
    id: QWEN_PROVIDER_ID,
    label: "Qwen",
    shortLabel: "Qwen",
    modelIds: QWEN_MODEL_IDS,
    modelAliases: {},
    supportsUsageSnapshot: false,
    authMode: "oauth",
    supportsNestedModelIds: false,
  },
  [OLLAMA_PROVIDER_ID]: {
    id: OLLAMA_PROVIDER_ID,
    label: "Ollama",
    shortLabel: "Ollama",
    modelIds: [],
    modelAliases: {},
    supportsUsageSnapshot: false,
    authMode: "none",
    supportsNestedModelIds: true,
  },
  [OPENROUTER_PROVIDER_ID]: {
    id: OPENROUTER_PROVIDER_ID,
    label: "OpenRouter",
    shortLabel: "OpenRouter",
    modelIds: [],
    modelAliases: {},
    supportsUsageSnapshot: false,
    authMode: "none",
    supportsNestedModelIds: true,
  },
  [GROQ_PROVIDER_ID]: {
    id: GROQ_PROVIDER_ID,
    label: "Groq",
    shortLabel: "Groq",
    modelIds: [],
    modelAliases: {},
    supportsUsageSnapshot: false,
    authMode: "none",
    supportsNestedModelIds: true,
  },
};

export function listModelProviders() {
  return Object.values(PROVIDER_SPECS).map((entry) => ({
    ...entry,
    modelIds: [...entry.modelIds],
    modelAliases: { ...entry.modelAliases },
  }));
}

export function isSupportedProviderId(providerId) {
  return Boolean(PROVIDER_SPECS[trim(providerId)]);
}

export function resolveProviderId(providerId, fallback = CODEX_PROVIDER_ID) {
  const normalized = trim(providerId);
  if (PROVIDER_SPECS[normalized]) {
    return normalized;
  }
  return fallback;
}

export function resolveProviderSpec(providerId) {
  const resolvedId = resolveProviderId(providerId);
  return PROVIDER_SPECS[resolvedId];
}

export function resolveProviderLabel(providerId) {
  return resolveProviderSpec(providerId).label;
}

export function resolveProviderShortLabel(providerId) {
  return resolveProviderSpec(providerId).shortLabel;
}

export function resolveProviderModelIds(providerId) {
  return [...resolveProviderSpec(providerId).modelIds];
}

export function providerSupportsUsageSnapshot(providerId) {
  return Boolean(resolveProviderSpec(providerId).supportsUsageSnapshot);
}

export function providerRequiresOAuth(providerId) {
  return resolveProviderSpec(providerId).authMode !== "none";
}

export function normalizeProviderModelId(providerId, modelId) {
  const resolvedProviderId = resolveProviderId(providerId);
  const spec = resolveProviderSpec(resolvedProviderId);
  const raw = trim(modelId);
  if (!raw) {
    return "";
  }

  if (resolvedProviderId === OPENAI_API_PROVIDER_ID) {
    const withoutPrefix = raw.startsWith(`${OPENAI_API_PROVIDER_ID}/`)
      ? trim(raw.slice(OPENAI_API_PROVIDER_ID.length + 1))
      : raw;
    const aliases = spec.modelAliases;
    return aliases[withoutPrefix] ?? withoutPrefix;
  }

  let candidate = raw;
  const slash = candidate.indexOf("/");
  if (slash >= 0) {
    const maybeProvider = trim(candidate.slice(0, slash));
    const maybeModel = trim(candidate.slice(slash + 1));
    if (isSupportedProviderId(maybeProvider)) {
      if (maybeProvider !== resolvedProviderId) {
        return "";
      }
      candidate = maybeModel;
    } else if (!spec.supportsNestedModelIds) {
      candidate = trim(candidate.slice(candidate.lastIndexOf("/") + 1));
    }
  }

  const aliases = spec.modelAliases;
  return aliases[candidate] ?? candidate;
}

export function resolveModelRef(providerId, modelId) {
  const resolvedProviderId = resolveProviderId(providerId);
  const normalizedModelId = normalizeProviderModelId(resolvedProviderId, modelId);
  if (!normalizedModelId) {
    return "";
  }
  return `${resolvedProviderId}/${normalizedModelId}`;
}

function resolveProviderFromModelRef(rawRef) {
  const ref = trim(rawRef);
  if (!ref) {
    return "";
  }
  const slash = ref.indexOf("/");
  if (slash < 0) {
    return "";
  }
  const candidate = trim(ref.slice(0, slash));
  if (!isSupportedProviderId(candidate)) {
    return "";
  }
  return candidate;
}

export function resolveConfiguredProviderId(config) {
  const fromConfig = resolveProviderId(config?.codex?.provider, "");
  if (fromConfig) {
    return fromConfig;
  }
  const fromRef = resolveProviderFromModelRef(config?.codex?.model?.ref);
  if (fromRef) {
    return fromRef;
  }
  return CODEX_PROVIDER_ID;
}

export function resolveConfiguredModelSelection(config) {
  let providerId = resolveConfiguredProviderId(config);
  const fromRefProvider = resolveProviderFromModelRef(config?.codex?.model?.ref);
  if (fromRefProvider) {
    providerId = fromRefProvider;
  }

  let modelId = normalizeProviderModelId(providerId, config?.codex?.model?.id);
  if (!modelId) {
    const ref = trim(config?.codex?.model?.ref);
    if (ref) {
      modelId = normalizeProviderModelId(providerId, ref);
    }
  }

  return {
    providerId,
    modelId,
    ref: modelId ? resolveModelRef(providerId, modelId) : "",
  };
}

function cloneOauth(oauth) {
  if (!oauth || typeof oauth !== "object") {
    return null;
  }
  return { ...oauth };
}

function cloneConnection(connection) {
  if (!connection || typeof connection !== "object") {
    return null;
  }
  return { ...connection };
}

export function resolveProviderConnection(config, providerId) {
  const resolvedProviderId = resolveProviderId(providerId, "");
  if (!resolvedProviderId) {
    return null;
  }
  const providers = config?.codex?.providers;
  if (!providers || typeof providers !== "object") {
    return null;
  }
  return cloneConnection(providers[resolvedProviderId]);
}

export function assignProviderConnection(config, providerId, connection) {
  if (!config || typeof config !== "object") {
    return;
  }

  const resolvedProviderId = resolveProviderId(providerId);
  const nextConnection = cloneConnection(connection);
  const codex = config.codex && typeof config.codex === "object" ? { ...config.codex } : {};
  const providers =
    codex.providers && typeof codex.providers === "object" ? { ...codex.providers } : {};

  if (nextConnection && Object.keys(nextConnection).length > 0) {
    providers[resolvedProviderId] = nextConnection;
  } else {
    delete providers[resolvedProviderId];
  }

  if (Object.keys(providers).length > 0) {
    codex.providers = providers;
  } else {
    delete codex.providers;
  }

  config.codex = codex;
}

export function resolveProviderOAuth(config, providerId) {
  const resolvedProviderId = resolveProviderId(providerId, "");
  if (!resolvedProviderId) {
    return null;
  }

  const byProvider = config?.codex?.oauthByProvider;
  if (byProvider && typeof byProvider === "object") {
    const candidate = cloneOauth(byProvider[resolvedProviderId]);
    if (candidate && trim(candidate.access)) {
      return candidate;
    }
  }

  const legacy = cloneOauth(config?.codex?.oauth);
  if (legacy && trim(legacy.access)) {
    const activeProvider = resolveConfiguredProviderId(config);
    if (activeProvider === resolvedProviderId || resolvedProviderId === CODEX_PROVIDER_ID) {
      return legacy;
    }
  }

  return null;
}

export function assignProviderOAuth(config, providerId, oauth) {
  if (!config || typeof config !== "object") {
    return;
  }

  const resolvedProviderId = resolveProviderId(providerId);
  const nextOauth = cloneOauth(oauth);
  const codex = config.codex && typeof config.codex === "object" ? { ...config.codex } : {};
  const byProvider =
    codex.oauthByProvider && typeof codex.oauthByProvider === "object"
      ? { ...codex.oauthByProvider }
      : {};

  if (nextOauth) {
    byProvider[resolvedProviderId] = nextOauth;
  } else {
    delete byProvider[resolvedProviderId];
  }

  codex.provider = resolvedProviderId;
  if (nextOauth) {
    codex.oauth = nextOauth;
  } else {
    delete codex.oauth;
  }

  if (Object.keys(byProvider).length > 0) {
    codex.oauthByProvider = byProvider;
  } else {
    delete codex.oauthByProvider;
  }

  config.codex = codex;
}

export function assignModelSelection(config, providerId, modelId) {
  if (!config || typeof config !== "object") {
    return false;
  }

  const resolvedProviderId = resolveProviderId(providerId);
  const normalizedModelId = normalizeProviderModelId(resolvedProviderId, modelId);
  if (!normalizedModelId) {
    return false;
  }

  const codex = config.codex && typeof config.codex === "object" ? { ...config.codex } : {};
  codex.provider = resolvedProviderId;
  codex.model = {
    id: normalizedModelId,
    ref: resolveModelRef(resolvedProviderId, normalizedModelId),
  };
  config.codex = codex;
  return true;
}

export function ensureProviderState(config) {
  if (!config || typeof config !== "object") {
    return {
      changed: false,
      providerId: CODEX_PROVIDER_ID,
      modelId: "",
    };
  }

  const original = JSON.stringify(config.codex ?? {});
  const selection = resolveConfiguredModelSelection(config);
  const codex = config.codex && typeof config.codex === "object" ? { ...config.codex } : {};
  codex.provider = selection.providerId;
  if (selection.modelId) {
    codex.model = {
      id: selection.modelId,
      ref: resolveModelRef(selection.providerId, selection.modelId),
    };
  }
  config.codex = codex;

  const oauth = resolveProviderOAuth(config, selection.providerId);
  if (oauth) {
    assignProviderOAuth(config, selection.providerId, oauth);
  }

  return {
    changed: original !== JSON.stringify(config.codex ?? {}),
    providerId: selection.providerId,
    modelId: selection.modelId,
  };
}
