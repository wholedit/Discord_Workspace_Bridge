// Workspace registry and per-bot state folders for the official Discord channel plugin.
// Each workspace = one folder + one Discord bot + one channel. The plugin reads its token and
// access rules from DISCORD_STATE_DIR, so every workspace gets its own state folder.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = "discord@claude-plugins-official";

export type Workspace = {
  name: string; // short id used in commands, e.g. "web"
  folder: string; // absolute path of the project folder
  botId: string;
  botName: string;
  guildId: string;
  channelId: string;
  channelName: string;
  userId: string; // the only Discord user allowed to drive this workspace
  permissionMode?: PermissionMode; // missing = auto
};

/**
 * Permission modes we offer (claude --permission-mode). bypassPermissions and dontAsk are left out on purpose:
 * this is remote control of a real PC.
 * - auto: a safety classifier approves low-risk actions; risky ones still ask (approval buttons arrive by DM)
 * - manual: every edit and command asks for approval by DM
 * - acceptEdits: file edits are approved automatically; commands ask
 * - plan: Claude only plans and changes nothing
 */
export const PERMISSION_MODES = ["auto", "manual", "acceptEdits", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
export const modeOf = (ws: Workspace): PermissionMode => ws.permissionMode ?? DEFAULT_PERMISSION_MODE;

/** Accepts a few friendly spellings (case-insensitive). */
export function parsePermissionMode(s: string): PermissionMode | null {
  const k = s.trim().toLowerCase();
  if (k === "auto") return "auto";
  if (k === "manual" || k === "default" || k === "ask") return "manual";
  if (k === "acceptedits" || k === "accept-edits" || k === "edits") return "acceptEdits";
  if (k === "plan") return "plan";
  return null;
}

export function homeDir(): string {
  return process.env.WORKSPACE_BRIDGE_HOME ?? path.join(os.homedir(), ".workspace-bridge");
}
const registryFile = () => path.join(homeDir(), "workspaces.json");
export const stateDir = (name: string) => path.join(homeDir(), "workspaces", name);

export function loadWorkspaces(): Workspace[] {
  try {
    return JSON.parse(fs.readFileSync(registryFile(), "utf8"));
  } catch {
    return [];
  }
}

export function saveWorkspaces(list: Workspace[]) {
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(list, null, 2));
}

const sameFolder = (a: string, b: string) =>
  process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Problems that would make a new workspace collide with existing ones. Empty = OK. */
export function validateWorkspace(ws: Workspace, existing: Workspace[]): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(ws.name)) errors.push("Name must be 1-31 lowercase letters, digits or '-' (e.g. web, api-server).");
  for (const o of existing) {
    if (o.name === ws.name) continue; // replacing itself is fine
    if (o.channelId === ws.channelId) errors.push(`Channel #${ws.channelName} is already used by workspace "${o.name}". One channel can belong to only one workspace.`);
    if (o.botId === ws.botId) errors.push(`This bot is already used by workspace "${o.name}". Create a separate bot for each workspace.`);
    if (sameFolder(o.folder, ws.folder)) errors.push(`Folder is already used by workspace "${o.name}".`);
  }
  if (!path.isAbsolute(ws.folder)) errors.push("Folder must be an absolute path.");
  else if (!fs.existsSync(ws.folder) || !fs.statSync(ws.folder).isDirectory()) errors.push(`Folder does not exist: ${ws.folder}`);
  return errors;
}

/** access.json for the official plugin: only this user, only this channel, no @mention needed. */
export function accessConfig(ws: Workspace) {
  return {
    dmPolicy: "allowlist", // approval buttons arrive by DM; nobody else can DM in
    allowFrom: [ws.userId],
    groups: {
      [ws.channelId]: { requireMention: false, allowFrom: [ws.userId] },
    },
    mentionPatterns: [],
    ackReaction: "👀",
    replyToMode: "first",
    textChunkLimit: 2000,
    chunkMode: "newline",
  };
}

/** Write the plugin's state folder: .env with the bot token and access.json. */
export function writeStateDir(ws: Workspace, token: string) {
  const dir = stateDir(ws.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env"), `DISCORD_BOT_TOKEN=${token}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "access.json"), JSON.stringify(accessConfig(ws), null, 2));
}

export function removeStateDir(name: string) {
  fs.rmSync(stateDir(name), { recursive: true, force: true });
}

export function upsertWorkspace(ws: Workspace) {
  const list = loadWorkspaces().filter((w) => w.name !== ws.name);
  list.push(ws);
  saveWorkspaces(list);
}

/** Claude Code stores a folder's conversations under ~/.claude/projects/<folder with non-alphanumerics replaced by "-">. */
export function claudeProjectDir(folder: string, claudeHome = path.join(os.homedir(), ".claude")): string {
  return path.join(claudeHome, "projects", path.resolve(folder).replace(/[^A-Za-z0-9]/g, "-"));
}

/** True when the folder already has a conversation that `claude --continue` can pick up. */
export function hasPreviousSession(folder: string, claudeHome?: string): boolean {
  try {
    return fs.readdirSync(claudeProjectDir(folder, claudeHome)).some((f) => f.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/** Mask a token for display: keep the first 6 characters only. */
export const maskToken = (t: string) => (t.length > 8 ? t.slice(0, 6) + "…" : "…");
