// Start one interactive `claude --channels` per workspace.
// M0: each runs in its own Windows Terminal tab so you can see it and answer the one-time folder-trust prompt.
// (M1 replaces this with a supervisor that runs them without windows and restarts them.)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PLUGIN_ID, hasPreviousSession, stateDir, type Workspace } from "./workspaces.js";
import { ensureBunShim } from "./bunShim.js";

/** Bun debugger settings that must not leak into the plugin process. */
export const BUN_DEBUG_VARS = ["BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "BUN_INSPECT_NOTIFY", "BUN_INSPECT_BRK", "BUN_INSPECT_WAIT"];

/** Copy of the environment without Bun debugger settings. */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) if (BUN_DEBUG_VARS.includes(k.toUpperCase())) delete out[k];
  return out;
}

export function claudeArgs(ws: Workspace, resume: boolean): string[] {
  return [...(resume ? ["--continue"] : []), "--name", ws.name, "--channels", `plugin:${PLUGIN_ID}`];
}

/** Windows batch file that sets the plugin's state folder and starts claude in the workspace folder. */
export function runScript(ws: Workspace, resume: boolean, shim?: { dir: string; realBun: string }): string {
  return [
    "@echo off",
    `title ${ws.name}`,
    `set "DISCORD_STATE_DIR=${stateDir(ws.name)}"`,
    'set "DISCORD_ACCESS_MODE=static"',
    // Trust the OS certificate store, so networks with HTTPS inspection (company/security software) work for the plugin's Bun runtime.
    'set "NODE_USE_SYSTEM_CA=1"',
    // A token set globally in the shell would override this workspace's .env, so clear it.
    'set "DISCORD_BOT_TOKEN="',
    // Debugger variables inherited from some terminals (e.g. an app's built-in terminal) make the plugin's Bun
    // try to open an inspector port and fail, so the plugin never connects.
    ...BUN_DEBUG_VARS.map((v) => `set "${v}="`),
    // claude itself hands BUN_INSPECT to the plugin, so the plugin's "bun" must be our wrapper (src/bunShim.ts).
    ...(shim ? [`set "WSB_REAL_BUN=${shim.realBun}"`, `set "PATH=${shim.dir};%PATH%"`] : []),
    `cd /d "${ws.folder}"`,
    `claude ${claudeArgs(ws, resume).join(" ")}`,
    "",
  ].join("\r\n");
}

/** Shell command for macOS/Linux users to run themselves (e.g. in tmux). */
export function posixCommand(ws: Workspace, resume: boolean): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const unset = BUN_DEBUG_VARS.map((v) => `-u ${v}`).join(" ");
  const vars = `DISCORD_STATE_DIR=${q(stateDir(ws.name))} DISCORD_ACCESS_MODE=static NODE_USE_SYSTEM_CA=1 DISCORD_BOT_TOKEN=`;
  return `cd ${q(ws.folder)} && env ${unset} ${vars} claude ${claudeArgs(ws, resume).join(" ")}`;
}

export function launchAll(list: Workspace[], opts: { dryRun?: boolean; fresh?: string[] } = {}) {
  if (list.length === 0) {
    console.log("No workspaces yet. Add one with: npm run add");
    return;
  }
  let shim: { dir: string; realBun: string } | undefined;
  if (process.platform === "win32") {
    try {
      shim = ensureBunShim();
    } catch (e) {
      console.log(`✗ ${e instanceof Error ? e.message : e}`);
      process.exitCode = 1;
      return;
    }
  }
  for (const ws of list) {
    const resume = !opts.fresh?.includes(ws.name) && hasPreviousSession(ws.folder);
    if (process.platform !== "win32") {
      console.log(`\n# ${ws.name}\n${posixCommand(ws, resume)}`);
      continue;
    }
    const script = path.join(stateDir(ws.name), "run.cmd");
    fs.writeFileSync(script, runScript(ws, resume, shim));
    const args = ["-w", "workspace-bridge", "new-tab", "--title", ws.name, "cmd", "/k", script];
    console.log(`${ws.name.padEnd(12)} ${resume ? "continue last conversation" : "new conversation"}  →  #${ws.channelName}  (${ws.folder})`);
    if (opts.dryRun) {
      console.log(`  wt ${args.join(" ")}`);
      continue;
    }
    spawn("wt", args, { detached: true, stdio: "ignore", windowsHide: false, env: cleanEnv() }).unref();
  }
  if (process.platform !== "win32") console.log("\nRun each command in its own terminal (or tmux window).");
  else if (!opts.dryRun)
    console.log("\nOpened in Windows Terminal. First launch of a folder asks you to trust it — answer that once in the tab, then everything works from your phone.");
}
