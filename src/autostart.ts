// Run the supervisor in the background: now (no window), and automatically when you sign in to Windows.
// Auto-start uses a Task Scheduler task for the current user only (no administrator rights, no stored password).
// It starts at sign-in, not at boot: claude needs your signed-in Windows session.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir } from "./workspaces.js";
import { freshEnv } from "./check.js";
import { logFile, supervisorPid } from "./supervisor/control.js";

export const TASK_NAME = "workspace-bridge";
export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The same command as `npm start` (sub = "start"), or the background starter (sub = "start-bg"). */
export function supervisorCommand(sub: "start" | "start-bg" = "start", nodePath = process.execPath): string[] {
  return [nodePath, "--use-system-ca", "--import", "tsx", path.join("src", "cli.ts"), sub];
}

/** Quote one argument the way Windows programs parse it back. */
export function winQuote(a: string): string {
  if (a.length > 0 && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const c of a) {
    if (c === "\\") {
      bs++;
      continue;
    }
    if (c === '"') {
      out += "\\".repeat(bs * 2 + 1) + '"';
      bs = 0;
      continue;
    }
    out += "\\".repeat(bs) + c;
    bs = 0;
  }
  return out + "\\".repeat(bs * 2) + '"';
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function currentUser(): string {
  const d = process.env.USERDOMAIN;
  const u = process.env.USERNAME ?? os.userInfo().username;
  return d ? `${d}\\${u}` : u;
}

/**
 * Task Scheduler XML: at sign-in of this user, run `start-bg`, which starts the supervisor hidden and exits.
 * (A console window flashes for a second or two at sign-in; that is the starter, not the supervisor.)
 */
export function taskXml(opts: { nodePath?: string; workdir?: string; user?: string } = {}): string {
  const workdir = opts.workdir ?? REPO_DIR;
  const [exe, ...rest] = supervisorCommand("start-bg", opts.nodePath);
  const args = rest.map(winQuote).join(" ");
  const user = xml(opts.user ?? currentUser());
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>workspace-bridge: runs your Discord-connected workspaces in the background after you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(exe)}</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(workdir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function schtasks(args: string[]) {
  const r = spawnSync("schtasks", args, { encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export type AutostartStatus = { supported: boolean; enabled: boolean; sameFolder: boolean; detail: string };

export function autostartStatus(): AutostartStatus {
  if (process.platform !== "win32") return { supported: false, enabled: false, sameFolder: false, detail: "Windows only for now" };
  const r = schtasks(["/Query", "/TN", TASK_NAME, "/XML"]);
  if (!r.ok) return { supported: true, enabled: false, sameFolder: false, detail: "off" };
  const wd = r.out.match(/<WorkingDirectory>([^<]*)<\/WorkingDirectory>/)?.[1] ?? "";
  const sameFolder = path.resolve(wd.replace(/&amp;/g, "&")).toLowerCase() === REPO_DIR.toLowerCase();
  return { supported: true, enabled: true, sameFolder, detail: sameFolder ? "on (at sign-in)" : `on, but for another copy: ${wd}` };
}

export function enableAutostart(): { ok: boolean; detail: string } {
  if (process.platform !== "win32") return { ok: false, detail: "Auto-start is Windows only for now." };
  const file = path.join(homeDir(), "autostart-task.xml");
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(file, "﻿" + taskXml(), "utf16le");
  const r = schtasks(["/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
  fs.rmSync(file, { force: true });
  return r.ok ? { ok: true, detail: "Auto-start is on: the supervisor starts 30 seconds after you sign in to Windows." } : { ok: false, detail: r.out };
}

export function disableAutostart(): { ok: boolean; detail: string } {
  if (process.platform !== "win32") return { ok: false, detail: "Auto-start is Windows only for now." };
  if (!autostartStatus().enabled) return { ok: true, detail: "Auto-start was already off." };
  const r = schtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
  return r.ok ? { ok: true, detail: "Auto-start is off." } : { ok: false, detail: r.out };
}

/** Keep one old log: supervisor.log → supervisor.log.1 once it passes 5 MB. */
export function rotateLog(file = logFile(), maxBytes = 5 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, file + ".1");
  } catch {}
}

/**
 * Start the supervisor now with no window; its output goes to ~/.workspace-bridge/logs/supervisor.log.
 * Plain Node (hidden, detached) on purpose: no extra helper program for security software to flag.
 */
export function startInBackground(): { ok: boolean; detail: string } {
  const pid = supervisorPid();
  if (pid) return { ok: true, detail: `Already running (pid ${pid}).` };
  const log = logFile();
  fs.mkdirSync(path.dirname(log), { recursive: true });
  rotateLog(log);
  fs.appendFileSync(log, `==== ${new Date().toLocaleString()} starting in the background
`);
  const fd = fs.openSync(log, "a");
  const [exe, ...args] = supervisorCommand("start");
  try {
    const child = spawn(exe, args, { cwd: REPO_DIR, detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: freshEnv() });
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
  return { ok: true, detail: `Started in the background. Log: ${log}` };
}

/** Wait until the supervisor has written its lock file (it starts a few seconds after launch). */
export async function waitForSupervisor(timeoutMs = 20_000): Promise<number | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pid = supervisorPid();
    if (pid) return pid;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
