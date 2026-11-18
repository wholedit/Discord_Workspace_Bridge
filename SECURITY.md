# Security

This tool turns a Discord account into remote control of a PC that runs Claude Code. Please report anything that weakens that boundary.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting**: the repository's **Security** tab → **Report a vulnerability**. Please do not open a public issue for security problems.

Include what you did, what happened, and the version (`git log -1 --oneline`). Never include real bot tokens.

## Threat model (what this tool defends)

| Boundary | How |
|---|---|
| Only the owner can drive a workspace | The official plugin's `access.json` allows one Discord user ID, one channel, and that user's DMs only |
| Only the owner can use manager commands | The manager bot checks the guild and the user ID on every command; replies are ephemeral |
| Bot tokens stay on the PC | Stored only under `~/.workspace-bridge` (outside the repo), never sent back to the setup page, never logged |
| Claude credentials are never touched | The tool runs the unmodified `claude` binary, which uses the user's own sign-in. It does not read, store or relay Claude credentials |
| Setup page is local only | Binds to 127.0.0.1, requires a random per-run key on every API call, checks Host and Origin headers (blocks other websites and DNS rebinding), closes when finished or after 20 idle minutes |
| No silent trust | claude's folder-trust question is never answered automatically |
| No "skip all checks" modes | `bypassPermissions` and `dontAsk` are not offered |
| No inbound ports | Everything is an outgoing connection to Discord |

## Out of scope

- A compromised Discord account (enable two-factor authentication; see `docs/05-security.md`).
- What Claude does inside a connected folder once you approve it, or in `auto` mode once the classifier allows it.
- Security issues in Claude Code, the official Discord plugin, Bun or Discord itself: report those to their owners.
