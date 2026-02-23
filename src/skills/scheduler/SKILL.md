---
name: scheduler
description: Schedule delayed or time-based follow-up tasks in Telegram chats.
metadata:
  { "openclaw": { "emoji": "⏰" } }
---

# scheduler

Use scheduling tools when the user asks for reminders, delayed follow-up messages, or time-based execution.

## Tools

`schedule_create`
- `prompt` (required): future instruction to run when the schedule fires
- `delaySeconds` (optional): relative delay in seconds
- `runAt` (optional): absolute schedule time
- `timezone` (optional): IANA timezone (`Asia/Seoul`, `Europe/London`, `America/New_York`)

Rules:
- Use either `delaySeconds` or `runAt`, not both.
- `prompt` must be what future Codex should do, not the user's original scheduling sentence.
- For "in N minutes/hours" requests, prefer `delaySeconds`.
- For local absolute time, pass `runAt` + `timezone`.
- If `runAt` already includes offset (`Z`, `+09:00`), timezone is optional.
- If chat timezone is not configured, ask user and set it with `timezone_set`.

Prompt few-shot:
- User: `Schedule a reminder for 8 AM tomorrow to call my mom`
- Create with: `prompt="Tell the user to call their mom now."`
- User: `Remind me in 10 minutes to drink water`
- Create with: `prompt="Tell the user to drink water now."`

`schedule_list`
- `status` (optional): `pending`, `running`, `completed`, `failed`, `canceled`, `all`
- `limit` (optional): max items
- `timezone` (optional): timezone for displayed local times

`schedule_delete`
- `jobId` (required): cancel one scheduled task

## Behavior

- Scheduled tasks are scoped to the current Telegram chat.
- At run time, Codex receives the stored prompt again and sends a new reply to that chat.
- Use `schedule_list` after creating a task when the user asks for confirmation details.
