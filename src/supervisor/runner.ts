// Keeps one workspace's interactive claude running inside a pseudo-terminal (no window).
// - restarts it with backoff when it exits
// - stops (does not restart) when claude asks the one-time folder-trust question, which a person must answer
// - tracks whether the Discord plugin connected by reading claude's MCP log for this folder

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Workspace } from "../workspaces.js";
import { buildSpec, getSessionId, type ClaudeCommand, type LaunchSpec, type Shim } from "./spec.js";

const require = createRequire(import.meta.url);

export type RunnerState = "starting" | "running" | "restarting" | "needs-trust" | "stopped" | "failed";
export type PluginState = "unknown" | "connected" | "failed";

type Pty = { pid: number; onData(cb: (d: string) => void): void; onExit(cb: (e: { exitCode: number }) => void): void; kill(): void; write(d: string): void };
export type PtySpawn = (file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number; name?: string }) => Pty;

export const defaultPtySpawn: PtySpawn = (file, args, opts) => require("@lydell/node-pty").spawn(file, args, opts);

/** Remove terminal escape sequences so the screen text can be searched. */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>]/g, "");
}

/** claude's folder-trust prompt. Spaces are often replaced by cursor moves, so compare without whitespace. */
export function looksLikeTrustPrompt(text: string): boolean {
  const t = text.replace(/\s+/g, "").toLowerCase();
  return t.includes("itrustthisfolder") || t.includes("quicksafetycheck");
}

/** Backoff for the n-th consecutive quick failure (0-based). */
export function backoffDelay(n: number, steps = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]): number {
  return steps[Math.min(n, steps.length - 1)];
}

export type RunnerOptions = {
  claude: ClaudeCommand;
  shim?: Shim;
  spawn?: PtySpawn;
  backoff?: number[];
  stableAfterMs?: number; // a run longer than this resets the backoff
  mcpLogRoot?: string | null; // null disables plugin log watching
  claudeHome?: string; // tests: where ~/.claude lives
  onChange?: (r: WorkspaceRunner) => void;
  log?: (msg: string) => void;
};

export class WorkspaceRunner {
  state: RunnerState = "stopped";
  detail = ""; // why it is in this state (shown by npm run status)
  plugin: PluginState = "unknown";
  pluginDetail = "";
  startedAt?: number;
  restarts = 0;
  lastExitCode?: number;
  sessionId?: string;
  private pty?: Pty;
  private stopping = false;
  private failures = 0;
  private quickResumeFailures = 0;
  private timer?: NodeJS.Timeout;
  private generation = 0; // events from an older claude process (after a restart) are ignored
  private logTimer?: NodeJS.Timeout;
  private tail: string[] = [];
  private partial = "";

  constructor(public ws: Workspace, private opts: RunnerOptions) {}

  /** claude's process ID. On Windows the pseudo-terminal reports it shortly after start, so read it live. */
  get pid(): number | undefined {
    const p = this.pty?.pid;
    return p ? p : undefined;
  }

  /** Last lines of the terminal (escape codes removed), for diagnostics and /logs. */
  recentOutput(lines = 40): string {
    return [...this.tail, this.partial].filter((l) => l.trim()).slice(-lines).join("\n");
  }

  start(opts: { fresh?: boolean } = {}) {
    clearTimeout(this.timer);
    this.stopping = false;
    let spec: LaunchSpec;
    try {
      spec = buildSpec(this.ws, { fresh: opts.fresh, shim: this.opts.shim, claudeHome: this.opts.claudeHome });
    } catch (e) {
      this.set("failed", `cannot prepare launch: ${e instanceof Error ? e.message : e}`);
      return;
    }
    this.sessionId = spec.sessionId;
    this.tail = [];
    this.partial = "";
    this.plugin = "unknown";
    this.pluginDetail = "";
    const spawn = this.opts.spawn ?? defaultPtySpawn;
    try {
      this.pty = spawn(this.opts.claude.file, [...this.opts.claude.prefixArgs, ...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        cols: 140,
        rows: 45,
        name: "xterm-256color",
      });
    } catch (e) {
      this.set("failed", `cannot start claude: ${e instanceof Error ? e.message : e}`);
      this.scheduleRestart(false);
      return;
    }
    const startedAt = Date.now();
    this.startedAt = startedAt;
    this.set("starting", `${spec.resume ? "resuming" : "new"} session ${spec.sessionId.slice(0, 8)}`);

    const gen = ++this.generation;
    this.pty.onData((d) => gen === this.generation && this.onOutput(d));
    this.pty.onExit(({ exitCode }) => gen === this.generation && this.onExit(exitCode, startedAt, spec.resume));
    this.watchPluginLog(startedAt);
  }

  /** Mark as failed without starting (e.g. the bot token no longer works). */
  markFailed(reason: string) {
    this.stopping = true;
    this.set("failed", reason);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    clearInterval(this.logTimer);
    try {
      this.pty?.kill();
    } catch {}
    this.pty = undefined;
    this.set("stopped");
  }

  /** Restart now; fresh starts a new conversation. */
  restart(opts: { fresh?: boolean } = {}) {
    this.stop();
    this.failures = 0;
    this.start(opts);
  }

  private onOutput(d: string) {
    const text = stripAnsi(d).replace(/\r/g, "\n");
    const parts = (this.partial + text).split("\n");
    this.partial = parts.pop() ?? "";
    this.tail.push(...parts.filter((l) => l.trim()));
    if (this.tail.length > 400) this.tail.splice(0, this.tail.length - 400);
    if (this.state === "starting") this.set("running");
    if (looksLikeTrustPrompt(this.recentOutput(15))) {
      this.set("needs-trust", "claude asks whether to trust this folder — answer once with: npm run launch -- " + this.ws.name);
      this.stopping = true; // a person must answer; do not loop
      try {
        this.pty?.kill();
      } catch {}
    }
  }

  private onExit(code: number, startedAt: number, wasResume: boolean) {
    clearInterval(this.logTimer);
    this.lastExitCode = code;
    this.pty = undefined;
    if (this.stopping) {
      if (this.state !== "needs-trust") this.set("stopped");
      return;
    }
    const ranMs = Date.now() - startedAt;
    if (ranMs > (this.opts.stableAfterMs ?? 10 * 60_000)) this.failures = 0;
    // Resuming a conversation that claude cannot open fails fast every time: fall back to a new one.
    let fresh = false;
    if (wasResume && ranMs < 20_000) {
      this.quickResumeFailures++;
      if (this.quickResumeFailures >= 2) {
        this.opts.log?.(`[${this.ws.name}] resuming session failed twice, starting a new conversation`);
        getSessionId(this.ws, true);
        this.quickResumeFailures = 0;
        fresh = true;
      }
    } else this.quickResumeFailures = 0;
    this.opts.log?.(`[${this.ws.name}] claude exited (code ${code}) after ${Math.round(ranMs / 1000)}s. Last output:\n${this.recentOutput(8)}`);
    this.scheduleRestart(fresh);
  }

  private scheduleRestart(fresh: boolean) {
    const delay = backoffDelay(this.failures++, this.opts.backoff);
    this.set("restarting", `restart in ${Math.round(delay / 1000)}s`);
    this.timer = setTimeout(() => {
      this.restarts++;
      this.start({ fresh });
    }, delay);
  }

  // ---------- plugin connection, from claude's MCP log for this folder ----------

  private mcpLogDir(): string | null {
    const root = this.opts.mcpLogRoot === undefined ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "claude-cli-nodejs", "Cache") : this.opts.mcpLogRoot;
    if (!root) return null;
    const want = path.resolve(this.ws.folder).replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
    try {
      const dir = fs.readdirSync(root).find((d) => d.toLowerCase() === want);
      return dir ? path.join(root, dir, "mcp-logs-plugin-discord-discord") : null;
    } catch {
      return null;
    }
  }

  private watchPluginLog(startedAt: number) {
    clearInterval(this.logTimer);
    if (this.opts.mcpLogRoot === null) return;
    const check = () => {
      const dir = this.mcpLogDir();
      if (!dir || !fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).mtimeMs >= startedAt - 1000);
      for (const f of files) {
        const result = parsePluginLog(fs.readFileSync(f, "utf8"), startedAt);
        if (result && (result.state !== this.plugin || result.detail !== this.pluginDetail)) {
          this.plugin = result.state;
          this.pluginDetail = result.detail;
          this.opts.onChange?.(this);
        }
      }
    };
    this.logTimer = setInterval(check, 5_000);
  }

  private set(state: RunnerState, detail?: string) {
    this.state = state;
    this.detail = detail ?? "";
    if (detail) this.opts.log?.(`[${this.ws.name}] ${state}: ${detail}`);
    this.opts.onChange?.(this);
  }
}

/** Latest plugin connection result in a claude MCP log written after `since`. */
export function parsePluginLog(text: string, since: number): { state: PluginState; detail: string } | null {
  let result: { state: PluginState; detail: string } | null = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let j: { debug?: string; error?: string; timestamp?: string };
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.timestamp && Date.parse(j.timestamp) < since - 1000) continue;
    const msg = j.debug ?? j.error ?? "";
    if (msg.startsWith("Channel notifications registered")) result = { state: "connected", detail: "" };
    else if (j.error && msg.startsWith("Connection failed")) result = { state: "failed", detail: msg.slice(0, 160) };
    else if (j.error && msg.startsWith("Server stderr:")) result = { state: "failed", detail: msg.replace(/\s+/g, " ").slice(0, 160) };
  }
  return result;
}
