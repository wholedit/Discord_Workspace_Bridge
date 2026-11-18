// The manager bot's Discord connection: registers slash commands in your server, answers only the owner,
// and posts alerts to #control. Needs only the Guilds intent (no message content).

import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction, type TextChannel } from "discord.js";
import { COMMANDS, autocompleteChoices, runCommand, type Controller } from "./commands.js";
import type { ManagerConfig } from "./config.js";

export type ManagerHandle = {
  /** Post to #control. mention=true pings the owner (phone notification). */
  notify(text: string, mention?: boolean): Promise<void>;
  close(): Promise<void>;
};

export async function startManager(cfg: ManagerConfig, token: string, controller: Controller, log: (m: string) => void): Promise<ManagerHandle> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let channel: TextChannel | null = null;
  const queued: { text: string; mention: boolean }[] = [];

  const send = async (text: string, mention: boolean) => {
    if (!channel) {
      queued.push({ text, mention });
      return;
    }
    await channel
      .send({
        content: mention ? `<@${cfg.ownerId}> ${text}` : text,
        allowedMentions: { users: mention ? [cfg.ownerId] : [] },
        flags: mention ? undefined : MessageFlags.SuppressNotifications,
      })
      .catch((e) => log(`[manager] could not post to #${cfg.channelName}: ${e instanceof Error ? e.message : e}`));
  };

  client.once(Events.ClientReady, async (c) => {
    try {
      await c.application.commands.set(COMMANDS as any, cfg.guildId);
      const ch = await c.channels.fetch(cfg.channelId);
      channel = ch && ch.isTextBased() ? (ch as TextChannel) : null;
      log(`[manager] ${c.user.tag} ready in #${cfg.channelName}; ${COMMANDS.length} slash commands registered`);
      for (const q of queued.splice(0)) await send(q.text, q.mention);
    } catch (e) {
      log(`[manager] setup failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  client.on(Events.InteractionCreate, async (i: Interaction) => {
    try {
      const allowed = i.guildId === cfg.guildId && i.user.id === cfg.ownerId;
      if (i.isAutocomplete()) {
        if (!allowed) return void (await i.respond([]));
        const focused = i.options.getFocused(true);
        await i.respond(focused.name === "ws" ? autocompleteChoices(controller, String(focused.value), i.commandName === "restart") : []);
        return;
      }
      if (!i.isChatInputCommand()) return;
      if (!allowed) {
        await i.reply({ content: "Not allowed. Only the owner of this PC can use these commands.", flags: MessageFlags.Ephemeral });
        log(`[manager] refused /${i.commandName} from ${i.user.tag}`);
        return;
      }
      const opts: Record<string, string | number | boolean> = {};
      for (const o of i.options.data) if (o.value !== undefined) opts[o.name] = o.value as string | number | boolean;
      await i.deferReply({ flags: MessageFlags.Ephemeral }); // some commands (ping) take a moment
      const text = await runCommand(i.commandName, opts, controller);
      await i.editReply({ content: text.slice(0, 2000) });
      log(`[manager] /${i.commandName} ${opts.ws ?? ""}`.trimEnd());
    } catch (e) {
      log(`[manager] command failed: ${e instanceof Error ? e.message : e}`);
    }
  });

  client.on(Events.Error, (e) => log(`[manager] ${e.message}`));
  await client.login(token);

  return {
    notify: (text, mention = false) => send(text, mention),
    close: async () => {
      await client.destroy();
    },
  };
}
