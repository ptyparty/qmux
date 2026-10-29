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

## Layout jobs

A layout in `~/.config/qmux/config.ts` can list `jobs`: commands that start out of sight with the tab, like jobs from Ctrl+s n, and close with it. `dock: true` docks one from the start. `projects.layoutFor` picks a layout for a particular project, overriding `projects.layout`:

```ts
export default {
  projects: { layout: "ide", layoutFor: { "q-space": "q-space" } },
  layouts: {
    "q-space": {
      jobs: [{ command: ["q-space", "serve"], name: "server", dock: true }],
      row: [{ command: ["q-space", "pane", "stories"], focus: true }, { column: [{ command: ["q-space", "pane", "reviews"] }, { command: ["q-space", "pane", "mentions"] }] }],
    },
  },
};
```

- **Named tabs:** `tabs: { "q-space": { layout: "q-space", cwd: "~/work/flipstone/q-space" } }` defines a tab with its own layout and working directory. Named tabs appear first in the Ctrl+t o launcher and work with `qmux project`, so a closed one can be reopened, which also restarts its jobs.
- **Startup:** `startup: ["q-space"]` opens those named tabs when a session starts, instead of a plain tab.
- **Shared directory:** every pane and job in a tab gets `QMUX_TAB_DIR`, a private directory for that tab. A job can put its socket there for the tab's panes to find.
- **Without jobs:** Alt+Enter in the Ctrl+t o launcher opens a project without starting its layout's jobs. Ctrl+s s starts them later.
- **Earlier configs:** layouts used to take `services`; rename them to `jobs`.

From inside a pane, `qmux pane open [--right|--below|--tab] [--name NAME] [--no-focus] -- COMMAND...` opens a pane beside it in the same tab and prints the new pane's id. With `--popup` (and optionally `--width`/`--height` in percent), the command opens over the tab at once and takes the keys. The popup closes when the command exits successfully. After a failure it stays up until the next key, so the error can be read.

## Jobs

A job is a command that runs out of sight in a tab, in a terminal of its own. Press Ctrl+s for jobs mode, which lists the tab's jobs:

- **n** prompts for a command and runs it as a job in the focused pane's directory.
- **b** sends the focused pane to the background while it is busy with a long command. Its shell keeps running, and the job is done when that command finishes. This needs the fish integration that also drives the `⏳` badges.
- **↑/↓** pick a job, **Enter** opens it over the tab, **h** hides it again, **r** re-runs it, **p** moves it into the layout as a pane, and **x** closes it, stopping it if it is still running.
- **d** docks the job, or undocks it. Docked jobs sit in a strip at the bottom of the tab, one row each: the job's name, then its last line of output, or for an agent its state and the first line of its last reply. Docking doesn't depend on whether the job is shown. Click a row to open the job.
- **s** starts the tab's layout jobs that aren't running, for example after opening a project without them or closing one.

The mode row lists the tab's jobs that aren't docked, just left of the tray, each with its state, such as `⏳ make  💥 build`. Click one to open it. When the row is short of room, names get shorter, then the jobs collapse to counts like `⏳2 💥1`. While a job runs, its tab shows `⏳`. A job that succeeds shows a toast for five seconds. A job that fails keeps its toast and puts `💥` on its tab until you open it; Alt a or a click on the toast opens it. A finished job's popup takes Enter to re-run, p to move into the layout, x to close, and Esc to hide. While a job runs, keys go to it, so Ctrl+c stops it. **Alt j** hides the open job, running or not, and with no job open reopens the last one you opened. A job running an agent that Alt a opened for you hides by itself once you reply and the agent is back at work.

`qmux job run [--name NAME] [--wait] -- COMMAND...` runs a job in the tab of the pane it is called from. With `--wait` it prints the job's output, without colours, as it runs and exits with the job's exit code. That lets an agent run builds and tests that you can watch too, for example with this line in a `CLAUDE.md`:

```
Run builds and test suites with `qmux job run --wait -- <command>` so the user can follow them.
```

Closing a tab closes its jobs. A job's output is also written to `$QMUX_TAB_DIR/jobs/<id>.log`.

## Native Claude (experimental)

`qmux claude [--resume ID|--continue] [-- CLAUDE_ARGS...]` runs a Claude Code session in the pane with qmux drawing the conversation instead of Claude's own TUI. Claude's text renders as markdown as it streams, each tool call is one line that gets a ✓ or ✗ when it finishes, and a status line shows whether Claude is ready, working or waiting for you, with the model, cost and session id. Arguments after `--` go to `claude`, for example `-- --model sonnet --permission-mode acceptEdits`.

- **Enter** sends the message in the box at the bottom, **Alt+Enter** adds a newline, and messages sent while Claude works wait their turn.
- **/** lists Claude's slash commands, skills included, filtered as you type. ↑↓ pick one, **Tab** completes it so you can add arguments, **Enter** runs it, and **Esc** hides the list (and still interrupts Claude while it works). `/exit` and `/quit` quit.
- **Esc** interrupts Claude while it works.
- **PgUp/PgDn** or the mouse wheel scroll back through the conversation.
- **Ctrl+d** on an empty box quits and prints `claude --resume <id>`, so the conversation can carry on in Claude's TUI. A conversation can't be open in both at once.

Permission requests, plans to review and Claude's questions open as the same qmux popups the hooks use, wherever you are in the tab, and the hooks keep the tab's `🧠` and `🚀` badges up to date. From any pane in the tab, **Alt+c** opens a box that sends a message to the tab's native Claude (the focused one, or else the first) without moving focus.

Started without `--resume` or `--continue` in a directory with past conversations, `qmux claude` first lists them in the pane: conversations open in another qmux pane, ones running in other terminals, **New conversation**, and the last few past ones with their age and last prompt. Picking one open in a qmux pane moves focus there and closes this pane instead of opening the conversation twice. Esc quits. Run as a job, such as from a layout, it always asks, and adds **Don't start Claude**, which closes the job; Ctrl+s s starts it again.

Add `qmux` to `untrackedCommands` if the `⏳` badge on a pane running `qmux claude` gets in the way.

## Scrollback

Each pane keeps 50 MB of history by default, roughly 70,000 lines at 80 columns and fewer in wider panes. Memory is only used as history fills. Set `scrollback` in the config to another number of megabytes.

## Tray

The right end of the mode bar holds the tray: by default a CPU and memory widget and a clock. Click a widget, or press Ctrl+t w, pick one with h/s, and press Enter, to open its popup. The system widget opens btop, htop, or top, whichever is installed first in that order.

```ts
export default {
  tray: [
    { widget: "system" },
    { name: "branch", command: ["git", "branch", "--show-current"], every: 5000 },
    { name: "uptime", render: () => `up ${Math.round(process.uptime())}s`, open: ["htop"] },
    { widget: "clock", format: "ddd D MMM HH:mm" },
  ],
};
```

- **Command widgets** show the first line a program prints. They run every `every` milliseconds (10 seconds by default) and show `!` after a failure.
- **TypeScript widgets** call `render` every `every` milliseconds (1 second by default). It may return a promise.
- **Popups:** `open` is the command a widget's popup runs. Widgets without one open nothing.
- **Clock formats** use `dddd ddd YYYY MMM MM DD D HH mm ss`, on a 24 hour clock.

## Images

When the terminal qmux is attached to supports kitty graphics, programs in panes can show images using kitty's Unicode placeholders, the same way they would inside tmux. In fish panes, `kitten icat shot.png` adds `--unicode-placeholder` for you; elsewhere, pass it yourself. The image scrolls and moves with the pane's text, and it shows in tabs and popups.

- **Other placements:** images placed at the cursor in the classic way (`kitten icat` without `--unicode-placeholder`) are not shown.
- **Extra terminals:** a terminal that attaches later is sent the images panes have shown. Images from a pane are deleted when it closes.
- **Pixel size:** panes report their size in pixels, so programs can size images to fit.
- **Forms:** an `image` element shows a picture in an ask. On a terminal without kitty graphics, the form shows the image's caption and path instead. Panes get `QMUX_KITTY_GRAPHICS=1` when the attached terminal supports kitty graphics.

## Claude Code hooks

`qmux hook` lets Claude Code sessions running in qmux panes report what they are doing. `qmux hooks` lists any that are missing from your settings and `qmux hooks --install` adds them, keeping the old file as `settings.json.qmux-backup`. `qmux claude` offers the same when it starts inside qmux. Point these hook events at it in `~/.claude/settings.json`: `UserPromptSubmit`, `Stop`, `SessionEnd`, `Notification` (matcher `*`) and `PermissionRequest` (matcher `*`, with a long timeout such as 3600 seconds). Use absolute paths, since hooks may not have `~/.bun/bin` on their PATH:

```json
{ "type": "command", "command": "/home/you/.bun/bin/bun /home/you/.bun/bin/qmux hook" }
```

With the hooks in place:

- **Badges:** pane titles and tabs show `🧠` working, `!` needs you, and `🚀` done.
- **Long commands:** in a fish pane, a command that runs a second or more shows `⏳` while it runs, then `🎉` or `💥` when it finishes. These sit beside an agent's badge, so a tab can show both. List programs that should never get these badges, such as editors and agents, in the config's `untrackedCommands`.
- **Alt+a** jumps to the next agent that needs you, then to finished ones. Typing in a finished pane clears its `🚀`.
- **Notifications:** an agent that needs you or finishes in a pane you are not looking at sends a terminal notification.
- **Replies:** when an agent finishes in a pane you are not looking at, its last reply waits for you. Its tab shows `💬` and a toast shows the reply's first line until you look at the pane. **Alt p** switches to the reply's tab and opens the reply as rendered markdown in a popup: the focused agent's, or else the newest unread one, or else the newest in this tab. Pick **Go to it** there to jump to the agent's pane or job. **Alt x** dismisses the oldest reply toast without opening it; with no reply toast up, Alt x goes to the program in the pane as usual.
- **Permission popups:** a permission request opens a popup in the agent's tab with Allow once, Always allow and Deny. Esc hands the question back to Claude's own prompt.
- **Plan review:** when Claude finishes planning, the plan opens as rendered markdown in a popup. Approve in auto mode, approve and auto-accept edits, approve and review each edit, or keep planning with a note for Claude. Esc dismisses the plan and stops Claude, like Esc in Claude's own dialog.
- **Claude's questions:** with a `PreToolUse` hook on `AskUserQuestion`, Claude's questions open as a qmux popup in the agent's tab, and the answers go straight back to Claude. Esc falls back to Claude's own dialog.
- **Sessions:** with `SessionStart` (no matcher) also pointed at the hook, qmux knows which conversation each pane holds as soon as it starts. Without it, a pane's conversation is known from its first prompt. `qmux claude` uses this to send you to a conversation that is already open.
- **Background commands as jobs:** with a `PreToolUse` hook on `Bash` (matcher `AskUserQuestion|Bash` covers both), commands Claude runs in the background, such as dev servers and watchers, run as jobs in the agent's tab, named after Claude's description of them. The job starts in the directory and environment of Claude's shell. Claude still reads its output and can stop it; stopping one closes its job. Permission rules and prompts see the command wrapped in `qmux job run`, so the qmux popup offers no "Always allow" for it.
- **Commands that must be jobs:** list them in the config's `agentJobs`, such as `["scripts/up", "scripts/build"]`. When an agent runs one in the foreground or with `--detach`, the hook refuses and tells it to run the command in the background, so it becomes a job. A second run while one is still going in the tab is refused too. Only commands in command position count, so `cat scripts/up` is fine.

- **Waking on answers:** a second `Stop` hook running `qmux hook --wake` with `"async": true, "asyncRewake": true` waits, in the background, for forms the agent opened and left pending. When you answer or dismiss one, Claude wakes up with the answer instead of waiting for your next prompt.

```json
{ "type": "command", "command": "/home/you/.bun/bin/bun /home/you/.bun/bin/qmux hook --wake", "async": true, "asyncRewake": true, "timeout": 86400 }
```

Outside qmux, `qmux hook` exits at once and does nothing.

## Development

```bash
bun test
bun check
```
