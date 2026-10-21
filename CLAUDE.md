Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun check` instead of `tsc --noEmit`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Layout

- `src/form/`: the form spec schema, the `when` expression language, the form state machine (`controller.ts`), key bindings, and the OpenTUI view.
- `src/ask/`: the file-backed ask store and the hosts that open a form (zellij, tmux).
- `src/mcp/`: the MCP server.
- `src/cli.ts`: the `qmux` command.
- `skills/qmux-ask/`: the agent skill.

## Testing

- Keep form behaviour in `FormController` so it can be tested without a terminal.
- View tests use `createTestRenderer` from `@opentui/core/testing`.
- OpenTUI changes often, so `@opentui/core` is pinned to an exact version. Check its `.d.ts` files in `node_modules` rather than trusting memory of its API.
