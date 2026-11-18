#!/usr/bin/env node
import { runChecks } from "./check.js";
import { addWorkspace } from "./add.js";
import { removeWorkspace } from "./remove.js";
import { launchAll } from "./launch.js";
import { loadWorkspaces } from "./workspaces.js";
import { runSupervisor, printStatus } from "./supervisor/index.js";
import { modeCommand } from "./mode.js";
import { addManager } from "./manager/addManager.js";

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "check": {
    const results = await runChecks();
    for (const r of results) {
      console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(48)} ${r.detail}`);
      if (!r.ok && r.fix) console.log(`    → ${r.fix}`);
    }
    const bad = results.filter((r) => !r.ok).length;
    console.log(bad ? `\n${bad} item(s) to fix before launching.` : "\nAll good.");
    process.exitCode = bad ? 1 : 0;
    break;
  }
  case "add":
    await addWorkspace();
    break;
  case "list": {
    const list = loadWorkspaces();
    if (!list.length) console.log("No workspaces yet. Add one with: npm run add");
    for (const w of list)
      console.log(`${w.name.padEnd(14)} #${w.channelName.padEnd(16)} bot ${w.botName.padEnd(18)} ${w.folder}`);
    break;
  }
  case "remove":
    if (!args[0]) console.log("Usage: npm run remove -- <name>");
    else removeWorkspace(args[0]);
    break;
  case "start": {
    const names = args.filter((a) => !a.startsWith("--"));
    const fresh = args.find((a) => a.startsWith("--fresh="))?.slice(8).split(",");
    try {
      await runSupervisor({ only: names, fresh });
    } catch (e) {
      console.log(`✗ ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
    }
    break;
  }
  case "status":
    printStatus();
    break;
  case "add-manager":
    await addManager();
    break;
  case "mode":
    modeCommand(args[0], args[1]);
    break;
  case "launch": {
    const all = loadWorkspaces();
    const names = args.filter((a) => !a.startsWith("--"));
    const fresh = args.find((a) => a.startsWith("--fresh="))?.slice(8).split(",");
    launchAll(names.length ? all.filter((w) => names.includes(w.name)) : all, { dryRun: args.includes("--dry-run"), fresh });
    break;
  }
  case "setup": {
    const { setupCommand } = await import("./setup/server.js");
    await setupCommand();
    break;
  }
  case "stop": {
    const { stopSupervisor, supervisorPid } = await import("./supervisor/control.js");
    if (!supervisorPid()) {
      console.log("The supervisor is not running.");
      break;
    }
    console.log("Stopping the supervisor…");
    const ok = await stopSupervisor();
    console.log(ok ? "✓ Stopped." : "✗ It did not stop within 30 seconds. Check: npm run logs");
    process.exitCode = ok ? 0 : 1;
    break;
  }
  case "start-bg": {
    const { startInBackground, waitForSupervisor } = await import("./autostart.js");
    const r = startInBackground();
    console.log(`${r.ok ? "✓" : "✗"} ${r.detail}`);
    if (r.ok && !r.detail.startsWith("Already")) {
      const pid = await waitForSupervisor();
      console.log(pid ? `  running (pid ${pid}). See it with: npm run status` : "  it has not started yet. Check: npm run logs");
    }
    break;
  }
  case "trust": {
    const ws = loadWorkspaces().find((w) => w.name === args[0]);
    if (!ws) {
      console.log(args[0] ? `No workspace named "${args[0]}".` : "Usage: npm run trust -- <name>");
      process.exitCode = 1;
      break;
    }
    const { trustCommand } = await import("./trust.js");
    await trustCommand(ws);
    break;
  }
  case "autostart": {
    const { autostartStatus, disableAutostart, enableAutostart } = await import("./autostart.js");
    const sub = args[0] ?? "status";
    if (sub === "on" || sub === "off") {
      const r = sub === "on" ? enableAutostart() : disableAutostart();
      console.log(`${r.ok ? "✓" : "✗"} ${r.detail}`);
      process.exitCode = r.ok ? 0 : 1;
    } else console.log(`Auto-start at sign-in: ${autostartStatus().detail}\n  turn on/off: npm run autostart -- on | off`);
    break;
  }
  case "logs": {
    const { logFile } = await import("./supervisor/control.js");
    const fs = await import("node:fs");
    try {
      const lines = fs.readFileSync(logFile(), "utf8").split(/\r?\n/);
      console.log(lines.slice(-Number(args[0] ?? 60)).join("\n"));
      console.log(`\n(${logFile()})`);
    } catch {
      console.log("No background log yet. It is written when the supervisor runs in the background (setup page, start:bg, auto-start).");
    }
    break;
  }
  default:
    console.log(`workspace-bridge (M3)

  npm run setup                 open the setup page in your browser (recommended)
  npm run check                 check this PC is ready
  npm run add                   add a workspace (bot + channel + folder)
  npm run list                  list workspaces
  npm run remove -- <name>      remove a workspace
  npm start [-- names]          run workspaces in the background (no windows), restart them, show progress
         -- --fresh=web         start these with a new conversation
  npm run start:bg              same, in the background with no window (log: npm run logs)
  npm run stop                  stop the supervisor (terminal or background)
  npm run autostart -- on|off   start it automatically when you sign in to Windows
  npm run trust -- <name>       answer claude's one-time folder-trust question for a workspace
  npm run status                show what the supervisor is doing
  npm run mode -- <name> <mode> permission mode: auto (default), manual, acceptEdits, plan
  npm run add-manager           set up the manager bot (#control: /dashboard, /restart, /stop, alerts)
  npm run launch [-- names]     visible mode: open workspaces in Windows Terminal tabs
                                (use once per folder to answer the trust question)
         -- --dry-run           show what would run
         -- --fresh=web,api     start these with a new conversation`);
}
