# Discord Workspace Bridge

**Give tasks to Claude Code workspaces on your PC from Discord on your phone.**
One channel = one bot = one project folder on your PC. Leave the PC on; from anywhere, send a request from your phone, watch progress, read the result, and tap approval buttons.

[한국어](README.md)

<!-- screenshot: docs/images/demo.gif (optional) -->
<!-- screenshot: docs/images/phone-progress.png -->

```
 📱 Discord on your phone                🖥️ PC at home / office (left on)
 ├ #web     ← web-bot    ─────────▶  claude (C:\projects\web)
 ├ #api     ← api-bot    ─────────▶  claude (C:\projects\api)
 └ #control ← manager-bot ────────▶  supervisor: status, restarts, alerts
```

- **Runs Anthropic's own components unchanged**: the official `claude` CLI, signed in with your own Claude subscription (Pro/Max), and Anthropic's official Discord channel plugin. This tool **never reads or stores your Claude credentials.**
- **Setup page**: a local web page that walks you through checking the bot token, detecting the invite, and picking the channel and folder.
- **Runs without windows**: automatic restarts, conversations continue across restarts, start at Windows sign-in, sleep prevention.
- **Progress**: while Claude works, a quiet `🟡 Running · tools 7` message is updated in the channel; the final reply notifies you.
- **Manage from your phone**: `/dashboard`, `/stop`, `/restart`, `/new`, `/mode`, `/logs`, `/ping`, `/lockdown` and failure alerts in `#control`.
- **Safe defaults**: only your account can give commands, each bot handles only its own channel, risky actions ask for approval by DM, and folder trust is always answered by a person.

> Not made or endorsed by Anthropic. This is an unofficial tool that runs Claude Code.

## Quick start (Windows)

You need: a Claude Pro/Max subscription, [Claude Code](https://code.claude.com/docs/en/quickstart) (signed in), [Node.js](https://nodejs.org) 22.15+, [Bun](https://bun.sh), the official Discord plugin (`/plugin install discord@claude-plugins-official` inside `claude`), and a private Discord server.

```bash
git clone https://github.com/wholedit/Discord_Workspace_Bridge.git
```

```bash
cd Discord_Workspace_Bridge
```

```bash
npm install
```

```bash
npm run setup
```

The setup page opens in your browser: PC check → create a bot → token → invite → channel → folder → run → auto-start.

For each workspace, create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) (New Application → Bot → Reset Token), turn **Message Content Intent on** and **Public Bot off**. The page checks both and links to the right settings screen.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Open the setup page |
| `npm start` | Run in this terminal (Ctrl+C to stop) |
| `npm run start:bg` / `npm run stop` | Run in the background with no window / stop it |
| `npm run status` / `npm run logs` | Status / background log |
| `npm run autostart -- on\|off` | Start at Windows sign-in (per-user task, no admin rights) |
| `npm run mode -- <name> <mode>` | Permission mode: `auto` (default), `manual`, `acceptEdits`, `plan` |
| `npm run trust -- <name>` | Answer claude's one-time folder-trust question |
| `npm run check` | Check this PC is ready |

## Manager bot (`#control`)

| Command | |
|---|---|
| `/dashboard` | All workspaces at a glance |
| `/status ws:<name>` | One workspace in detail |
| `/stop ws:<name>` | Stop the task in progress (like Esc); the session continues |
| `/restart ws:<name\|all>` | Restart; the conversation continues |
| `/new ws:<name>` | Restart with a new conversation |
| `/mode ws:<name> mode:<mode>` | Change the permission mode |
| `/logs ws:<name>` | Recent terminal output |
| `/ping` | PC uptime, CPU, memory, disk, sleep prevention |
| `/lockdown confirm:True` | Emergency stop of every workspace |

## Security in short

Your Discord account becomes remote access to your PC. Turn on Discord two-factor authentication, keep every bot's Public Bot off, use a private server, and treat bot tokens like passwords. If you lose your phone: `/lockdown confirm:True` from another device, then log the phone out in Discord settings. Bot tokens live only in `~/.workspace-bridge`. The setup page listens on 127.0.0.1 only and needs the random key in its URL.

## Cost

The tool is free (MIT). Claude usage counts against your own Claude subscription.

## Status

v0.1.0. Tested on Windows 10/11. macOS and Linux are untested (auto-start and sleep prevention are Windows only). Discord channels are a research preview in Claude Code and may change.

Detailed guides are in Korean under [docs/](docs/). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Changes: [CHANGELOG.md](CHANGELOG.md)
