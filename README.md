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

Conversation history is stored in `~/.codexclaw/telegram-conversations.json`.

Notion (optional):
- During onboarding, you can enable the `notion` skill and save a Notion integration token.
- Token is stored at `skills.entries.notion.apiKey`.
- When configured, Codex can use the built-in `notion_api_request` tool for Notion REST calls.

## Run Telegram bot

```bash
npm run telegram
```

Runtime behavior:
- Multi-turn context is preserved per Telegram chat/session.
- `/new`, `/clear`, `/reset`: clear saved context for the current chat.
- `/context`: show the number of stored context messages.
- During skill/tool execution, the bot posts live status updates and a final execution log.

## Show config (redacted)

```bash
npm run config
```

## Optional custom config path

```bash
node ./bin/codexclaw.mjs onboard --config /tmp/codexclaw.json
node ./bin/codexclaw.mjs telegram run --config /tmp/codexclaw.json
```
