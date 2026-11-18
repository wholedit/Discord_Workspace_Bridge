# Changelog

## 0.1.0 — 2026-11-18

First public version. Windows 10/11.

- **Setup page** (`npm run setup`): PC check, step-by-step bot setup (token check, Message Content Intent / Public Bot check, invite detection, channel and folder pickers), first run with folder trust, manager bot setup, background start/stop, auto-start toggle.
- **Supervisor**: runs every workspace's `claude` without windows using the official Discord channel plugin, one bot per workspace; automatic restarts with backoff; each workspace keeps its own conversation across restarts; picks up workspace and manager changes without a restart.
- **Progress messages**: quiet, edited status message in the channel while Claude uses tools; waiting-for-approval state.
- **Manager bot** (`#control`): `/dashboard`, `/status`, `/stop`, `/restart`, `/new`, `/mode`, `/logs`, `/ping`, `/lockdown`; alerts for failures, folder trust, plugin problems, restarts.
- **Permission modes**: `auto` (default), `manual`, `acceptEdits`, `plan`.
- **Always on**: background run (`start:bg`, `stop`, `logs`), start at Windows sign-in, sleep prevention while running.
- The Discord plugin's own tools (reply, react, attachments) never ask for approval, so `manual` mode only asks about real work.
- "Supervisor online" is posted once the bots have connected, so the dashboard in it shows real states.
- Works on networks that inspect HTTPS (uses the Windows certificate store).
- Works around claude passing a debugger setting to Bun-based plugins on Windows (`bun.exe` wrapper).
