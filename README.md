# codexclaw

[English](README.md) | [한국어](docs/README.ko.md) | [日本語](docs/README.ja.md)



Most of this code was written with GPT-5.3-Codex-xhigh, so you can keep editing and iterating with Codex too. 
This project is focused on Codex/Qwen/Ollama/OpenRouter/Groq + Telegram integration. 
This project was created by extracting only the parts I needed from the much larger OpenClaw project. 
OpenClaw is released under the MIT License ([openclaw/openclaw](https://github.com/openclaw/openclaw)) and yes, this project is too. 

Minimal onboarding + runtime for:

1. Provider selection (OpenAI Codex, OpenAI API (compatible), Qwen, Ollama, OpenRouter, or Groq)
2. Provider model selection
3. Telegram bot bridge
4. Optional Notion skill API key setup
5. Optional web tools (`web_search`, `web_fetch`) setup
6. Optional scheduler tools (`schedule_create`, `schedule_list`, `schedule_delete`) setup
7. Workspace file skill (`workspace_files`) for memory/instruction file management

<table>
  <tr>
    <td align="center" width="50%">
      <a href="docs/images/telegram-chat-01.jpg">
        <img src="docs/images/telegram-chat-01.jpg" width="260" alt="Telegram chat 01" />
      </a>
    </td>
    <td align="center" width="50%">
      <a href="docs/images/telegram-chat-02.jpg">
        <img src="docs/images/telegram-chat-02.jpg" width="260" alt="Telegram chat 02" />
      </a>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/images/telegram-chat-03.jpg">
        <img src="docs/images/telegram-chat-03.jpg" width="260" alt="Telegram chat 03" />
      </a>
    </td>
    <td align="center" width="50%">
      <a href="docs/images/telegram-chat-04.jpg">
        <img src="docs/images/telegram-chat-04.jpg" width="260" alt="Telegram chat 04" />
      </a>
    </td>
  </tr>
</table>

## Install

```bash
git clone https://github.com/jong-choi/codexclaw.git
cd codexclaw
npm install
```

## Docker

Run CodexClaw stack from project root (this creates the `codexclaw_shared` network):

```bash
docker compose up --build -d
```

Run Ollama stack from separate folder:

```bash
cd deploy/ollama
docker compose up -d
```

Then use this endpoint in onboarding or `/provider ollama` setup:

- Same Docker network (`codexclaw_shared`): `http://ollama:11434`
- Ollama on host machine: `http://127.0.0.1:11434` (or `http://host.docker.internal:11434` from container)
- Ollama on another server: reachable `http(s)://<host>:<port>`

Pull/list models inside the Ollama container:

```bash
cd deploy/ollama
docker compose exec ollama ollama pull gpt-oss:20b
docker compose exec ollama ollama list
```

Stop stacks:

```bash
# Mode A (run from repo root)
docker compose down

# Ollama stack (run from deploy/ollama)
cd deploy/ollama
docker compose down
```

Run onboarding (interactive provider setup: OAuth for Codex/Qwen, endpoint input for Ollama, base URL + API key + model scan for OpenAI API, API key + free-model scan for OpenRouter, API key + model scan for Groq):

```bash
# run from repo root
docker compose run --rm codexclaw onboard
```

Run Telegram bot with Docker (interactive, recommended for pairing code input):

```bash
# run from repo root
docker compose run --rm codexclaw telegram run
```

In this interactive terminal, type `bye` or `exit` to stop the bot process and return to shell (`/bye`, `/exit` also work).

Recommended flow:
- First run: use `--rm` interactive mode to approve pairing code in terminal.
- After pairing is complete: run detached mode (`-d`) so the bot keeps running on server.

Run Telegram bot in detached mode:

```bash
docker compose run -d --name codexclaw-telegram codexclaw telegram run
docker logs -f codexclaw-telegram
```

Stop detached bot:

```bash
docker stop codexclaw-telegram
docker rm codexclaw-telegram
```

Important:
- Start only one Telegram polling instance for a token.
- Do not run `docker compose run --rm codexclaw telegram run` while another bot instance is already running.

Show redacted config:

```bash
docker compose run --rm codexclaw config show
```

Cleanup helper (interactive):

```bash
./scripts/uninstall.sh
```

Workspace reset helper:

```bash
./scripts/reset-workspace.sh
```

This resets only the workspace directory and recreates `MEMORY.md` / `INSTRUCTIONS.md`.
It removes the current workspace and copies from `.codexclaw/initial-workspace`, then ensures `MEMORY.md` and `INSTRUCTIONS.md`.

The script checks existing resources first, then asks per item:
- Running project containers → ask to run `docker compose down`
- Project images → ask to delete images
- Project volumes → ask to delete volumes
- Workspace files (`.codexclaw/workspace`) → ask to initialize workspace files
- Global config (`~/.codexclaw`) → ask to delete global config

Notes:
- If nothing exists in a category, that question is skipped.
- Project source files are never deleted.

## Onboard

```bash
npm run onboard
```

Provider setup depends on provider:
- OpenAI Codex: manual callback URL paste
- OpenAI API (compatible): enter base URL (default `https://api.openai.com/v1`) + API key, then scan/select models dynamically from `/models`
- Qwen: device-code login (open URL + approve + polling)
- Ollama: enter base URL and select discovered model list (`http://ollama:11434` on same Docker network)
  - If no models are pulled yet, onboarding can continue without model selection.
  - Later in Telegram: `/ollama pull gpt-oss:20b` -> `/models` -> `/model <id|number>`
- OpenRouter: enter API key + base URL (default `https://openrouter.ai/api/v1`), then scan/select free models dynamically
  - Free model rule follows OpenClaw: model id ending with `:free` or zero prompt/completion pricing.
- Groq: enter API key + base URL (default `https://api.groq.com/openai/v1`), then scan/select models dynamically.

This stores config in `~/.codexclaw/config.json` by default.
Telegram access follows openclaw-style pairing by default (`dmPolicy: "pairing"`):
- DM the bot in Telegram
- bot replies with a pairing code
- enter that code in the running `npm run telegram` terminal and press Enter
- empty line means "no code" (ignored)
- type `bye` or `exit` in the running bot terminal to stop the process (`/bye`, `/exit` also work)

Conversation history is stored in `~/.codexclaw/telegram-conversations.json`.

Notion (optional):
- During onboarding, you can enable the `notion` skill and save a Notion integration token.
- Token is stored at `skills.entries.notion.apiKey`.
- When configured, the assistant can use the built-in `notion_api_request` tool for Notion REST calls.

Web tools (optional):
- During onboarding, you can enable `web_search` and `web_fetch` skills.
- `web_search` uses Brave Search API (`skills.entries.web_search.apiKey` or `BRAVE_API_KEY`).
- `web_fetch` fetches and extracts readable page content (no API key required).

Scheduler (optional):
- During onboarding, you can enable `scheduler` skill.
- `schedule_create`: delay-based or absolute time scheduling
- `schedule_list`: inspect current registered jobs
- `schedule_delete`: cancel one job
- `schedule_recurring_create`: recurring reminder registration (`daily`/`weekly`)
- `schedule_recurring_list`: inspect registered recurring reminders
- `schedule_recurring_delete`: cancel one recurring reminder
- `schedule_recurring_pause`: pause one recurring reminder
- `schedule_recurring_resume`: resume one paused recurring reminder
- Chat timezone tools: `timezone_get`, `timezone_set`, `current_time_get`
- Timezone is configured during Telegram chat (`timezone_set`), not during onboarding.
- `schedule_create.prompt` and `schedule_recurring_create.prompt` should be future instructions, not original scheduling sentences.
  Example: `Schedule a reminder for 8 AM tomorrow to call my mom` -> `Tell the user to call their mom now.`
- Scheduled tasks are chat-scoped and trigger a new Codex run when due.

Workspace files (always available):
- CodexClaw exposes workspace tools: `workspace_read_file`, `workspace_write_file`, `workspace_delete_path`.
- Default workspace root: `./.codexclaw/workspace` (relative to the runtime working directory).
- Default workspace template: `./.codexclaw/initial-workspace`.
- `.codexclaw/workspace` is gitignored by default.
- Optional override: set `workspace.root` in config.
- During onboarding, if workspace is empty, template files are copied into workspace.
- During onboarding, if workspace already exists and is not empty, it asks whether to reset from template.
- On each session's first turn, system prompt instructs Codex to check `MEMORY.md` and `INSTRUCTIONS.md`.
- Missing files are auto-created during runtime initialization.

## Run Telegram bot

```bash
npm run telegram
```

Runtime behavior:
- Multi-turn context is preserved per Telegram chat/session.
- `/help` (or `/commands`): show command list and usage examples.
- `/new`, `/clear`, `/reset`: clear saved context for the current chat.
- `/context`: show the number of stored context messages.
- `/usage`: show live usage limit windows (Codex provider only).
- `/think`, `/thinking`, `/reasoning`: show or set reasoning effort (`none|minimal|low|medium|high|xhigh`).
- `/provider`: show current provider/model and pending setup state.
- `/provider <id|alias|number>`: switch provider; starts OAuth flow (Codex/Qwen), endpoint setup prompt (Ollama), API-key setup + free-model scan (OpenRouter), or API-key setup + model scan (Groq).
- `/provider cancel`: cancel pending provider setup.
- `/models`: list available models for the current provider.
- `/model`: show current provider/model + current reasoning effort + usage summary. `/model <id|number>` switches model immediately.
- `/ollama list|pull|rm`: list/pull/delete Ollama models in chat.
- While Codex OAuth is pending, the next non-command message is treated as callback URL input.
- While Ollama setup is pending, the next non-command message is treated as Ollama base URL input.
- While OpenRouter setup is pending, the next non-command message is treated as OpenRouter API key input.
- While Groq setup is pending, the next non-command message is treated as Groq API key input.
- Invalid command or wrong arguments: bot replies with the correct usage and points to `/help`.
- Terminal input `bye` or `exit`: stop `telegram run` immediately (`/bye`, `/exit` also work).
- Telegram command menu (`/`) is synced automatically on startup.
- Current UTC/local time context is injected into each model request.
- Due scheduled jobs are executed in the same bot process without new incoming messages.
- The bot proactively posts a status message immediately after receiving a request.
- While processing, it updates status periodically and during skill/tool calls.
- It posts final completion/failure status, plus a skill execution log when tools were used.

### Telegram Status Updates (feature)

CodexClaw treats status delivery as a runtime feature (not prompt wording):
- Creates a status message as soon as a user request is received.
- Edits the same message in place while processing (`status: processing (Xs)`).
- Reflects tool lifecycle events (start/result, method/path, success/failure).
- Finalizes with `status: completed` or `status: failed`.
- Appends a compact `Skill execution log` when tools are used.

Timing behavior:
- Periodic working update interval: `10s`
- Quiet window after tool events: `8s`

Language behavior:
- Korean status text for Korean user input.
- English status text otherwise.

Optional config:
- Set `telegram.proactiveStatus` to `false` to disable proactive status messages.

## Show config (redacted)

```bash
npm run config
```

## Optional custom config path

```bash
node ./bin/codexclaw.mjs onboard --config /tmp/codexclaw.json
node ./bin/codexclaw.mjs telegram run --config /tmp/codexclaw.json
```
