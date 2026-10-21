# qmux

A terminal multiplexer that agents can drive. Phase 1 is the agent forms layer: an agent asks the user questions, a form pops up in their terminal, and the answers come back as JSON. The form opens as a popup when the agent runs inside qmux, or in a zellij floating pane or a tmux popup.

## Setup

```bash
bun install
bun link                        # puts `qmux` on PATH
claude mcp add qmux -- qmux mcp # gives Claude Code the ask and wait tools
```

Copy or symlink `skills/qmux-ask` into `~/.claude/skills/` so agents know when and how to ask.

## Usage

```bash
qmux form examples/deploy.json                   # try a form in this terminal
qmux ask examples/deploy.json --wait             # pop it up for the user and wait
qmux ask spec.json                               # pop it up and return an id
qmux wait <id> --timeout 50                      # collect the answer later
qmux open <id>                                   # show a pending ask's form, e.g. one asked with no host
qmux pending                                     # list unanswered asks
qmux schema                                      # JSON Schema for form specs
qmux mcp                                         # MCP server on stdio
```

Run `qmux --help` for every option. `skills/qmux-ask/SKILL.md` documents the form spec.

### Keys in a form

| Key | Action |
|-----|--------|
| Tab / Shift+Tab | next / previous field |
| ↑ ↓ | move through choice options; move between other fields; leave a multi-line box from its first or last line |
| ← → | Yes/No on a confirm (also `y`/`n`), adjust a number |
| Space | toggle a multi-choice option |
| Enter | next field (a new line in a multi-line box); submit when on the submit button |
| Ctrl+S | submit from anywhere |
| Esc / Ctrl+C | cancel |

The bottom bar lists the keys that work in the focused field.

## How asks work

Each ask is stored as a directory under `$XDG_RUNTIME_DIR/qmux/asks/<id>/`. Set `QMUX_STATE_DIR` to store them somewhere else.

- **Files:** `spec.json` holds the form, and `result.json` appears once the user submits or cancels. The first result written wins.
- **Lifecycle:** closing the form's pane records a cancel. Asks older than a day are deleted.
- **No daemon:** `ask`, `wait`, the MCP server, and the form process share state only through these files.

## Claude Code hooks

`qmux hook` lets Claude Code sessions running in qmux panes report what they are doing. Point these hook events at it in `~/.claude/settings.json`: `UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification` (matcher `*`) and `PermissionRequest` (matcher `*`, with a long timeout such as 3600 seconds). Use absolute paths, since hooks may not have `~/.bun/bin` on their PATH:

```json
{ "type": "command", "command": "/home/you/.bun/bin/bun /home/you/.bun/bin/qmux hook" }
```

With the hooks in place:

- **Badges:** pane titles and tabs show `●` working, `!` needs you, and `✓` done.
- **Alt+a** jumps to the next agent that needs you, then to finished ones. Looking at a finished pane clears its `✓`.
- **Notifications:** an agent that needs you or finishes in a pane you are not looking at sends a terminal notification.
- **Permission popups:** a permission request opens a popup in the agent's tab with Allow once, Always allow and Deny. Esc hands the question back to Claude's own prompt.

Outside qmux, `qmux hook` exits at once and does nothing.

## Development

```bash
bun test
bun check
```
