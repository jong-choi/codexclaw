import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getOAuthApiKey,
  getOAuthProviders,
  loginOpenAICodex,
} from "@mariozechner/pi-ai";
import { CODEX_PROVIDER_ID, QWEN_PROVIDER_ID } from "./constants.mjs";

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function trim(value) {
  return String(value ?? "").trim();
}

function validateRequiredInput(value) {
  return trim(value) ? undefined : "Required";
}

function createOAuthHandlers(params) {
  return {
    async onAuth(event) {
      const url = trim(event?.url);
      if (!url) {
        return;
      }

      params.spin.stop("OAuth URL ready");
      params.log(`\nOpen this URL in your browser and sign in:\n\n${url}\n`);
    },

    async onPrompt(prompt) {
      const code = await params.prompter.text({
        message: "Paste the redirect URL",
        placeholder: trim(prompt?.placeholder) || "http://127.0.0.1:1455/auth/callback?code=...",
        validate: validateRequiredInput,
      });
      return String(code);
    },
  };
}

function toFormUrlEncoded(data) {
  return Object.entries(data)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function isValidExpiry(expires) {
  const asNumber = Number(expires ?? 0);
  return Number.isFinite(asNumber) && asNumber > Date.now() + 30_000;
}

async function requestQwenDeviceCode(challenge) {
  const response = await fetch(QWEN_OAUTH_DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "x-request-id": randomUUID(),
    },
    body: toFormUrlEncoded({
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: QWEN_OAUTH_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Qwen device authorization failed: ${text || response.statusText}`);
  }

  const payload = await response.json();
  const deviceCode = trim(payload?.device_code);
  const userCode = trim(payload?.user_code);
  const verificationUri = trim(payload?.verification_uri);
  const verificationUriComplete = trim(payload?.verification_uri_complete);
  const expiresIn = Number(payload?.expires_in);
  const interval = Number(payload?.interval);

  if (!deviceCode || !userCode || !verificationUri || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Qwen device authorization returned an incomplete payload.");
  }

  return {
    deviceCode,
    userCode,
    verificationUrl: verificationUriComplete || verificationUri,
    expiresIn,
    interval: Number.isFinite(interval) && interval > 0 ? interval : undefined,
  };
}

async function pollQwenDeviceToken(params) {
  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: QWEN_OAUTH_DEVICE_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: params.deviceCode,
      code_verifier: params.verifier,
    }),
  });

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      const text = await response.text();
      return {
        status: "error",
        message: text || response.statusText,
      };
    }

    const errorCode = trim(payload?.error);
    if (errorCode === "authorization_pending") {
      return { status: "pending", slowDown: false };
    }
    if (errorCode === "slow_down") {
      return { status: "pending", slowDown: true };
    }
    return {
      status: "error",
      message: trim(payload?.error_description) || errorCode || response.statusText,
    };
  }

  const payload = await response.json();
  const accessToken = trim(payload?.access_token);
  const refreshToken = trim(payload?.refresh_token);
  const expiresIn = Number(payload?.expires_in);

  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return {
      status: "error",
      message: "Qwen OAuth returned incomplete token payload.",
    };
  }

  return {
    status: "success",
    token: {
      access: accessToken,
      refresh: refreshToken,
      expires: Date.now() + expiresIn * 1000,
    },
  };
}

function resolveCodexOAuthProvider() {
  const providers = getOAuthProviders();
  return providers.find((provider) => provider.id === CODEX_PROVIDER_ID) ?? null;
}

async function refreshQwenOAuthCredentials(oauthCredentials) {
  const oauth = oauthCredentials && typeof oauthCredentials === "object" ? oauthCredentials : null;
  if (!oauth || !trim(oauth.refresh)) {
    throw new Error("Qwen OAuth refresh token missing; re-authenticate.");
  }

  const response = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: toFormUrlEncoded({
      grant_type: "refresh_token",
      refresh_token: trim(oauth.refresh),
      client_id: QWEN_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400) {
      throw new Error("Qwen OAuth refresh token expired or invalid. Run `codexclaw onboard` again.");
    }
    throw new Error(`Qwen OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = await response.json();
  const accessToken = trim(payload?.access_token);
  const refreshToken = trim(payload?.refresh_token) || trim(oauth.refresh);
  const expiresIn = Number(payload?.expires_in);

  if (!accessToken) {
    throw new Error("Qwen OAuth refresh response missing access token.");
  }
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Qwen OAuth refresh response missing or invalid expires_in.");
  }

  return {
    ...oauth,
    access: accessToken,
    refresh: refreshToken,
    expires: Date.now() + expiresIn * 1000,
  };
}

export async function loginCodexOAuth(params) {
  const spin = params.prompter.progress("Starting OAuth flow...");

  params.prompter.note(
    [
      "A login URL will be shown.",
      "Open it in any browser, complete sign-in, then paste the callback URL.",
      "OpenAI callback format: http://127.0.0.1:1455/auth/callback?code=...",
    ].join("\n"),
    "OpenAI Codex OAuth",
  );

  try {
    const { onAuth, onPrompt } = createOAuthHandlers({
      prompter: params.prompter,
      spin,
      log: params.log,
    });

    const creds = await loginOpenAICodex({
      onAuth,
      onPrompt,
      onProgress: (message) => {
        spin.update(trim(message));
      },
      // Force manual redirect-url input flow by cancelling local callback auto-complete path.
      onManualCodeInput: async () => "",
    });

    spin.stop("OpenAI OAuth complete");
    return creds ?? null;
  } catch (error) {
    spin.stop("OpenAI OAuth failed");
    params.error(String(error));
    params.prompter.note(
      "Trouble with OAuth? Verify browser login and retry onboarding.",
      "OAuth help",
    );
    throw error;
  }
}

export async function loginQwenOAuth(params) {
  const spin = params.prompter.progress("Starting Qwen OAuth flow...");

  try {
    const { verifier, challenge } = generatePkce();
    const device = await requestQwenDeviceCode(challenge);

    params.prompter.note(
      [
        "Open the URL below in any browser and approve access.",
        `Verification URL: ${device.verificationUrl}`,
        `User code: ${device.userCode}`,
      ].join("\n"),
      "Qwen OAuth",
    );
    params.log(`\nOpen this URL in your browser:\n\n${device.verificationUrl}\n`);
    params.log(`If prompted, enter code: ${device.userCode}\n`);

    const timeoutAt = Date.now() + device.expiresIn * 1000;
    let pollIntervalMs = (device.interval ?? 2) * 1000;

    while (Date.now() < timeoutAt) {
      spin.update("Waiting for Qwen OAuth approval...");
      const polled = await pollQwenDeviceToken({
        deviceCode: device.deviceCode,
        verifier,
      });

      if (polled.status === "success") {
        spin.stop("Qwen OAuth complete");
        return polled.token;
      }

      if (polled.status === "error") {
        throw new Error(polled.message || "Qwen OAuth failed.");
      }

      if (polled.slowDown) {
        pollIntervalMs = Math.min(Math.round(pollIntervalMs * 1.5), 10_000);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error("Qwen OAuth timed out waiting for authorization.");
  } catch (error) {
    spin.stop("Qwen OAuth failed");
    params.error(String(error));
    params.prompter.note(
      "Trouble with Qwen OAuth? Verify your Qwen account can access portal.qwen.ai and retry onboarding.",
      "OAuth help",
    );
    throw error;
  }
}

export async function loginProviderOAuth(params) {
  const providerId = trim(params?.providerId) || CODEX_PROVIDER_ID;
  if (providerId === QWEN_PROVIDER_ID) {
    return await loginQwenOAuth(params);
  }
  if (providerId === CODEX_PROVIDER_ID) {
    return await loginCodexOAuth(params);
  }
  throw new Error(`Unsupported auth provider: ${providerId}`);
}

export async function resolveFreshCodexAccessToken(oauthCredentials) {
  const oauth = oauthCredentials && typeof oauthCredentials === "object" ? oauthCredentials : null;
  if (!oauth || !trim(oauth.access)) {
    throw new Error("Missing Codex OAuth credentials. Run `codexclaw onboard` first.");
  }

  if (isValidExpiry(oauth.expires)) {
    return {
      accessToken: trim(oauth.access),
      credentials: oauth,
      changed: false,
    };
  }

  const provider = resolveCodexOAuthProvider();
  if (!provider) {
    return {
      accessToken: trim(oauth.access),
      credentials: oauth,
      changed: false,
    };
  }

  try {
    const refreshed = await getOAuthApiKey(provider, {
      [CODEX_PROVIDER_ID]: oauth,
    });
    if (!refreshed || !trim(refreshed.apiKey)) {
      return {
        accessToken: trim(oauth.access),
        credentials: oauth,
        changed: false,
      };
    }
    const nextCredentials = refreshed.newCredentials
      ? {
          ...oauth,
          ...refreshed.newCredentials,
        }
      : oauth;
    return {
      accessToken: trim(refreshed.apiKey),
      credentials: nextCredentials,
      changed: Boolean(refreshed.newCredentials),
    };
  } catch {
    return {
      accessToken: trim(oauth.access),
      credentials: oauth,
      changed: false,
    };
  }
}

export async function resolveFreshQwenAccessToken(oauthCredentials) {
  const oauth = oauthCredentials && typeof oauthCredentials === "object" ? oauthCredentials : null;
  if (!oauth || !trim(oauth.access)) {
    throw new Error("Missing Qwen OAuth credentials. Run `codexclaw onboard` first.");
  }

  if (isValidExpiry(oauth.expires)) {
    return {
      accessToken: trim(oauth.access),
      credentials: oauth,
      changed: false,
    };
  }

  try {
    const refreshed = await refreshQwenOAuthCredentials(oauth);
    return {
      accessToken: trim(refreshed.access),
      credentials: refreshed,
      changed: true,
    };
  } catch {
    return {
      accessToken: trim(oauth.access),
      credentials: oauth,
      changed: false,
    };
  }
}

export async function resolveFreshProviderAccessToken(providerId, oauthCredentials) {
  const resolvedProviderId = trim(providerId) || CODEX_PROVIDER_ID;
  if (resolvedProviderId === QWEN_PROVIDER_ID) {
    return await resolveFreshQwenAccessToken(oauthCredentials);
  }
  if (resolvedProviderId === CODEX_PROVIDER_ID) {
    return await resolveFreshCodexAccessToken(oauthCredentials);
  }
  throw new Error(`Unsupported auth provider: ${resolvedProviderId}`);
}
