// Minimal Discord REST helpers used by setup: token check, intent check, invite link, guild/channel listing.
// Uses only the bot's own token. Nothing here talks to Claude.

const API = "https://discord.com/api/v10";

/** Application flags (https://discord.com/developers/docs/resources/application#application-object-application-flags) */
export const FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
export const FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

/**
 * Permissions the official Discord channel plugin asks for:
 * View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Add Reactions.
 */
export const PLUGIN_PERMISSIONS =
  (1n << 10n) | // VIEW_CHANNEL
  (1n << 11n) | // SEND_MESSAGES
  (1n << 38n) | // SEND_MESSAGES_IN_THREADS
  (1n << 16n) | // READ_MESSAGE_HISTORY
  (1n << 15n) | // ATTACH_FILES
  (1n << 6n); // ADD_REACTIONS

export class DiscordApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export class DiscordRest {
  constructor(private token: string, private fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  async get<T = any>(path: string): Promise<T> {
    let res;
    try {
      res = await this.fetchImpl(API + path, {
        headers: { Authorization: `Bot ${this.token}`, "User-Agent": "DiscordBot (workspace-bridge, 0.1)" },
      });
    } catch (e) {
      throw new DiscordApiError(0, networkErrorMessage(e));
    }
    if (res.status === 401) throw new DiscordApiError(401, "The bot token is not valid. Copy it again from Bot > Reset Token.");
    if (!res.ok) throw new DiscordApiError(res.status, `Discord API ${path} failed with HTTP ${res.status}`);
    return res.json();
  }

  me() {
    return this.get<{ id: string; username: string; bot?: boolean }>("/users/@me");
  }
  application() {
    return this.get<{ id: string; name: string; flags?: number; bot_public?: boolean; owner?: { id: string } }>("/applications/@me");
  }
  guilds() {
    return this.get<{ id: string; name: string; owner?: boolean }[]>("/users/@me/guilds");
  }
  guild(id: string) {
    return this.get<{ id: string; name: string; owner_id: string }>(`/guilds/${id}`);
  }
  channels(guildId: string) {
    return this.get<{ id: string; name: string; type: number; parent_id?: string | null; position: number }[]>(`/guilds/${guildId}/channels`);
  }
  user(id: string) {
    return this.get<{ id: string; username: string; global_name?: string | null }>(`/users/${id}`);
  }
}

const CERT_ERRORS = ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"];

/** Turn fetch's vague "fetch failed" into something a user can act on. */
export function networkErrorMessage(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  if (CERT_ERRORS.includes(code))
    return `Cannot verify Discord's HTTPS certificate (${code}). Your network or security software inspects HTTPS. Run this program through the npm scripts (they trust the Windows certificate store), or set NODE_USE_SYSTEM_CA=1.`;
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return `Cannot resolve discord.com (${code}). Check the internet connection.`;
  if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code))
    return `Cannot connect to Discord (${code}). Check the internet connection, proxy or firewall.`;
  return `Network error talking to Discord: ${code || cause?.message || (e instanceof Error ? e.message : String(e))}`;
}

/** Quick reachability check used by `check`. */
export async function pingDiscord(fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await fetchImpl(API + "/gateway", { headers: {} });
    return { ok: r.ok, detail: r.ok ? "reachable" : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, detail: networkErrorMessage(e) };
  }
}

export function hasMessageContentIntent(flags: number | undefined): boolean {
  const f = flags ?? 0;
  return (f & FLAG_GATEWAY_MESSAGE_CONTENT) !== 0 || (f & FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED) !== 0;
}

export function inviteUrl(applicationId: string, guildId?: string): string {
  const q = new URLSearchParams({ client_id: applicationId, scope: "bot", permissions: PLUGIN_PERMISSIONS.toString() });
  if (guildId) {
    q.set("guild_id", guildId);
    q.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${q}`;
}

export function botSettingsUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${applicationId}/bot`;
}

/** Text channels only (type 0), sorted the way Discord shows them. */
export function textChannels(all: { id: string; name: string; type: number; position: number }[]) {
  return all.filter((c) => c.type === 0).sort((a, b) => a.position - b.position);
}

/** Pull the token out of whatever the user pasted (stray quotes, "DISCORD_BOT_TOKEN=", spaces). */
export function cleanToken(raw: string): string {
  const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "").trim();
  return unquote(unquote(raw).replace(/^DISCORD_BOT_TOKEN=/, ""));
}
