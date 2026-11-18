// Talking to a running supervisor from outside (npm run stop, npm run trust, the setup page):
// small request files in ~/.workspace-bridge/requests that the supervisor picks up within a few seconds.
// Works the same whether the supervisor runs in a terminal or in the background with no window.

import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../workspaces.js";

export const requestsDir = () => path.join(homeDir(), "requests");
export const lockFile = () => path.join(homeDir(), "supervisor.pid");
export const statusFile = () => path.join(homeDir(), "status.json");
export const logFile = () => path.join(homeDir(), "logs", "supervisor.log");

export type Request = { kind: "stop" } | { kind: "restart"; name: string; fresh?: boolean };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** pid of the running supervisor, or null. */
export function supervisorPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(lockFile(), "utf8"));
    return pid && isAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function readStatus(): { supervisorPid: number; updatedAt: string; workspaces: any[]; awake?: boolean } | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), "utf8"));
  } catch {
    return null;
  }
}

export function sendRequest(r: Request) {
  fs.mkdirSync(requestsDir(), { recursive: true });
  const file = r.kind === "stop" ? "stop" : `${r.fresh ? "new" : "restart"}-${r.name}`;
  fs.writeFileSync(path.join(requestsDir(), file), new Date().toISOString());
}

/** Read and delete pending requests (called by the supervisor). */
export function takeRequests(): Request[] {
  let names: string[];
  try {
    names = fs.readdirSync(requestsDir());
  } catch {
    return [];
  }
  const out: Request[] = [];
  for (const n of names) {
    try {
      fs.rmSync(path.join(requestsDir(), n));
    } catch {
      continue; // someone else took it
    }
    if (n === "stop") out.push({ kind: "stop" });
    const m = n.match(/^(restart|new)-([a-z0-9][a-z0-9-]{0,30})$/);
    if (m) out.push({ kind: "restart", name: m[2], fresh: m[1] === "new" });
  }
  return out;
}

/** Ask the running supervisor to stop and wait until it has. true = stopped (or was not running). */
export async function stopSupervisor(timeoutMs = 30_000): Promise<boolean> {
  const pid = supervisorPid();
  if (!pid) return true;
  sendRequest({ kind: "stop" });
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    if (!isAlive(pid)) return true;
  }
  return false;
}
