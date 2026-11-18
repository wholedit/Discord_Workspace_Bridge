// How to start one workspace's claude: command, arguments, environment, session ID and hook settings.
// Shared by the headless supervisor and the visible Windows Terminal mode, so both behave the same.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PLUGIN_ID, claudeProjectDir, modeOf, stateDir, type Workspace } from "../workspaces.js";

export type ClaudeCommand = { file: string; prefixArgs: string[] };
export type Shim = { dir: string; realBun: string };

/**
 * Variables that must not leak from the terminal that started us:
 * - BUN_INSPECT*: makes the plugin's Bun try to open a debugger port (see shim/bun-shim.cs)
 * - CLAUDECODE / CLAUDE_CODE_* / …: set when started from inside another Claude session or the desktop app's terminal;
 *   they would tie the workspace session to that parent session.
 * - DISCORD_BOT_TOKEN: would override this workspace's own token.
 */
const LEAKY = /^(BUN_INSPECT|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PROJECT_DIR$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|MCP_CONNECTION_NONBLOCKING$|MCP_SERVER_CONNECTION_BATCH_SIZE$|DISCORD_BOT_TOKEN$)/i;

export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!LEAKY.test(k)) out[k] = v;
  return out;
}

/** Names of leaky variables present in env (used to clear them in run.cmd). */
export function leakyNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => LEAKY.test(k));
}

/** Locate the claude executable. node-pty needs a real path on Windows. */
export function resolveClaude(): ClaudeCommand {
  if (process.platform === "win32") {
    const r = spawnSync("where", ["claude.exe"], { encoding: "utf8" });
    const hit = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (!hit) throw new Error("claude.exe not found on PATH. Install Claude Code first (npm run check).");
    return { file: hit, prefixArgs: [] };
  }
  const r = spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" });
  const hit = (r.stdout ?? "").trim();
  if (!hit) throw new Error("claude not found on PATH. Install Claude Code first (npm run check).");
  return { file: hit, prefixArgs: [] };
}

// ---------- session ID ----------

const sessionFile = (ws: Workspace) => path.join(stateDir(ws.name), "session.json");

/** The workspace's own conversation ID. A new one is created on first use or when fresh is true. */
export function getSessionId(ws: Workspace, fresh = false): string {
  if (!fresh) {
    try {
      const id = JSON.parse(fs.readFileSync(sessionFile(ws), "utf8")).sessionId;
      if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) return id;
    } catch {}
  }
  const id = randomUUID();
  fs.mkdirSync(stateDir(ws.name), { recursive: true });
  fs.writeFileSync(sessionFile(ws), JSON.stringify({ sessionId: id, createdAt: new Date().toISOString() }, null, 2));
  return id;
}

/** True once claude has written the conversation file, i.e. --resume will work. */
export function sessionExists(ws: Workspace, id: string, claudeHome?: string): boolean {
  return fs.existsSync(path.join(claudeProjectDir(ws.folder, claudeHome), `${id}.jsonl`));
}

// ---------- progress hook ----------

const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "hooks", "progress-hook.mjs");
export const eventsFile = (ws: Workspace) => path.join(stateDir(ws.name), "events.jsonl");

/** Settings passed with --settings: async hooks that append tool/turn events for the supervisor to show in Discord. */
export function hookSettings(nodePath = process.execPath, script = HOOK_SCRIPT) {
  const cmd = `"${nodePath.replace(/\\/g, "/")}" "${script.replace(/\\/g, "/")}"`;
  const h = (matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd, async: true, timeout: 10 }] }];
  return {
    hooks: {
      UserPromptSubmit: h(),
      PreToolUse: h("*"),
      Notification: h("permission_prompt"),
      Stop: h(),
      StopFailure: h(),
    },
  };
}

export function writeHookSettings(ws: Workspace): string {
  const file = path.join(stateDir(ws.name), "settings.json");
  fs.mkdirSync(stateDir(ws.name), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(hookSettings(), null, 2));
  return file;
}

// ---------- full spec ----------

export type LaunchSpec = { cwd: string; args: string[]; env: NodeJS.ProcessEnv; sessionId: string; resume: boolean };

export function buildSpec(ws: Workspace, opts: { fresh?: boolean; shim?: Shim; baseEnv?: NodeJS.ProcessEnv; claudeHome?: string } = {}): LaunchSpec {
  const sessionId = getSessionId(ws, opts.fresh);
  const resume = sessionExists(ws, sessionId, opts.claudeHome);
  const settings = writeHookSettings(ws);
  const args = [
    resume ? "--resume" : "--session-id",
    sessionId,
    "--name",
    ws.name,
    "--permission-mode",
    modeOf(ws),
    "--channels",
    `plugin:${PLUGIN_ID}`,
    "--settings",
    settings,
  ];

  const env = cleanEnv(opts.baseEnv ?? process.env);
  env.DISCORD_STATE_DIR = stateDir(ws.name);
  env.DISCORD_ACCESS_MODE = "static";
  env.NODE_USE_SYSTEM_CA = "1"; // networks that inspect HTTPS
  env.MCP_TIMEOUT = "120000"; // the plugin runs `bun install` on every start; 30 s is too tight on slow networks
  env.WSB_WORKSPACE = ws.name;
  env.WSB_EVENTS = eventsFile(ws);
  if (opts.shim) {
    env.WSB_REAL_BUN = opts.shim.realBun;
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
    env[key] = `${opts.shim.dir}${path.delimiter}${env[key] ?? ""}`;
  }
  return { cwd: ws.folder, args, env, sessionId, resume };
}
