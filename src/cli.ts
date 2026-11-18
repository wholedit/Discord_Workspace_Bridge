#!/usr/bin/env node
import { runChecks } from "./check.js";
import { addWorkspace } from "./add.js";
import { removeWorkspace } from "./remove.js";
import { launchAll } from "./launch.js";
import { hasPreviousSession, loadWorkspaces } from "./workspaces.js";

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
      console.log(`${w.name.padEnd(12)} #${w.channelName.padEnd(16)} bot ${w.botName.padEnd(18)} ${w.folder}${hasPreviousSession(w.folder) ? "  (has conversation)" : ""}`);
    break;
  }
  case "remove":
    if (!args[0]) console.log("Usage: npm run remove -- <name>");
    else removeWorkspace(args[0]);
    break;
  case "launch": {
    const all = loadWorkspaces();
    const names = args.filter((a) => !a.startsWith("--"));
    const fresh = args.find((a) => a.startsWith("--fresh="))?.slice(8).split(",");
    launchAll(names.length ? all.filter((w) => names.includes(w.name)) : all, { dryRun: args.includes("--dry-run"), fresh });
    break;
  }
  default:
    console.log(`workspace-bridge (M0)

  npm run check                 check this PC is ready
  npm run add                   add a workspace (bot + channel + folder)
  npm run list                  list workspaces
  npm run remove -- <name>      remove a workspace
  npm run launch [-- names]     start workspaces in Windows Terminal tabs
         -- --dry-run           show what would run
         -- --fresh=web,api     start these with a new conversation`);
}
