// npm run add-manager — register the manager bot (#control channel, slash commands, alerts).
// Same flow as `npm run add`, but the manager bot needs no Message Content Intent and no workspace folder.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { askSecret, sleep } from "../add.js";
import { DiscordApiError, DiscordRest, MANAGER_PERMISSIONS, botSettingsUrl, cleanToken, inviteUrl, textChannels } from "../discordApi.js";
import { loadWorkspaces } from "../workspaces.js";
import { saveManager } from "./config.js";

export async function addManager() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string) => (await rl.question(q)).trim();
  try {
    console.log("\n=== Manager bot (#control: /dashboard, /restart, /stop, /mode, alerts) ===\n");
    console.log("1) Create one more bot just for management: https://discord.com/developers/applications");
    console.log("   New Application → Bot → Reset Token → copy. (No Message Content Intent needed. Turn Public Bot off.)\n");

    let token = "";
    let rest: DiscordRest;
    let bot: { id: string; username: string };
    for (;;) {
      token = cleanToken(await askSecret(rl, "Paste the manager bot token (input is hidden): "));
      if (!token) continue;
      rest = new DiscordRest(token);
      try {
        bot = await rest.me();
        break;
      } catch (e) {
        console.log(`  ✗ ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`  ✓ Bot: ${bot.username}`);
    const ws = loadWorkspaces();
    if (ws.some((w) => w.botId === bot.id)) {
      console.log(`  ✗ This bot is already a workspace bot. Create a separate bot for management.`);
      process.exitCode = 1;
      return;
    }

    for (;;) {
      const app = await rest.application();
      if (!app.bot_public) break;
      console.log(`  ! Public Bot is ON. Turn it off here: ${botSettingsUrl(app.id)}`);
      if ((await ask("    Press Enter to check again, or type 'skip': ")) === "skip") break;
    }

    // Invite (with slash command scope) and wait until it joins.
    let guilds = await rest.guilds();
    const wantGuild = ws[0]?.guildId;
    if (!guilds.some((g) => !wantGuild || g.id === wantGuild)) {
      console.log(`\n2) Invite it to your server:\n   ${inviteUrl(bot.id, wantGuild, { permissions: MANAGER_PERMISSIONS, scopes: ["bot", "applications.commands"] })}\n`);
      process.stdout.write("   Waiting for the bot to join");
      for (let i = 0; i < 200 && !guilds.some((g) => !wantGuild || g.id === wantGuild); i++) {
        await sleep(3000);
        process.stdout.write(".");
        guilds = await rest.guilds();
      }
      console.log();
    }
    const guild = guilds.find((g) => !wantGuild || g.id === wantGuild);
    if (!guild) throw new Error("The bot did not join your server in 10 minutes. Run `npm run add-manager` again after inviting it.");
    console.log(`  ✓ Server: ${guild.name}`);

    const chans = textChannels(await rest.channels(guild.id));
    if (!chans.length) throw new Error("No text channels found. Create one (e.g. #control) and run again.");
    console.log("\n3) Which channel is the control room? (create #control first if you like)");
    chans.forEach((c, i) => console.log(`   ${String(i + 1).padStart(2)}. #${c.name}${ws.some((w) => w.channelId === c.id) ? "  (workspace channel — pick another)" : ""}`));
    const suggested = chans.findIndex((c) => /control|manage|admin/i.test(c.name));
    let channel = chans[0];
    for (;;) {
      const a = await ask(`   number${suggested >= 0 ? ` [${suggested + 1}]` : ""}: `);
      const c = chans[(a ? Number(a) : suggested + 1) - 1];
      if (c && !ws.some((w) => w.channelId === c.id)) {
        channel = c;
        break;
      }
    }

    const g = await rest.guild(guild.id);
    const defaultOwner = ws[0]?.userId ?? g.owner_id;
    const owner = await rest.user(defaultOwner).catch(() => null);
    const ans = await ask(`\n4) Only one account can use the manager commands. Use "${owner ? owner.global_name || owner.username : defaultOwner}"? [Y/n or paste a user ID]: `);
    const ownerId = /^\d{15,22}$/.test(ans) ? ans : /^n/i.test(ans) ? await ask("   Your Discord user ID: ") : defaultOwner;

    saveManager({ botId: bot.id, botName: bot.username, guildId: guild.id, channelId: channel.id, channelName: channel.name, ownerId }, token);
    console.log(`\n✓ Manager bot saved: ${bot.username} in #${channel.name}`);
    console.log("  Restart the supervisor (Ctrl+C, then npm start). Slash commands appear in Discord within a few seconds.");
  } catch (e) {
    console.log(`\n✗ ${e instanceof DiscordApiError ? "Discord API error: " : ""}${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
