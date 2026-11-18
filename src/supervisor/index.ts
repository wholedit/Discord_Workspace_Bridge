// The supervisor: runs every workspace's claude without windows, restarts them, shows progress in Discord,
// and writes status.json (read by `npm run status` now and by the manager bot in M2).

import fs from "node:fs";
import path from "node:path";
import { DiscordApiError, DiscordRest } from "../discordApi.js";
import { ensureBunShim } from "../bunShim.js";
import { homeDir, loadWorkspaces, modeOf, stateDir, type Workspace } from "../workspaces.js";
import { WorkspaceRunner } from "./runner.js";
import { ProgressReporter, tailEvents } from "./progress.js";
import { eventsFile, resolveClaude, type Shim } from "./spec.js";

export const statusFile = () => path.join(homeDir(), "status.json");
const lockFile = () => path.join(homeDir(), "supervisor.pid");

function readToken(ws: Workspace): string | null {
  try {
    const m = fs.readFileSync(path.join(stateDir(ws.name), ".env"), "utf8").match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** null when the token works; otherwise a short reason. Network errors don't block the start. */
async function checkToken(token: string): Promise<string | null> {
  try {
    await new DiscordRest(token).me();
    return null;
  } catch (e) {
    return e instanceof DiscordApiError && e.status === 401 ? "bot token is no longer valid (was it reset?)" : null;
  }
}

/** Refuse to run twice: two supervisors would start every workspace twice. */
function takeLock() {
  try {
    const pid = Number(fs.readFileSync(lockFile(), "utf8"));
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        throw new Error(`The supervisor is already running (pid ${pid}). Stop it first, or delete ${lockFile()} if that process is gone.`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH" && (e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        if ((e as NodeJS.ErrnoException).code === "EPERM") throw new Error(`The supervisor is already running (pid ${pid}).`);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(lockFile(), String(process.pid));
}

export async function runSupervisor(opts: { only?: string[]; fresh?: string[] } = {}) {
  const all = loadWorkspaces();
  const list = opts.only?.length ? all.filter((w) => opts.only!.includes(w.name)) : all;
  if (!list.length) {
    console.log(all.length ? `No workspace named ${opts.only!.join(", ")}.` : "No workspaces yet. Add one with: npm run add");
    return;
  }

  takeLock();
  const claude = resolveClaude();
  let shim: Shim | undefined;
  if (process.platform === "win32") shim = ensureBunShim();

  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  const runners: WorkspaceRunner[] = [];
  const lastPlugin = new Map<string, string>();
  let stopping = false;
  const cleanups: (() => void)[] = [];

  const writeStatus = () => {
    const status = {
      supervisorPid: process.pid,
      updatedAt: new Date().toISOString(),
      workspaces: runners.map((r) => ({
        name: r.ws.name,
        channel: r.ws.channelName,
        folder: r.ws.folder,
        state: r.state,
        detail: r.detail,
        mode: modeOf(r.ws),
        plugin: r.plugin,
        pluginDetail: r.pluginDetail,
        pid: r.pid ?? null,
        startedAt: r.startedAt ? new Date(r.startedAt).toISOString() : null,
        restarts: r.restarts,
        sessionId: r.sessionId ?? null,
      })),
    };
    try {
      fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
    } catch {}
  };

  for (const ws of list) {
    const runner = new WorkspaceRunner(ws, {
      claude,
      shim,
      log,
      onChange: (r) => {
        writeStatus();
        // Log the plugin state only when it actually changes (state changes like "stopped" also call onChange).
        const key = `${r.plugin}|${r.pluginDetail}`;
        if (key === lastPlugin.get(ws.name)) return;
        lastPlugin.set(ws.name, key);
        if (stopping) return;
        if (r.plugin === "connected") log(`[${ws.name}] 🟢 Discord plugin connected (#${ws.channelName})`);
        if (r.plugin === "failed") log(`[${ws.name}] 🔴 Discord plugin failed: ${r.pluginDetail}`);
      },
    });
    runners.push(runner);

    const token = readToken(ws);
    if (token) {
      const rest = new DiscordRest(token);
      const reporter = new ProgressReporter(
        {
          send: async (c) => (await rest.sendMessage(ws.channelId, c)).id,
          edit: async (id, c) => void (await rest.editMessage(ws.channelId, id, c)),
        },
        { baseFolder: ws.folder, onError: (e) => log(`[${ws.name}] progress message failed: ${e instanceof Error ? e.message : e}`) },
      );
      fs.writeFileSync(eventsFile(ws), ""); // start each run with an empty event log
      const stopTail = tailEvents(eventsFile(ws), (ev) => reporter.handle(ev));
      cleanups.push(stopTail, () => reporter.close());
    } else log(`[${ws.name}] no bot token found; progress messages are off`);

    // A reset or deleted token makes the plugin exit right after connecting, and nothing else would tell you.
    const tokenProblem = token ? await checkToken(token) : "no bot token saved";
    if (tokenProblem) {
      runner.markFailed(`${tokenProblem} — re-register the bot with: npm run add`);
      continue;
    }
    runner.start({ fresh: opts.fresh?.includes(ws.name) });
  }

  // Apply permission-mode changes made with `npm run mode` while we run: restart just that workspace.
  const watchModes = setInterval(() => {
    for (const latest of loadWorkspaces()) {
      const r = runners.find((x) => x.ws.name === latest.name);
      if (!r || modeOf(latest) === modeOf(r.ws)) continue;
      r.ws = latest;
      writeStatus();
      if (r.state === "needs-trust" || r.state === "failed" || r.state === "stopped") continue; // applies on next start
      log(`[${latest.name}] permission mode → ${modeOf(latest)}; restarting (conversation continues)`);
      r.restart();
    }
  }, 3000);
  cleanups.push(() => clearInterval(watchModes));

  writeStatus();
  for (const r of runners) log(`[${r.ws.name}] permission mode: ${modeOf(r.ws)}`);
  log(`Supervisor running ${runners.length} workspace(s). Press Ctrl+C to stop all.`);

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("Stopping all workspaces… (wait for \"Stopped.\")");
    for (const r of runners) r.stop();
    for (const c of cleanups) c();
    writeStatus();
    try {
      fs.rmSync(lockFile());
    } catch {}
    setTimeout(() => {
      log("Stopped.");
      process.exit(0);
    }, 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGBREAK", shutdown); // Windows Ctrl+Break / console close
}

/** For `npm run status`: print what the running supervisor last reported. */
export function printStatus() {
  let s: { supervisorPid: number; updatedAt: string; workspaces: any[] };
  try {
    s = JSON.parse(fs.readFileSync(statusFile(), "utf8"));
  } catch {
    console.log("No status yet. Start the supervisor with: npm start");
    return;
  }
  let alive = false;
  try {
    process.kill(s.supervisorPid, 0);
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  console.log(`Supervisor ${alive ? `running (pid ${s.supervisorPid})` : "NOT running"} · updated ${new Date(s.updatedAt).toLocaleString()}\n`);
  const icon: Record<string, string> = { running: "🟢", starting: "🟡", restarting: "🟠", "needs-trust": "🔐", stopped: "⚪", failed: "🔴" };
  for (const w of s.workspaces) {
    const plugin =
      w.state === "failed" || w.state === "needs-trust" || w.state === "restarting"
        ? w.detail
        : w.plugin === "connected"
          ? "bot online"
          : w.plugin === "failed"
            ? `plugin failed: ${w.pluginDetail}`
            : "plugin starting…";
    const pid = w.pid ? `pid ${w.pid}` : "";
    console.log(`${icon[w.state] ?? "?"} ${w.name.padEnd(14)} ${w.state.padEnd(11)} #${String(w.channel).padEnd(14)} ${pid.padEnd(10)} ${String(w.mode ?? "auto").padEnd(11)} ${plugin}  restarts ${w.restarts}`);
  }
}
