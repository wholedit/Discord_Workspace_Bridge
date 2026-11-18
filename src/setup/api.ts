// Setup page actions. Same steps as `npm run add` / `npm run add-manager`, but driven from the browser.
// Bot tokens stay on the server side: the page gets a draft id back and never sees the token again.
// No Discord library and no HTTP here, so it can be tested with a fake fetch.

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DiscordApiError,
  DiscordRest,
  MANAGER_PERMISSIONS,
  botSettingsUrl,
  cleanToken,
  hasMessageContentIntent,
  inviteUrl,
  textChannels,
  type FetchLike,
} from "../discordApi.js";
import {
  PERMISSION_MODES,
  loadWorkspaces,
  modeOf,
  parsePermissionMode,
  upsertWorkspace,
  validateWorkspace,
  writeStateDir,
  type Workspace,
} from "../workspaces.js";
import { removeWorkspace } from "../remove.js";
import { loadManager, removeManager, saveManager } from "../manager/config.js";

export type Kind = "workspace" | "manager";
type Draft = { kind: Kind; token: string; bot: { id: string; username: string }; rest: DiscordRest };

export class SetupError extends Error {}

export type Deps = { fetch?: FetchLike };

const USER_ID = /^\d{15,22}$/;

export class SetupApi {
  private drafts = new Map<string, Draft>();
  constructor(private deps: Deps = {}) {}

  private draft(id: unknown): Draft {
    const d = typeof id === "string" ? this.drafts.get(id) : undefined;
    if (!d) throw new SetupError("This step expired. Paste the bot token again.");
    return d;
  }

  /** Step 2: check the token and remember it under a draft id. */
  async token(kind: Kind, raw: string) {
    const token = cleanToken(String(raw ?? ""));
    if (!token) throw new SetupError("Paste the bot token.");
    const rest = new DiscordRest(token, this.deps.fetch);
    const bot = await rest.me();
    const ws = loadWorkspaces();
    const mgr = loadManager();
    let note = "";
    if (kind === "manager") {
      const used = ws.find((w) => w.botId === bot.id);
      if (used) throw new SetupError(`${bot.username} is already the bot of workspace "${used.name}". Create a separate bot for management.`);
      if (mgr?.botId === bot.id) note = "This is your current manager bot. Saving replaces its settings.";
    } else {
      if (mgr?.botId === bot.id) throw new SetupError(`${bot.username} is your manager bot. Create a separate bot for each workspace.`);
      const used = ws.find((w) => w.botId === bot.id);
      if (used) note = `This bot already belongs to workspace "${used.name}". Saving replaces that workspace's settings.`;
    }
    const id = randomUUID();
    this.drafts.set(id, { kind, token, bot, rest });
    return { draft: id, bot: { id: bot.id, name: bot.username }, note, existing: ws.find((w) => w.botId === bot.id)?.name ?? null };
  }

  /** Step 3: Message Content Intent (workspace bots only) and Public Bot. */
  async botSettings(draftId: unknown) {
    const d = this.draft(draftId);
    const app = await d.rest.application();
    return {
      intent: d.kind === "manager" ? true : hasMessageContentIntent(app.flags),
      intentNeeded: d.kind === "workspace",
      public: !!app.bot_public,
      settingsUrl: botSettingsUrl(app.id),
    };
  }

  /** Step 4: which servers the bot is in, plus the invite link. The page polls this until the bot has joined. */
  async guilds(draftId: unknown) {
    const d = this.draft(draftId);
    const guilds = await d.rest.guilds();
    const preferred = loadWorkspaces()[0]?.guildId ?? loadManager()?.guildId;
    const invite =
      d.kind === "manager"
        ? inviteUrl(d.bot.id, undefined, { permissions: MANAGER_PERMISSIONS, scopes: ["bot", "applications.commands"] })
        : inviteUrl(d.bot.id);
    return { guilds: guilds.map((g) => ({ id: g.id, name: g.name })), preferred: guilds.some((g) => g.id === preferred) ? preferred : null, invite };
  }

  /** Step 5 and 7: text channels (with the ones already taken marked) and who should own the workspace. */
  async channels(draftId: unknown, guildId: unknown) {
    const d = this.draft(draftId);
    if (typeof guildId !== "string") throw new SetupError("Pick a server.");
    const [all, guild] = await Promise.all([d.rest.channels(guildId), d.rest.guild(guildId)]);
    const ws = loadWorkspaces();
    const mgr = loadManager();
    const takenBy = (id: string): string | null => {
      const w = ws.find((x) => x.channelId === id && x.botId !== d.bot.id);
      if (w) return `workspace ${w.name}`;
      if (mgr && mgr.channelId === id && mgr.botId !== d.bot.id) return "manager bot";
      return null;
    };
    const channels = textChannels(all).map((c) => ({ id: c.id, name: c.name, takenBy: takenBy(c.id) }));
    this.rememberChannels(channels);
    const ownerId = ws[0]?.userId ?? mgr?.ownerId ?? guild.owner_id;
    const owner = await d.rest.user(ownerId).catch(() => null);
    const current = ws.find((w) => w.botId === d.bot.id);
    const suggestedChannel =
      (d.kind === "workspace" ? current?.channelId : mgr?.botId === d.bot.id ? mgr.channelId : undefined) ??
      channels.find((c) => !c.takenBy && (d.kind === "manager" ? /control|manage|admin/i.test(c.name) : true))?.id ??
      null;
    return {
      channels,
      suggestedChannel,
      owner: { id: ownerId, name: owner ? owner.global_name || owner.username : ownerId },
      current: current ? { name: current.name, folder: current.folder, mode: modeOf(current) } : null,
    };
  }

  /** Step 6: is this a usable workspace folder? */
  checkFolder(raw: unknown, forName?: string) {
    const folder = typeof raw === "string" && raw.trim() ? path.resolve(raw.trim().replace(/^"|"$/g, "")) : "";
    if (!folder) return { ok: false, folder, error: "Enter a folder path." };
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return { ok: false, folder, error: "That folder does not exist." };
    const other = loadWorkspaces().find((w) => w.name !== forName && path.resolve(w.folder).toLowerCase() === folder.toLowerCase());
    if (other) return { ok: false, folder, error: `Workspace "${other.name}" already uses this folder.` };
    return { ok: true, folder, error: "" };
  }

  /** Step 8: save the workspace (state folder with token + access rules, registry entry). */
  saveWorkspace(b: { draft?: unknown; guildId?: unknown; channelId?: unknown; folder?: unknown; userId?: unknown; name?: unknown; mode?: unknown }) {
    const d = this.draft(b.draft);
    if (d.kind !== "workspace") throw new SetupError("This token was entered for the manager bot.");
    const channel = this.channelName(b.channelId);
    const userId = String(b.userId ?? "").trim();
    if (!USER_ID.test(userId)) throw new SetupError("The Discord user ID should be 15-22 digits.");
    const mode = parsePermissionMode(String(b.mode ?? "auto"));
    if (!mode) throw new SetupError(`Permission mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
    const name = String(b.name ?? "").trim().toLowerCase();
    const ws: Workspace = {
      name,
      folder: path.resolve(String(b.folder ?? "")),
      botId: d.bot.id,
      botName: d.bot.username,
      guildId: String(b.guildId ?? ""),
      channelId: String(b.channelId ?? ""),
      channelName: channel,
      userId,
      ...(mode !== "auto" ? { permissionMode: mode } : {}),
    };
    const existing = loadWorkspaces();
    const mgr = loadManager();
    const errors = validateWorkspace(ws, existing.filter((w) => w.botId !== d.bot.id || w.name === name));
    if (mgr?.channelId === ws.channelId) errors.push(`#${channel} is the manager bot's channel. Pick another channel.`);
    if (errors.length) return { ok: false, errors };
    writeStateDir(ws, d.token);
    for (const old of existing.filter((w) => w.botId === d.bot.id && w.name !== name)) removeWorkspace(old.name, { quiet: true });
    upsertWorkspace(ws);
    this.drafts.delete(String(b.draft));
    return { ok: true, errors: [], workspace: { name: ws.name, channelName: ws.channelName, folder: ws.folder, mode } };
  }

  saveManager(b: { draft?: unknown; guildId?: unknown; channelId?: unknown; ownerId?: unknown }) {
    const d = this.draft(b.draft);
    if (d.kind !== "manager") throw new SetupError("This token was entered for a workspace bot.");
    const channelId = String(b.channelId ?? "");
    const channelName = this.channelName(b.channelId);
    const ownerId = String(b.ownerId ?? "").trim();
    if (!USER_ID.test(ownerId)) throw new SetupError("The Discord user ID should be 15-22 digits.");
    const used = loadWorkspaces().find((w) => w.channelId === channelId);
    if (used) return { ok: false, errors: [`#${channelName} belongs to workspace "${used.name}". Use a separate channel such as #control.`] };
    saveManager({ botId: d.bot.id, botName: d.bot.username, guildId: String(b.guildId ?? ""), channelId, channelName, ownerId }, d.token);
    this.drafts.delete(String(b.draft));
    return { ok: true, errors: [] };
  }

  removeWorkspace(name: unknown) {
    if (typeof name !== "string" || !removeWorkspace(name, { quiet: true })) throw new SetupError(`No workspace named "${name}".`);
    return { ok: true };
  }

  removeManager() {
    removeManager();
    return { ok: true };
  }

  /** Channel names come from the last channel listing, so the page can't make one up. */
  private lastChannels = new Map<string, string>();
  rememberChannels(list: { id: string; name: string }[]) {
    for (const c of list) this.lastChannels.set(c.id, c.name);
  }
  private channelName(id: unknown): string {
    const n = typeof id === "string" ? this.lastChannels.get(id) : undefined;
    if (!n) throw new SetupError("Pick a channel from the list.");
    return n;
  }

  /** Called when the page is closed: forget every pasted token. */
  clear() {
    this.drafts.clear();
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof SetupError || e instanceof DiscordApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
