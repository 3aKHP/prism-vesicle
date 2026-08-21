<!-- Generated from docs/user/en/tutorials/web-search-and-images.md — do not edit. -->

# Let the model search the web and inspect images

English | [简体中文](../../zh-CN/tutorials/web-search-and-images.md)

Vesicle has two different web-research paths and can send a clipboard image as part of a message to a vision model. This page explains how to start, how to tell that the capability really ran, and what to do when it is unavailable.

## First distinguish the two search paths

| Path | Who performs the search | How to enable it | Per-call approval? |
|---|---|---|---|
| **Provider-native search** | The selected model provider | Run `/websearch on` in an active session | No; queries leave with the model request |
| **Tavily tools** | Vesicle's `web_search` / `web_fetch` / `web_map` / `web_crawl` / `web_research` tools | Configure Tavily in Setup, or add `TAVILY_API_KEY` to the user `.env` and restart | Governed by the current permission mode |

The two paths do not expose competing `web_search` tools. While provider-native search is on, host-side Tavily `web_search` is removed from the current tool surface. The other Tavily research tools remain subject to the Engine tool surface and permissions.

## Use provider-native search

The active protocol/profile, a model entry with `capabilities.builtinWebSearch: true`, and the current Engine must all admit search. The bundled ETL and Evaluate Engines admit it; Stage and the `/btw` side channel do not. An active session must also exist, so send one message or resume a session first.

1. Run `/websearch` to inspect the current state and model default.
2. Run `/websearch on`. Success shows `Built-in web search is ON for this session.` plus disclosure about query transfer, billing, and how to turn it off.
3. Ask a question that genuinely needs current material, for example:

   > Search for and verify public setting updates relevant to this character material. List the queries you actually used and do not fill gaps with guesses.

4. After a search actually runs, the transcript shows `Built-in web search (<provider>): "<query>"`. It also shows a citation count when the provider returns citations. **No citation does not mean no search**: some providers inject results server-side without returning sources to the client.
5. Run `/websearch off` to turn it off for this session.

The override is session-scoped. `/new` or resuming another session restores the selected model entry's `webSearchDefault`. Permission modes do not govern this provider capability, so understand that queries and relevant conversation content leave for the provider and may incur additional charges.

### If it cannot be enabled

- `no active session yet`: send a normal message or `/resume` a session first.
- `selected model does not declare...`: switch to a model that declares the capability, or inspect its `providers.yaml` entry.
- `protocol/profile and model do not admit...`: capability metadata alone is insufficient; the protocol profile must support search too. Do not invent fields to force it through.
- `unavailable in the ... Engine`: switch to an Engine that admits search; Stage and `/btw` are intentionally search-free.

## Use Tavily research tools

Setup's **Tavily (optional)** step can save the key. Alternatively add `TAVILY_API_KEY=...` to the user-level `.env` and restart. Run `vesicle doctor`; success looks like:

```text
Tavily web tools: available (.../.env)
```

Then describe the task in an ETL or Evaluate conversation; you do not need to name a tool:

> Use web tools to find public sources for this setting, read the most relevant pages, and separate sourced facts from unresolved conflicts.

The model chooses search, fetch, map, crawl, or research as needed. Approval behavior follows the current [permission mode](./permissions-and-shell.md). If Doctor reports unavailable, confirm the key is in the correct user `.env`, then fully restart Vesicle.

## Give a clipboard image to the model

The selected model must declare `capabilities.vision: true` in `providers.yaml`. Copy a PNG/JPEG/GIF/WebP image to the system clipboard first:

1. Press `Ctrl+V` in the composer; use `Option+V` if a macOS terminal conflicts.
2. The status first says `reading clipboard image`; success then says `attached Image #1`, and `[Image #1]` appears in the composer.
3. Add a concrete task in the same message, such as “read the relationships in this image; transcribe only text you can see clearly,” then press Enter.

The image is stored as a content-addressed project session attachment. Session JSONL stores a reference rather than embedded base64. Double Esc with an attachment in the composer moves the whole draft, including attachments, into prompt history and clears it. Busy-mode Esc interruption preserves the current draft and attachments.

### If the image is not sent

- `current model does not declare vision support`: the image may be attached, but submission is refused and the draft is preserved. Use `/model` to choose a model that explicitly declares vision, then retry.
- `No supported image was found in the clipboard`: copy the **image itself** from an image viewer or browser, not only its file path. Linux/WSL also needs a working system clipboard bridge.
- `image paste failed`: retain the complete status error and collect environment evidence through [Troubleshooting](../reference/troubleshooting.md).

## Checklist

- [ ] You can explain the difference between provider-native search and Tavily.
- [ ] You inspected the real `/websearch` state and know which system record proves that a search happened.
- [ ] You know citations are optional feedback, not the only success criterion.
- [ ] You sent a message containing `[Image #1]` to a vision model, or received a clear capability refusal with the draft preserved.

See [Configuration files](../reference/configuration.md) for exact fields and the root [`PRIVACY.md`](../../../../PRIVACY.md) for data-transfer boundaries.
