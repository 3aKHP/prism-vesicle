# Command cheatsheet

English | [简体中文](../../zh-CN/reference/commands.md)

Type a command starting with `/` in the input box; typing `/` opens a candidate menu (↑↓ to choose, Tab/Enter to complete, Esc to cancel). Each command owns its argument grammar.

## Session and context

| Command | Purpose |
|---|---|
| `/help` | List all commands |
| `/new` | Start a fresh session |
| `/resume` | List this project's sessions to resume; `/resume <n\|id>` resumes directly |
| `/rewind` (alias `/checkpoint`) | Rewind to a step in this session, optionally restoring files |
| `/compact [instructions]` | Compact the current session into a summary and continue, saving context |
| `/context` | Show current context usage and window occupancy |

## Model and engine

| Command | Purpose |
|---|---|
| `/model [provider] [model]` | Switch provider/model; no args opens a picker |
| `/engine [id] [--summary [instructions]]` | Show or switch the Prism engine; `--summary` compacts before switching |
| `/stage <character-card-path> <scenario-card-path>` | Start a Stage narrative session from two cards |
| `/effort off\|low\|medium\|high\|xhigh\|max\|auto` | Control the model's thinking effort; `auto` restores the provider default |
| `/reasoning hidden\|collapsed\|expanded` | Control reasoning display (aliases off/preview/on) |

## Artifacts

| Command | Purpose |
|---|---|
| `/artifact [n\|path]` | List or preview generated artifacts |
| `/validate <n\|path>` | Validate an artifact by number or path |

## Permissions and quality

| Command | Purpose |
|---|---|
| `/permissions [MANUAL\|INERTIA\|MOMENTUM\|YOLO]` | Show or set the tool approval mode |
| `/quality [off\|observe\|rewrite …]` | Configure the experimental Semantic Judge (off by default) |
| `/agents [handle\|stop <handle>\|retry]` | List, inspect, interrupt, or retry SubAgent delivery |

## Input-box keys

| Key | Purpose |
|---|---|
| Enter | Send |
| Ctrl+Enter | Newline |
| Esc | Abort a running request |
| Double Esc (empty box, within 800ms) | Open the rewind picker |
| Double Esc (box has text) | Save the draft and clear it, without sending |
| Alt+V | Paste a clipboard image (only vision-capable models receive it) |
| Ctrl+Q | Exit Vesicle |
