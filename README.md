# codexclaw

Minimal onboarding + runtime for:

1. OpenAI Codex OAuth
2. Codex model selection (7 models)
3. Telegram bot bridge
4. Optional Notion skill API key setup

## Install

```bash
cd codexclaw
npm install
```

## Onboard

```bash
npm run onboard
```

OAuth is always manual:
- CLI prints a login URL
- You log in from any browser
- Paste the callback URL back into CLI

This stores config in `~/.codexclaw/config.json` by default.
Telegram access follows openclaw-style pairing by default (`dmPolicy: "pairing"`):
- DM the bot in Telegram
- bot replies with a pairing code
- enter that code in the running `npm run telegram` terminal and press Enter
- empty line means "no code" (ignored)

Notion (optional):
- During onboarding, you can enable the `notion` skill and save a Notion integration token.
- Token is stored at `skills.entries.notion.apiKey`.
- When configured, Codex can use the built-in `notion_api_request` tool for Notion REST calls.

## Run Telegram bot

```bash
npm run telegram
```

## Show config (redacted)

```bash
npm run config
```

## Optional custom config path

```bash
node ./bin/codexclaw.mjs onboard --config /tmp/codexclaw.json
node ./bin/codexclaw.mjs telegram run --config /tmp/codexclaw.json
```
