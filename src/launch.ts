// Visible mode: start workspaces in Windows Terminal tabs instead of the headless supervisor.
// Use it to answer claude's one-time folder-trust question, or to watch a session while debugging.
// It uses the same launch spec as the supervisor (session ID, hooks, environment), so a session continues
// seamlessly when you switch between the two. Progress messages need the supervisor, so they are off here.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stateDir, type Workspace } from "./workspaces.js";
import { ensureBunShim } from "./bunShim.js";
import { buildSpec, cleanEnv, leakyNames, resolveClaude, type LaunchSpec, type Shim } from "./supervisor/spec.js";

const quoteArg = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

/** Windows batch file for one workspace. It re-applies the spec's environment because Windows Terminal starts tabs with its own. */
export function runScript(ws: Workspace, spec: LaunchSpec, claudeExe: string, clear: string[] = leakyNames()): string {
  const set = (k: string, v: string) => `set "${k}=${v}"`;
  const keep = ["DISCORD_STATE_DIR", "DISCORD_ACCESS_MODE", "NODE_USE_SYSTEM_CA", "MCP_TIMEOUT", "WSB_WORKSPACE", "WSB_EVENTS", "WSB_REAL_BUN"];
  const pathKey = Object.keys(spec.env).find((k) => k.toUpperCase() === "PATH");
  return [
    "@echo off",
    `title ${ws.name}`,
    ...clear.map((k) => `set "${k}="`),
    'set "DISCORD_BOT_TOKEN="',
    ...keep.filter((k) => spec.env[k] !== undefined).map((k) => set(k, String(spec.env[k]))),
    ...(spec.env.WSB_REAL_BUN && pathKey ? [set("PATH", String(spec.env[pathKey]).split(path.delimiter)[0] + ";%PATH%")] : []),
    `cd /d "${spec.cwd}"`,
    `"${claudeExe}" ${spec.args.map(quoteArg).join(" ")}`,
    "",
  ].join("\r\n");
}

/** Shell command for macOS/Linux users to run themselves (e.g. in tmux). */
export function posixCommand(spec: LaunchSpec, claudeExe = "claude"): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const keep = ["DISCORD_STATE_DIR", "DISCORD_ACCESS_MODE", "NODE_USE_SYSTEM_CA", "MCP_TIMEOUT", "WSB_WORKSPACE", "WSB_EVENTS"];
  const unset = [...new Set([...leakyNames(), "DISCORD_BOT_TOKEN", "BUN_INSPECT"])].map((k) => `-u ${k}`).join(" ");
  const vars = keep.filter((k) => spec.env[k] !== undefined).map((k) => `${k}=${q(String(spec.env[k]))}`).join(" ");
  return `cd ${q(spec.cwd)} && env ${unset} ${vars} ${claudeExe} ${spec.args.map(q).join(" ")}`;
}

export function launchAll(list: Workspace[], opts: { dryRun?: boolean; fresh?: string[] } = {}) {
  if (list.length === 0) {
    console.log("No workspaces yet. Add one with: npm run add");
    return;
  }
  let shim: Shim | undefined;
  let claudeExe = "claude";
  try {
    claudeExe = resolveClaude().file;
    if (process.platform === "win32") shim = ensureBunShim();
  } catch (e) {
    console.log(`✗ ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
    return;
  }
  for (const ws of list) {
    const spec = buildSpec(ws, { fresh: opts.fresh?.includes(ws.name), shim });
    const what = spec.resume ? `resume session ${spec.sessionId.slice(0, 8)}` : `new session ${spec.sessionId.slice(0, 8)}`;
    if (process.platform !== "win32") {
      console.log(`\n# ${ws.name} (${what})\n${posixCommand(spec, claudeExe)}`);
      continue;
    }
    const script = path.join(stateDir(ws.name), "run.cmd");
    fs.writeFileSync(script, runScript(ws, spec, claudeExe));
    const args = ["-w", "workspace-bridge", "new-tab", "--title", ws.name, "cmd", "/k", script];
    console.log(`${ws.name.padEnd(14)} ${what}  →  #${ws.channelName}  (${ws.folder})`);
    if (opts.dryRun) {
      console.log(`  wt ${args.join(" ")}`);
      continue;
    }
    spawn("wt", args, { detached: true, stdio: "ignore", windowsHide: false, env: cleanEnv() }).unref();
  }
  if (process.platform !== "win32") console.log("\nRun each command in its own terminal (or tmux window).");
  else if (!opts.dryRun)
    console.log(
      "\nOpened in Windows Terminal. Answer the folder-trust question in each new tab once.\nDon't run the supervisor (npm start) for the same workspace at the same time.",
    );
}
