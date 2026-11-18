# Contributing

Thanks for helping. Issues and pull requests are welcome in Korean or English.

## Development

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

Tests use fakes for Discord and the terminal, so they never need a real bot or Claude account. Run the app against a throwaway state folder by setting `WORKSPACE_BRIDGE_HOME` to an empty directory.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | Command dispatch (`npm run …`) |
| `src/setup/` | Setup page: HTTP server, API logic, static page |
| `src/supervisor/` | Runs each workspace's `claude` in a pseudo-terminal, restarts, progress messages, control requests |
| `src/manager/` | Manager bot (slash commands, alerts) |
| `src/workspaces.ts` | Workspace registry and the official plugin's state folders |
| `src/discordApi.ts` | Minimal Discord REST helpers |
| `src/autostart.ts` | Background start and the Windows sign-in task |
| `hooks/progress-hook.mjs` | Claude Code hook that records tool use for progress messages |
| `shim/*.cs` | Small Windows helpers compiled on the user's PC with the built-in C# compiler |
| `docs/` | User guides (Korean); `docs/dev/` has the plan and milestone notes |

## Ground rules

These keep the project within Anthropic's policies and safe to run unattended. Please don't send changes that break them.

1. **Never read, store or relay Claude credentials.** Run the unmodified `claude` binary and let it use the user's own sign-in. No Agent SDK login, no token extraction.
2. **Use the official Discord channel plugin unchanged** (`discord@claude-plugins-official`).
3. **Never answer the folder-trust prompt automatically.**
4. **Don't offer `bypassPermissions` or `dontAsk`.**
5. **Don't use "Claude" or "Claude Code" as part of the product name or logo.** Plain factual mentions ("runs Claude Code") are fine.
6. Keep tokens out of logs, the repository and anything sent to the browser.
7. Avoid new unsigned helper executables; corporate security software tends to block them. Prefer Node.

## Pull requests

- Keep them focused, with a short description of what changed and how you tested it.
- Add or update tests for behaviour changes.
- Update the docs when commands or behaviour change.
