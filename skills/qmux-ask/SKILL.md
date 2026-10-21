---
name: qmux-ask
description: Asks the user questions through a form that pops up in their terminal (a zellij floating pane or tmux popup) and returns the answers as JSON, via the qmux `ask`/`wait` MCP tools or the `qmux ask` CLI. Use when you need the user to make a decision, pick between options, confirm a risky action, or answer several questions at once instead of asking in chat, and when the user says "ask me", "give me a form", "popup", or "qmux".
---

# Asking the user with qmux

A form beats a chat question when the answer is a choice among known options, when several answers are needed before you can continue, or when a yes/no gate guards something risky. For open-ended discussion, ask in chat instead.

## Calling it

Prefer the MCP tools when the `qmux` server is connected:

1. `ask` with `{ "form": <spec>, "wait_seconds": 50 }`. It opens the form and waits up to `wait_seconds`.
2. If the result's `status` is `pending`, call `wait` with `{ "id": <id> }` until it is not. The user may be away, so keep waiting rather than re-asking.

Without MCP, use the CLI. It prints the same JSON:

```bash
qmux ask spec.json --wait --timeout 50
qmux wait <id> --timeout 50
qmux schema
```

Run `qmux ask` from a shell inside the user's zellij or tmux session. It picks the host from `$ZELLIJ` or `$TMUX`. If neither is set, the result's `message` holds a command the user can run to answer.

## Form spec

```json
{
  "title": "Deploy checkout-service",
  "description": "The build passed. A few choices before I ship it.",
  "elements": [
    { "type": "choice", "id": "env", "label": "Where?", "options": [
      { "value": "staging", "description": "resets nightly" }, "prod"
    ], "default": "staging" },
    { "type": "confirm", "id": "migrate", "label": "Run migrations?", "default": true },
    { "type": "text", "id": "reason", "label": "Why prod today?", "required": true, "when": "selected(env, \"prod\")" },
    { "type": "choice", "id": "notify", "label": "Notify", "options": ["#deploys", "#oncall"], "multi": true },
    { "type": "number", "id": "canary", "label": "Canary %", "min": 0, "max": 100, "step": 5, "default": 10 },
    { "type": "note", "text": "Esc cancels; nothing will deploy." }
  ]
}
```

Element types and their answer values:

| type | answer | notable fields |
|------|--------|----------------|
| `text` | string | `placeholder`, `default`, `multiline`, `required` |
| `confirm` | boolean | `default` |
| `choice` | string or null; array with `multi` | `options` (strings or `{value, label?, description?}`), `multi`, `default`, `required`, `other` |
| `number` | number | `min`, `max`, `step`, `default` |
| `note` | none | `text` |

A choice gets an "Other…" free-text option unless `"other": false`. When the user picks it, the typed text is returned as the answer. Pass `"other": false` when only the listed options make sense.

`when` shows an element only when an expression holds. It may reference only elements earlier in the form. The grammar has ids, string, number, and boolean literals, the comparisons `==`, `!=`, `<`, `<=`, `>`, `>=`, the operators `&&`, `||`, and `!`, parentheses, and the functions `selected(id, "value")`, `count(id)`, and `empty(id)`.

## Results

- `{"status":"submitted","values":{...}}`: one entry per element that was visible at submit time. Hidden elements are left out, so check for a key before reading it.
- `{"status":"cancelled"}`: the user pressed Esc or closed the pane. Treat this as "no". Do not reopen the same form; ask in chat what they want instead.
- `{"status":"pending"}`: not answered yet. Call `wait` again. When the ask's host was `none`, tell the user the command from `message`, or `qmux open <id>`, so they can answer.

## Writing good forms

- Put the default you recommend in `default`, and say why in its option's `description` or a `note`.
- Keep a form to one screen, about six elements. Split unrelated decisions into separate asks.
- Labels are questions the user can answer without scrolling back through chat. Include the specifics (names, numbers) in the label or description.
