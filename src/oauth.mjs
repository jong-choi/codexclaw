import {
  getOAuthApiKey,
  getOAuthProviders,
  loginOpenAICodex,
} from "@mariozechner/pi-ai";
import { CODEX_PROVIDER_ID } from "./constants.mjs";

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

function resolveCodexOAuthProvider() {
  const providers = getOAuthProviders();
  return providers.find((provider) => provider.id === CODEX_PROVIDER_ID) ?? null;
}

export async function resolveFreshCodexAccessToken(oauthCredentials) {
  const oauth = oauthCredentials && typeof oauthCredentials === "object" ? oauthCredentials : null;
  if (!oauth || !trim(oauth.access)) {
    throw new Error("Missing Codex OAuth credentials. Run `codexclaw onboard` first.");
  }

  const expires = Number(oauth.expires ?? 0);
  const hasValidExpiry = Number.isFinite(expires) && expires > Date.now() + 30_000;
  if (hasValidExpiry) {
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
