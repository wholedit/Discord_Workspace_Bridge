import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-setup-"));
process.env.WORKSPACE_BRIDGE_HOME = HOME;
const { SetupApi } = await import("../src/setup/api.js");
const { taskXml, winQuote, rotateLog, supervisorCommand } = await import("../src/autostart.js");
const control = await import("../src/supervisor/control.js");
const { loadWorkspaces, stateDir } = await import("../src/workspaces.js");
const { loadManager, readManagerToken } = await import("../src/manager/config.js");

/** A fake Discord: two bots, one server, three channels. */
function fakeDiscord(opts: { intent?: boolean; public?: boolean; joined?: boolean } = {}) {
  const bots: Record<string, { id: string; username: string }> = { "tok-web": { id: "111", username: "web-bot" }, "tok-mgr": { id: "222", username: "mgr-bot" } };
  return async (url: string, init: { headers: Record<string, string> }) => {
    const token = init.headers.Authorization.replace("Bot ", "");
    const bot = bots[token];
    const reply = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
    if (!bot) return reply(401, {});
    const p = url.replace("https://discord.com/api/v10", "");
    if (p === "/users/@me") return reply(200, bot);
    if (p === "/applications/@me") return reply(200, { id: bot.id, name: bot.username, flags: opts.intent === false ? 0 : 1 << 18, bot_public: !!opts.public });
    if (p === "/users/@me/guilds") return reply(200, opts.joined === false ? [] : [{ id: "900", name: "My server" }]);
    if (p === "/guilds/900") return reply(200, { id: "900", name: "My server", owner_id: "123456789012345678" });
    if (p === "/guilds/900/channels")
      return reply(200, [
        { id: "c1", name: "web", type: 0, position: 1 },
        { id: "c2", name: "control", type: 0, position: 2 },
        { id: "v1", name: "voice", type: 2, position: 3 },
      ]);
    if (p.startsWith("/users/")) return reply(200, { id: p.slice(7), username: "owner", global_name: "Owner" });
    return reply(404, {});
  };
}

test("setup API: add a workspace end to end, token never returned", async () => {
  const api = new SetupApi({ fetch: fakeDiscord() as any });
  await assert.rejects(api.token("workspace", "wrong"), /not valid/);
  const t = await api.token("workspace", ' "tok-web" ');
  assert.equal(t.bot.name, "web-bot");
  assert.ok(!JSON.stringify(t).includes("tok-web"), "the token must not go back to the page");

  assert.deepEqual(await api.botSettings(t.draft), { intent: true, intentNeeded: true, public: false, settingsUrl: "https://discord.com/developers/applications/111/bot" });
  const g = await api.guilds(t.draft);
  assert.equal(g.guilds[0].name, "My server");
  assert.match(g.invite, /client_id=111/);
  const c = await api.channels(t.draft, "900");
  assert.deepEqual(c.channels.map((x) => x.name), ["web", "control"]); // text channels only
  assert.equal(c.owner.name, "Owner");

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-folder-"));
  assert.equal(api.checkFolder(path.join(folder, "nope")).ok, false);
  assert.equal(api.checkFolder(folder).ok, true);
  assert.throws(() => api.saveWorkspace({ draft: t.draft, guildId: "900", channelId: "made-up", folder, userId: "123456789012345678", name: "web" }), /Pick a channel/);
  assert.throws(() => api.saveWorkspace({ draft: t.draft, guildId: "900", channelId: "c1", folder, userId: "12", name: "web" }), /user ID/);
  const bad = api.saveWorkspace({ draft: t.draft, guildId: "900", channelId: "c1", folder, userId: "123456789012345678", name: "Bad Name!" });
  assert.equal(bad.ok, false);

  const ok = api.saveWorkspace({ draft: t.draft, guildId: "900", channelId: "c1", folder, userId: "123456789012345678", name: "web", mode: "manual" });
  assert.equal(ok.ok, true);
  const saved = loadWorkspaces().find((w) => w.name === "web")!;
  assert.equal(saved.channelName, "web");
  assert.equal(saved.permissionMode, "manual");
  assert.match(fs.readFileSync(path.join(stateDir("web"), ".env"), "utf8"), /DISCORD_BOT_TOKEN=tok-web/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir("web"), "access.json"), "utf8")).allowFrom[0], "123456789012345678");
  await assert.rejects(api.botSettings(t.draft), /expired/); // draft is dropped after saving
  assert.equal(api.checkFolder(folder).ok, false, "a folder can belong to one workspace only");
});

test("setup API: manager bot must be separate and use another channel", async () => {
  const api = new SetupApi({ fetch: fakeDiscord() as any });
  await assert.rejects(api.token("manager", "tok-web"), /already the bot of workspace "web"/);
  const t = await api.token("manager", "tok-mgr");
  assert.equal((await api.botSettings(t.draft)).intentNeeded, false);
  assert.match((await api.guilds(t.draft)).invite, /scope=bot\+applications.commands/);
  const c = await api.channels(t.draft, "900");
  assert.equal(c.channels.find((x) => x.id === "c1")!.takenBy, "workspace web");
  assert.equal(c.suggestedChannel, "c2"); // #control
  const clash = api.saveManager({ draft: t.draft, guildId: "900", channelId: "c1", ownerId: "123456789012345678" });
  assert.equal(clash.ok, false);
  assert.equal(api.saveManager({ draft: t.draft, guildId: "900", channelId: "c2", ownerId: "123456789012345678" }).ok, true);
  assert.equal(loadManager()?.channelName, "control");
  assert.equal(readManagerToken(), "tok-mgr");
  await assert.rejects(new SetupApi({ fetch: fakeDiscord() as any }).token("workspace", "tok-mgr"), /is your manager bot/);
});

test("setup API reports a missing intent and a public bot", async () => {
  const api = new SetupApi({ fetch: fakeDiscord({ intent: false, public: true, joined: false }) as any });
  const t = await api.token("workspace", "tok-web");
  const s = await api.botSettings(t.draft);
  assert.equal(s.intent, false);
  assert.equal(s.public, true);
  assert.deepEqual((await api.guilds(t.draft)).guilds, []);
});

test("auto-start task: sign-in trigger, no time limit, no admin, runs start-bg", () => {
  const x = taskXml({ nodePath: "C:\\Program Files\\nodejs\\node.exe", workdir: "C:\\a & b\\repo", user: "PC\\me" });
  assert.match(x, /<LogonTrigger>[\s\S]*<UserId>PC\\me<\/UserId>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(x, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(x, /<DisallowStartIfOnBatteries>false/);
  assert.match(x, /<Command>C:\\Program Files\\nodejs\\node.exe<\/Command>/);
  assert.match(x, /<Arguments>--use-system-ca --import tsx src\\cli.ts start-bg<\/Arguments>/);
  assert.match(x, /<WorkingDirectory>C:\\a &amp; b\\repo<\/WorkingDirectory>/); // XML-escaped
  assert.deepEqual(supervisorCommand("start", "node").slice(-1), ["start"]);
});

test("Windows argument quoting round-trips the C runtime rules", () => {
  assert.equal(winQuote("plain"), "plain");
  assert.equal(winQuote("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
  assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(winQuote("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
  assert.equal(winQuote(""), '""');
});

test("request files: stop and restart reach the supervisor once", () => {
  control.sendRequest({ kind: "restart", name: "web" });
  control.sendRequest({ kind: "restart", name: "api", fresh: true });
  control.sendRequest({ kind: "stop" });
  fs.writeFileSync(path.join(control.requestsDir(), "restart-../../evil"), "");
  const got = control.takeRequests();
  assert.equal(got.length, 3);
  assert.ok(got.some((r) => r.kind === "stop"));
  assert.ok(got.some((r) => r.kind === "restart" && r.name === "web" && !r.fresh));
  assert.ok(got.some((r) => r.kind === "restart" && r.name === "api" && r.fresh));
  assert.deepEqual(control.takeRequests(), []);
  assert.equal(control.supervisorPid(), null);
});

test("log rotation keeps one old file", () => {
  const f = path.join(HOME, "rot.log");
  fs.writeFileSync(f, "x".repeat(50));
  rotateLog(f, 10);
  assert.ok(fs.existsSync(f + ".1") && !fs.existsSync(f));
});
