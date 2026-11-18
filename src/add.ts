// Interactive "add a workspace" flow. This is the logic the M3 setup web page will reuse;
// in M0 it runs in the terminal so we can verify every step against the real Discord API.

import fs from "node:fs";
import path from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DiscordRest, DiscordApiError, botSettingsUrl, cleanToken, hasMessageContentIntent, inviteUrl, textChannels } from "./discordApi.js";
import { loadWorkspaces, upsertWorkspace, validateWorkspace, writeStateDir, type Workspace } from "./workspaces.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask without echoing what is typed or pasted (for the bot token). */
export async function askSecret(rl: Interface, q: string): Promise<string> {
  const r = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = r._writeToOutput;
  let muted = false;
  r._writeToOutput = (s: string) => {
    if (!muted) stdout.write(s);
  };
  const answer = rl.question(q); // prompt is written synchronously, before muting
  muted = true;
  try {
    return (await answer).trim();
  } finally {
    muted = false;
    r._writeToOutput = original;
    stdout.write("\n");
  }
}

export async function addWorkspace() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();
  const existing = loadWorkspaces();

  try {
    console.log("\n=== Add a workspace (one folder = one Discord bot = one channel) ===\n");
    console.log("1) Create a bot: https://discord.com/developers/applications → New Application → Bot → Reset Token → copy.\n");

    // --- token
    let rest: DiscordRest;
    let token: string;
    let bot: { id: string; username: string };
    for (;;) {
      token = cleanToken(await askSecret(rl, "Paste the bot token (input is hidden): "));
      if (!token) continue;
      console.log(`  received ${token.length} characters`);
      rest = new DiscordRest(token);
      try {
        bot = await rest.me();
        break;
      } catch (e) {
        console.log(`  ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`  ✓ Bot: ${bot.username}`);
    const used = existing.find((w) => w.botId === bot.id);
    if (used) console.log(`  ! This bot is already used by workspace "${used.name}". Continuing will replace that workspace's settings.`);

    // --- intent + public bot
    for (;;) {
      const app = await rest.application();
      const intentOk = hasMessageContentIntent(app.flags);
      console.log(`  ${intentOk ? "✓" : "✗"} Message Content Intent ${intentOk ? "on" : "OFF"}`);
      if (app.bot_public) console.log("  ! Public Bot is ON — anyone with the link could add your bot to their server. Turn it off (recommended).");
      if (intentOk && !app.bot_public) break;
      console.log(`    Fix it here: ${botSettingsUrl(app.id)}`);
      console.log("    (Bot page → Privileged Gateway Intents → MESSAGE CONTENT INTENT on, PUBLIC BOT off → Save Changes)");
      const a = await ask("    Press Enter to check again, or type 'skip' to continue anyway: ");
      if (a === "skip" && intentOk) break;
      if (a === "skip") console.log("    Message Content Intent is required — the bot cannot read messages without it.");
    }

    // --- invite + guild
    let guilds = await rest.guilds();
    if (guilds.length === 0) {
      console.log(`\n2) Invite the bot to your server (pick your private server):\n   ${inviteUrl(bot.id)}\n`);
      process.stdout.write("   Waiting for the bot to join");
      for (let i = 0; i < 200 && guilds.length === 0; i++) {
        await sleep(3000);
        process.stdout.write(".");
        guilds = await rest.guilds();
      }
      console.log();
      if (guilds.length === 0) throw new Error("The bot did not join a server in 10 minutes. Run `npm run add` again after inviting it.");
    }
    let guild = guilds[0];
    if (guilds.length > 1) {
      guilds.forEach((g, i) => console.log(`   ${i + 1}. ${g.name}`));
      guild = guilds[Number(await ask("   Which server? number: ")) - 1] ?? guilds[0];
    }
    console.log(`  ✓ Server: ${guild.name}`);

    // --- channel
    const chans = textChannels(await rest.channels(guild.id));
    if (chans.length === 0) throw new Error("No text channels found. Create one (e.g. #web) and run again.");
    console.log("\n3) Which channel should this workspace use?");
    chans.forEach((c, i) => console.log(`   ${String(i + 1).padStart(2)}. #${c.name}${existing.some((w) => w.channelId === c.id) ? "  (in use)" : ""}`));
    let channel = chans[0];
    for (;;) {
      const c = chans[Number(await ask("   number: ")) - 1];
      if (c) {
        channel = c;
        break;
      }
    }

    // --- folder
    let folder = "";
    for (;;) {
      folder = path.resolve(await ask("\n4) Workspace folder (absolute path): "));
      if (fs.existsSync(folder) && fs.statSync(folder).isDirectory()) break;
      console.log("   ✗ That folder does not exist.");
    }

    // --- user
    const g = await rest.guild(guild.id);
    const owner = await rest.user(g.owner_id).catch(() => null);
    let userId = g.owner_id;
    const ownerName = owner ? owner.global_name || owner.username : g.owner_id;
    const ans = await ask(`\n5) Only one Discord account can drive this workspace. Use the server owner "${ownerName}"? [Y/n or paste a user ID]: `);
    if (/^\d{15,22}$/.test(ans)) userId = ans;
    else if (/^n/i.test(ans)) userId = await ask("   Your Discord user ID: ");

    // --- name
    const suggested = channel.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 31) || "workspace";
    const name = (await ask(`\n6) Short name for this workspace [${suggested}]: `)) || suggested;

    const ws: Workspace = { name, folder, botId: bot.id, botName: bot.username, guildId: guild.id, channelId: channel.id, channelName: channel.name, userId };
    const errors = validateWorkspace(ws, existing.filter((w) => w.botId !== bot.id || w.name === name));
    if (errors.length) {
      errors.forEach((e) => console.log(`  ✗ ${e}`));
      throw new Error("Workspace not saved.");
    }

    writeStateDir(ws, token);
    // If this bot was used by a differently named workspace, drop the old entry.
    for (const old of existing.filter((w) => w.botId === bot.id && w.name !== name)) {
      const { removeWorkspace } = await import("./remove.js");
      removeWorkspace(old.name, { quiet: true });
    }
    upsertWorkspace(ws);
    console.log(`\n✓ Saved workspace "${name}": #${channel.name} → ${folder}`);
    console.log("  Start it with: npm run launch");
  } catch (e) {
    if (e instanceof DiscordApiError) console.log(`\n✗ Discord API error: ${e.message}`);
    else console.log(`\n✗ ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
