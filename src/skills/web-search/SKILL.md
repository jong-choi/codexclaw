---
name: web_search
description: Web search via Brave Search API.
homepage: https://brave.com/search/api/
metadata:
  {
    "openclaw":
      { "emoji": "🌐", "requires": { "env": ["BRAVE_API_KEY"] }, "primaryEnv": "BRAVE_API_KEY" },
  }
---

# web_search

Use `web_search` when you need up-to-date web results.

## When to use

- Current events, release notes, prices, schedules, policy updates
- Questions where static memory may be stale
- Requests asking for sources or links

## Tool

`web_search`

Parameters:
- `query` (required): search query
- `count` (optional): result count (`1-10`, default `5`)
- `country` (optional): region code like `US`, `DE`, `ALL`
- `search_lang` (optional): language code like `en`, `ko`
- `ui_lang` (optional): UI language code
- `freshness` (optional): `pd`, `pw`, `pm`, `py`, or `YYYY-MM-DDtoYYYY-MM-DD`

## Auth

- Primary: `skills.entries.web_search.apiKey`
- Fallback: `BRAVE_API_KEY`

If the key is missing, the tool returns `missing_brave_api_key`.

## Output shape

The tool returns JSON with fields like:
- `ok`, `status`, `provider`, `query`, `count`, `tookMs`
- `results`: array of `{ title, url, description, age }`

Use returned URLs for citation and follow-up fetch.
