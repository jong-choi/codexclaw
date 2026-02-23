---
name: web_fetch
description: Fetch a URL and extract readable page content.
homepage: https://docs.openclaw.ai/tools/web
metadata:
  { "openclaw": { "emoji": "📄" } }
---

# web_fetch

Use `web_fetch` to retrieve page content directly from a URL.

## When to use

- Read article/docs text from a known URL
- Pull details from search results before summarizing
- Verify source content before citing

## Tool

`web_fetch`

Parameters:
- `url` (required): `http://` or `https://` URL
- `extractMode` (optional): `markdown` or `text` (default `markdown`)
- `maxChars` (optional): truncate limit (minimum `100`, default `50000`)

## Behavior

- Performs HTTP fetch (no browser automation)
- Extracts readable text for HTML pages
- Returns metadata (`status`, `contentType`, `finalUrl`) and extracted `text`

## Output shape

The tool returns JSON with fields like:
- `ok`, `url`, `finalUrl`, `status`, `contentType`
- `extractMode`, `extractor`, `truncated`, `length`, `fetchedAt`, `tookMs`
- `title` (when available), `text`
