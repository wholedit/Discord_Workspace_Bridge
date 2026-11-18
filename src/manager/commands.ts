// Manager bot slash commands: definitions and handlers. No Discord library here, so it is easy to test.

import { PERMISSION_MODES, parsePermissionMode } from "../workspaces.js";

export type WorkspaceInfo = {
  name: string;
  channel: string;
  folder: string;
  state: string;
  detail: string;
  plugin: string;
  mode: string;
  pid?: number;
  startedAt?: number;
  restarts: number;
  sessionId?: string;
};

export type HostInfo = { uptimeSec: number; supervisorUptimeSec: number; cpuPercent: number; memUsedGb: number; memTotalGb: number; diskFreeGb?: number; diskTotalGb?: number; hostname: string };

/** What the manager bot can ask the supervisor to do. */
export interface Controller {
  list(): WorkspaceInfo[];
  interrupt(name: string): boolean; // false when nothing is running
  restart(name: string, fresh?: boolean): void;
  setMode(name: string, mode: string): void;
  logs(name: string, lines: number): string;
  lockdown(): number; // how many were stopped
  host(): Promise<HostInfo> | HostInfo;
  lockedDown(): boolean;
}

const ws = (description = "Workspace") => ({ type: 3, name: "ws", description, required: true, autocomplete: true });

/** Discord application command JSON (type 3 = string, 4 = integer, 5 = boolean). */
export const COMMANDS = [
  { name: "dashboard", description: "All workspaces at a glance" },
  { name: "status", description: "Details of one workspace", options: [ws()] },
  { name: "stop", description: "Stop the task in progress (like pressing Esc). The session keeps running.", options: [ws()] },
  { name: "restart", description: "Restart a workspace (conversation continues). Use 'all' for every workspace.", options: [ws("Workspace, or all")] },
  { name: "new", description: "Restart a workspace with a new, empty conversation", options: [ws()] },
  {
    name: "mode",
    description: "Change the permission mode",
    options: [ws(), { type: 3, name: "mode", description: "Permission mode", required: true, choices: PERMISSION_MODES.map((m) => ({ name: m, value: m })) }],
  },
  { name: "logs", description: "Recent terminal output of a workspace (only you can see it)", options: [ws(), { type: 4, name: "lines", description: "How many lines (10-60)", min_value: 10, max_value: 60 }] },
  { name: "ping", description: "Is the PC alive? Uptime, CPU, memory, disk" },
  {
    name: "lockdown",
    description: "Emergency stop: stop every workspace now. Start again with /restart all.",
    options: [{ type: 5, name: "confirm", description: "Set to True to really stop everything", required: true }],
  },
];

const ICON: Record<string, string> = { running: "🟢", starting: "🟡", restarting: "🟠", "needs-trust": "🔐", stopped: "⚪", failed: "🔴" };

export function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function pluginText(w: WorkspaceInfo): string {
  if (w.state !== "running" && w.state !== "starting") return w.detail || w.state;
  return w.plugin === "connected" ? "bot online" : w.plugin === "failed" ? "plugin failed" : "connecting…";
}

export function renderDashboard(list: WorkspaceInfo[], now = Date.now(), lockedDown = false): string {
  if (!list.length) return "No workspaces. Add one on the PC with `npm run add`.";
  const running = list.filter((w) => w.state === "running").length;
  const lines = list.map((w) => {
    const up = w.state === "running" && w.startedAt ? ` · up ${duration((now - w.startedAt) / 1000)}` : "";
    const restarts = w.restarts ? ` · restarts ${w.restarts}` : "";
    return `${ICON[w.state] ?? "❔"} **${w.name}** · ${w.mode} · ${pluginText(w)}${up}${restarts}`;
  });
  return [`**Workspaces** · ${running}/${list.length} running${lockedDown ? " · 🔒 locked down" : ""}`, ...lines].join("\n");
}

export function renderStatus(w: WorkspaceInfo, now = Date.now()): string {
  return [
    `${ICON[w.state] ?? "❔"} **${w.name}** — ${w.state}${w.detail ? ` (${w.detail})` : ""}`,
    `channel: #${w.channel}`,
    `folder: \`${w.folder}\``,
    `permission mode: ${w.mode}`,
    `Discord plugin: ${w.plugin}`,
    `session: ${w.sessionId ? "`" + w.sessionId.slice(0, 8) + "`" : "—"}`,
    `process: ${w.pid ?? "—"}${w.state === "running" && w.startedAt ? ` · up ${duration((now - w.startedAt) / 1000)}` : ""} · restarts ${w.restarts}`,
  ].join("\n");
}

export function renderHost(h: HostInfo): string {
  const disk = h.diskTotalGb ? `\n💽 disk free ${h.diskFreeGb!.toFixed(0)} / ${h.diskTotalGb.toFixed(0)} GB` : "";
  return `🏓 **${h.hostname}** is online\n⏱️ PC up ${duration(h.uptimeSec)} · supervisor up ${duration(h.supervisorUptimeSec)}\n🧠 CPU ${h.cpuPercent.toFixed(0)}% · memory ${h.memUsedGb.toFixed(1)} / ${h.memTotalGb.toFixed(1)} GB${disk}`;
}

/** Choices for the ws option, filtered by what the user typed. */
export function autocompleteChoices(c: Controller, typed: string, includeAll: boolean): { name: string; value: string }[] {
  const names = [...(includeAll ? ["all"] : []), ...c.list().map((w) => w.name)];
  return names.filter((n) => n.toLowerCase().includes(typed.toLowerCase())).slice(0, 25).map((n) => ({ name: n, value: n }));
}

/** Run a command and return the reply text. Throws nothing; problems come back as text. */
export async function runCommand(cmd: string, opts: Record<string, string | number | boolean | undefined>, c: Controller): Promise<string> {
  const list = c.list();
  const name = typeof opts.ws === "string" ? opts.ws : "";
  const find = () => list.find((w) => w.name === name);
  const unknown = `No workspace named \`${name}\`. Workspaces: ${list.map((w) => w.name).join(", ") || "none"}`;

  switch (cmd) {
    case "dashboard":
      return renderDashboard(list, Date.now(), c.lockedDown());
    case "status": {
      const w = find();
      return w ? renderStatus(w) : unknown;
    }
    case "stop": {
      const w = find();
      if (!w) return unknown;
      return c.interrupt(name) ? `⏹️ Sent stop to **${name}**. The current task is interrupted; the session keeps running.` : `**${name}** is not running (${w.state}).`;
    }
    case "restart":
    case "new": {
      const fresh = cmd === "new";
      if (name === "all" && !fresh) {
        for (const w of list) c.restart(w.name);
        return `🔄 Restarting all ${list.length} workspace(s). Conversations continue.${c.lockedDown() ? " Lockdown lifted." : ""}`;
      }
      if (!find()) return unknown;
      c.restart(name, fresh);
      return fresh ? `🆕 **${name}** restarts with a new, empty conversation.` : `🔄 Restarting **${name}**. The conversation continues.`;
    }
    case "mode": {
      if (!find()) return unknown;
      const mode = parsePermissionMode(String(opts.mode ?? ""));
      if (!mode) return `Unknown mode. Choose: ${PERMISSION_MODES.join(", ")}`;
      if (find()!.mode === mode) return `**${name}** is already in ${mode} mode.`;
      c.setMode(name, mode);
      return `🔐 **${name}** → ${mode}. Restarting it to apply; the conversation continues, a task in progress is interrupted.`;
    }
    case "logs": {
      if (!find()) return unknown;
      const n = Math.min(60, Math.max(10, Number(opts.lines ?? 25)));
      const text = c.logs(name, n).replace(/```/g, "ˋˋˋ");
      const clipped = text.length > 1800 ? "…" + text.slice(-1800) : text;
      return `**${name}** — last ${n} lines\n\`\`\`\n${clipped || "(no output yet)"}\n\`\`\``;
    }
    case "ping":
      return renderHost(await c.host());
    case "lockdown": {
      if (opts.confirm !== true) return "Not stopped. Run `/lockdown confirm:True` to stop every workspace.";
      const n = c.lockdown();
      return `🔒 Lockdown: stopped ${n} workspace(s). Nothing restarts until you run \`/restart all\`.`;
    }
    default:
      return `Unknown command: ${cmd}`;
  }
}
