// The supervisor: runs every workspace's claude without windows, restarts them, shows progress in Discord,
// runs the manager bot, keeps the PC awake, and writes status.json (read by `npm run status` and the setup page).
// Changes made while it runs (setup page, npm run add/remove/mode) are picked up within a few seconds.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DiscordApiError, DiscordRest } from "../discordApi.js";
import { ensureBunShim } from "../bunShim.js";
import { awakeExe } from "../winTools.js";
import { homeDir, loadWorkspaces, modeOf, saveWorkspaces, stateDir, type Workspace } from "../workspaces.js";
import { loadManager, readManagerToken } from "../manager/config.js";
import { startManager, type ManagerHandle } from "../manager/bot.js";
import { renderDashboard, type Controller, type WorkspaceInfo } from "../manager/commands.js";
import { getHostInfo } from "../manager/host.js";
import { WorkspaceRunner } from "./runner.js";
import { ProgressReporter, tailEvents } from "./progress.js";
import { eventsFile, resolveClaude, type Shim } from "./spec.js";
import { isAlive, lockFile, readStatus, statusFile, takeRequests } from "./control.js";

export { statusFile };

function readToken(ws: Workspace): string | null {
  try {
    const m = fs.readFileSync(path.join(stateDir(ws.name), ".env"), "utf8").match(/^DISCORD_BOT_TOKEN=(.+)$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function toInfo(r: WorkspaceRunner): WorkspaceInfo {
  return {
    name: r.ws.name,
    channel: r.ws.channelName,
    folder: r.ws.folder,
    state: r.state,
    detail: r.detail,
    plugin: r.plugin,
    mode: modeOf(r.ws),
    pid: r.pid,
    startedAt: r.startedAt,
    restarts: r.restarts,
    sessionId: r.sessionId,
  };
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
  let pid = 0;
  try {
    pid = Number(fs.readFileSync(lockFile(), "utf8"));
  } catch {}
  if (pid && pid !== process.pid && isAlive(pid)) throw new Error(`The supervisor is already running (pid ${pid}). Stop it first with: npm run stop`);
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(lockFile(), String(process.pid));
}

/** Windows: keep the PC from sleeping while we run (the screen may still turn off). WSB_ALLOW_SLEEP=1 turns this off. */
function keepAwake(log: (m: string) => void): ChildProcess | null {
  if (process.platform !== "win32" || process.env.WSB_ALLOW_SLEEP === "1") return null;
  try {
    const child = spawn(awakeExe(), [String(process.pid)], { stdio: "ignore", windowsHide: true });
    child.on("error", (e) => log(`sleep prevention failed: ${e.message}`));
    return child;
  } catch (e) {
    log(`sleep prevention is off: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const sameWorkspace = (a: Workspace, b: Workspace) => a.botId === b.botId && a.channelId === b.channelId && a.folder === b.folder && a.userId === b.userId;

export async function runSupervisor(opts: { only?: string[]; fresh?: string[] } = {}) {
  const wanted = (w: Workspace) => !opts.only?.length || opts.only.includes(w.name);
  const all = loadWorkspaces();
  if (opts.only?.length && !all.some(wanted)) {
    console.log(`No workspace named ${opts.only.join(", ")}.`);
    return;
  }

  takeLock();
  const claude = resolveClaude();
  let shim: Shim | undefined;
  if (process.platform === "win32") shim = ensureBunShim();

  const log = (m: string) => console.log(`${new Date().toLocaleTimeString()} ${m}`);
  const startedAt = Date.now();
  const runners: WorkspaceRunner[] = [];
  const tokens = new Map<string, string | null>();
  const perRunnerCleanup = new Map<WorkspaceRunner, (() => void)[]>();
  const lastPlugin = new Map<string, string>();
  const lastState = new Map<string, string>();
  let stopping = false;
  let lockedDown = false;
  let manager: ManagerHandle | undefined;
  let managerKey = "";
  const cleanups: (() => void)[] = [];
  /** Post to #control if the manager bot is set up. mention = phone notification. */
  const alert = (text: string, mention = false) => void manager?.notify(text, mention);
  const awake = keepAwake(log);
  const isAwake = () => !!awake && awake.exitCode === null && !awake.killed;
  if (awake) log("☕ Sleep prevention on while the supervisor runs (the screen can still turn off).");

  const writeStatus = () => {
    const status = {
      supervisorPid: process.pid,
      updatedAt: new Date().toISOString(),
      awake: isAwake(),
      manager: manager ? "online" : managerKey ? "error" : "not set up",
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

  async function addRunner(ws: Workspace, fresh = false) {
    const runner = new WorkspaceRunner(ws, {
      claude,
      shim,
      log,
      onChange: (r) => {
        writeStatus();
        if (stopping || !runners.includes(r)) return;
        // Alerts for states a person has to look at.
        if (r.state !== lastState.get(ws.name)) {
          const prev = lastState.get(ws.name);
          lastState.set(ws.name, r.state);
          if (r.state === "failed") alert(`🔴 **${ws.name}** failed: ${r.detail}`, true);
          if (r.state === "needs-trust") alert(`🔐 **${ws.name}** needs a one-time folder-trust answer on the PC: \`npm run trust -- ${ws.name}\` (or the setup page)`, true);
          if (r.state === "restarting" && prev === "running" && !lockedDown) alert(`🟠 **${ws.name}** stopped unexpectedly and is restarting (${r.detail}).`);
        }
        // Log the plugin state only when it actually changes (state changes like "stopped" also call onChange).
        const key = `${r.plugin}|${r.pluginDetail}`;
        if (key === lastPlugin.get(ws.name)) return;
        const wasFailed = lastPlugin.get(ws.name)?.startsWith("failed");
        lastPlugin.set(ws.name, key);
        if (r.plugin === "connected") {
          log(`[${ws.name}] 🟢 Discord plugin connected (#${ws.channelName})`);
          if (wasFailed) alert(`🟢 **${ws.name}** bot is back online.`);
        }
        if (r.plugin === "failed") {
          log(`[${ws.name}] 🔴 Discord plugin failed: ${r.pluginDetail}`);
          alert(`🔴 **${ws.name}** Discord plugin failed: ${r.pluginDetail}`, true);
        }
      },
    });
    runners.push(runner);
    const mine: (() => void)[] = [];
    perRunnerCleanup.set(runner, mine);

    const token = readToken(ws);
    tokens.set(ws.name, token);
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
      mine.push(stopTail, () => reporter.close());
    } else log(`[${ws.name}] no bot token found; progress messages are off`);

    log(`[${ws.name}] permission mode: ${modeOf(ws)}`);
    // A reset or deleted token makes the plugin exit right after connecting, and nothing else would tell you.
    const tokenProblem = token ? await checkToken(token) : "no bot token saved";
    if (tokenProblem) {
      runner.markFailed(`${tokenProblem} — re-register the bot with: npm run setup`);
      return;
    }
    if (lockedDown) runner.markFailed("locked down — use /restart to start it");
    else runner.start({ fresh });
  }

  function removeRunner(r: WorkspaceRunner) {
    runners.splice(runners.indexOf(r), 1);
    r.stop();
    for (const c of perRunnerCleanup.get(r) ?? []) c();
    perRunnerCleanup.delete(r);
    lastState.delete(r.ws.name);
    lastPlugin.delete(r.ws.name);
    tokens.delete(r.ws.name);
    writeStatus();
  }

  for (const ws of all.filter(wanted)) await addRunner(ws, opts.fresh?.includes(ws.name));
  writeStatus();
  log(
    runners.length
      ? `Supervisor running ${runners.length} workspace(s). Press Ctrl+C (or npm run stop) to stop all.`
      : "Supervisor running with no workspaces yet. Add one with npm run setup; it starts here automatically.",
  );

  // ---------- manager bot (#control) ----------
  const controller: Controller = {
    list: () => runners.map(toInfo),
    interrupt: (name) => runners.find((r) => r.ws.name === name)?.interrupt() ?? false,
    restart: (name, fresh) => {
      const r = runners.find((x) => x.ws.name === name);
      if (!r) return;
      if (runners.every((x) => x.state === "stopped" || x.state === "failed" || x === r)) lockedDown = false;
      log(`[${name}] ${fresh ? "new conversation" : "restart"} requested`);
      r.restart({ fresh });
    },
    setMode: (name, mode) => {
      const reg = loadWorkspaces();
      const w = reg.find((x) => x.name === name);
      const r = runners.find((x) => x.ws.name === name);
      if (!w || !r) return;
      if (mode === "auto") delete w.permissionMode;
      else w.permissionMode = mode as Workspace["permissionMode"];
      saveWorkspaces(reg);
      r.ws = w; // the watcher now sees no difference, so it won't restart a second time
      log(`[${name}] permission mode → ${mode} (from Discord)`);
      if (!lockedDown && r.state !== "stopped" && r.state !== "failed" && r.state !== "needs-trust") r.restart();
      writeStatus();
    },
    logs: (name, lines) => runners.find((r) => r.ws.name === name)?.recentOutput(lines) ?? "",
    lockdown: () => {
      lockedDown = true;
      const n = runners.filter((r) => r.state !== "stopped").length;
      for (const r of runners) r.stop();
      log(`🔒 LOCKDOWN from Discord: stopped ${n} workspace(s)`);
      return n;
    },
    host: async () => ({ ...(await getHostInfo(startedAt)), ...(process.platform === "win32" ? { awake: isAwake() } : {}) }),
    lockedDown: () => lockedDown,
  };

  /** Start, restart or stop the manager bot to match manager.json (it can be set up while we run). */
  async function syncManager(first: boolean) {
    const mcfg = loadManager();
    const mtoken = readManagerToken();
    const key = mcfg && mtoken ? `${mcfg.botId}|${mcfg.channelId}|${mcfg.ownerId}|${mtoken}` : "";
    if (key === managerKey) return;
    managerKey = key;
    if (manager) {
      await manager.close().catch(() => {});
      manager = undefined;
    }
    if (!key) {
      if (first) log("Manager bot not set up (optional): npm run setup");
      writeStatus();
      return;
    }
    try {
      manager = await startManager(mcfg!, mtoken!, controller, log);
      alert(`🟢 **Supervisor online** on ${os.hostname()}\n${renderDashboard(runners.map(toInfo))}`);
    } catch (e) {
      log(`[manager] could not start: ${e instanceof Error ? e.message : e} (re-register it with: npm run setup)`);
    }
    writeStatus();
  }
  await syncManager(true);

  // Every few seconds: apply changes made while we run and pick up requests (npm run stop / trust, setup page).
  let syncing = false;
  const sync = async () => {
    if (syncing || stopping) return;
    syncing = true;
    try {
      for (const req of takeRequests()) {
        if (req.kind === "stop") {
          log("Stop requested (npm run stop or the setup page).");
          shutdown();
          return;
        }
        controller.restart(req.name, req.fresh);
      }
      const latest = loadWorkspaces().filter(wanted);
      for (const r of [...runners]) {
        if (latest.some((w) => w.name === r.ws.name)) continue;
        log(`[${r.ws.name}] removed from the workspace list; stopping it`);
        alert(`➖ **${r.ws.name}** was removed on the PC.`);
        removeRunner(r);
      }
      for (const w of latest) {
        const r = runners.find((x) => x.ws.name === w.name);
        if (!r) {
          log(`[${w.name}] new workspace (#${w.channelName}); starting it`);
          alert(`➕ **${w.name}** was added on the PC (#${w.channelName}).`);
          await addRunner(w);
          continue;
        }
        if (!sameWorkspace(r.ws, w) || readToken(w) !== tokens.get(w.name)) {
          log(`[${w.name}] settings changed on the PC; restarting it with the new settings`);
          removeRunner(r);
          await new Promise((res) => setTimeout(res, 3000)); // let the old process exit first
          await addRunner(w);
          continue;
        }
        if (modeOf(w) === modeOf(r.ws)) continue;
        r.ws = w;
        writeStatus();
        if (lockedDown || r.state === "needs-trust" || r.state === "failed" || r.state === "stopped") continue; // applies on next start
        log(`[${w.name}] permission mode → ${modeOf(w)}; restarting (conversation continues)`);
        r.restart();
      }
      await syncManager(false);
    } catch (e) {
      log(`watcher error: ${e instanceof Error ? e.message : e}`);
    } finally {
      syncing = false;
    }
  };
  takeRequests(); // ignore requests left over from before we started
  const watcher = setInterval(sync, 3000);
  cleanups.push(() => clearInterval(watcher));

  function shutdown() {
    if (stopping) return;
    stopping = true;
    log('Stopping all workspaces… (wait for "Stopped.")');
    for (const r of runners) r.stop();
    for (const list of perRunnerCleanup.values()) for (const c of list) c();
    for (const c of cleanups) c();
    awake?.kill();
    writeStatus();
    try {
      if (Number(fs.readFileSync(lockFile(), "utf8")) === process.pid) fs.rmSync(lockFile());
    } catch {}
    const finish = () => {
      log("Stopped.");
      process.exit(0);
    };
    if (!manager) return void setTimeout(finish, 500);
    // Tell #control, then leave (give Discord at most 2 s).
    Promise.race([manager.notify("⚪ Supervisor stopped on the PC. Workspaces are offline.").then(() => manager!.close()), new Promise((r) => setTimeout(r, 2000))]).finally(finish);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGBREAK", shutdown); // Windows Ctrl+Break / console close
}

/** For `npm run status`: print what the running supervisor last reported. */
export function printStatus() {
  const s = readStatus();
  if (!s) {
    console.log("No status yet. Start the supervisor with: npm start");
    return;
  }
  const alive = isAlive(s.supervisorPid);
  const awake = alive && s.awake !== undefined ? ` · sleep prevention ${s.awake ? "on" : "off"}` : "";
  console.log(`Supervisor ${alive ? `running (pid ${s.supervisorPid})` : "NOT running"} · updated ${new Date(s.updatedAt).toLocaleString()}${awake}\n`);
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
