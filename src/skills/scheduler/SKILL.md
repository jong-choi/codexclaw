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

`schedule_recurring_create`
- `prompt` (required): future instruction to run when each recurring trigger fires
- `frequency` (required): `daily` or `weekly`
- `hour` (required): local hour (`0-23`)
- `minute` (optional): local minute (`0-59`, default `0`)
- `weekdays` (required for `weekly`): array of `MO`,`TU`,`WE`,`TH`,`FR`,`SA`,`SU`
- `timezone` (optional): IANA timezone override (uses chat timezone by default)

Recurring rules:
- `schedule_recurring_create.prompt` follows the same prompt rule as one-time schedules.
- For recurring reminders, do not reuse the user's scheduling sentence as prompt.
- If chat timezone is not configured, ask user and set it with `timezone_set` before creating recurring schedules.
- Weekly requests must map weekday names to weekday tokens (`Monday` -> `MO`).

Recurring few-shot:
- User: `Every Monday at 8 PM remind me to send a weekly report`
- Create with: `prompt="Tell the user to send their weekly report now."`, `frequency="weekly"`, `weekdays=["MO"]`, `hour=20`

`schedule_recurring_list`
- `state` (optional): `active`, `paused`, `running`, `canceled`, `all`
- `limit` (optional): max items
- `timezone` (optional): timezone for displayed local times

`schedule_recurring_delete`
- `recurringId` (required): cancel one recurring schedule

`schedule_recurring_pause`
- `recurringId` (required): pause one recurring schedule

`schedule_recurring_resume`
- `recurringId` (required): resume one paused recurring schedule

## Behavior

- Scheduled tasks are scoped to the current Telegram chat.
- At run time, Codex receives the stored prompt again and sends a new reply to that chat.
- Use `schedule_list` / `schedule_recurring_list` after creating tasks when the user asks for confirmation details.
