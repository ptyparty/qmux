# qmux

A terminal multiplexer that agents can drive. Phase 1 is the agent forms layer: an agent asks the user questions, a form pops up in their terminal, and the answers come back as JSON. The form opens as a popup when the agent runs inside qmux, or in a zellij floating pane or a tmux popup.

## Setup

```bash
bun install
bun link                        # puts `qmux` on PATH
claude mcp add qmux -- qmux mcp # gives Claude Code the ask and wait tools
```

Copy or symlink `skills/qmux-ask` into `~/.claude/skills/` so agents know when and how to ask.

The `ask` and `wait` tools are marked read-only, so Claude Code can use them in plan mode without asking permission.

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

## Tab services

A layout in `~/.config/qmux/config.ts` can list `services`: background processes that start with the tab and stop when it closes. `projects.layoutFor` picks a layout for a particular project, overriding `projects.layout`:

```ts
export default {
  projects: { layout: "ide", layoutFor: { "q-space": "q-space" } },
  layouts: {
    "q-space": {
      services: [{ command: ["q-space", "serve"], name: "server" }],
      row: [{ command: ["q-space", "pane", "stories"], focus: true }, { column: [{ command: ["q-space", "pane", "reviews"] }, { command: ["q-space", "pane", "mentions"] }] }],
    },
  },
};
```

- **Named tabs:** `tabs: { "q-space": { layout: "q-space", cwd: "~/work/flipstone/q-space" } }` defines a tab with its own layout and working directory. Named tabs appear first in the Ctrl+t o launcher and work with `qmux project`, so a closed one can be reopened, which also restarts its services.
- **Startup:** `startup: ["q-space"]` opens those named tabs when a session starts, instead of a plain tab.
- **Shared directory:** every pane in a tab and every service it runs get `QMUX_TAB_DIR`, a private directory for that tab. A service can put its socket there for the tab's panes to find.
- **Stopping:** closing the tab, quitting the session, or the tab's last pane exiting sends the service's process group SIGTERM, then SIGKILL after 3 seconds. If the qmux server dies, the kernel stops its services too.
- **Logs and failures:** a service's output goes to `$QMUX_TAB_DIR/<name>.log`. A service that exits on its own puts `💥` on its tab and names its log.

From inside a pane, `qmux pane open [--right|--below|--tab] [--name NAME] [--no-focus] -- COMMAND...` opens a pane beside it in the same tab and prints the new pane's id. With `--popup` (and optionally `--width`/`--height` in percent), the command opens over the tab at once and takes the keys. The popup closes when the command exits successfully. After a failure it stays up until the next key, so the error can be read.

## Claude Code hooks

`qmux hook` lets Claude Code sessions running in qmux panes report what they are doing. Point these hook events at it in `~/.claude/settings.json`: `UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification` (matcher `*`) and `PermissionRequest` (matcher `*`, with a long timeout such as 3600 seconds). Use absolute paths, since hooks may not have `~/.bun/bin` on their PATH:

```json
{ "type": "command", "command": "/home/you/.bun/bin/bun /home/you/.bun/bin/qmux hook" }
```

With the hooks in place:

- **Badges:** pane titles and tabs show `🧠` working, `!` needs you, and `🚀` done.
- **Long commands:** in a fish pane, a command that runs a second or more shows `⏳` while it runs, then `🎉` or `💥` when it finishes. These sit beside an agent's badge, so a tab can show both. List programs that should never get these badges, such as editors and agents, in the config's `untrackedCommands`.
- **Alt+a** jumps to the next agent that needs you, then to finished ones. Typing in a finished pane clears its `🚀`.
- **Notifications:** an agent that needs you or finishes in a pane you are not looking at sends a terminal notification.
- **Permission popups:** a permission request opens a popup in the agent's tab with Allow once, Always allow and Deny. Esc hands the question back to Claude's own prompt.
- **Plan review:** when Claude finishes planning, the plan opens as rendered markdown in a popup. Approve in auto mode, approve and auto-accept edits, approve and review each edit, or keep planning with a note for Claude. Esc dismisses the plan and stops Claude, like Esc in Claude's own dialog.
- **Claude's questions:** with a `PreToolUse` hook on `AskUserQuestion`, Claude's questions open as a qmux popup in the agent's tab, and the answers go straight back to Claude. Esc falls back to Claude's own dialog.

Outside qmux, `qmux hook` exits at once and does nothing.

## Development

```bash
bun test
bun check
```
