import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-test-"));
process.env.WORKSPACE_BRIDGE_HOME = path.join(tmp, "home");

const ws = await import("../src/workspaces.js");
const api = await import("../src/discordApi.js");
const check = await import("../src/check.js");
const launch = await import("../src/launch.js");

const folderA = path.join(tmp, "projA");
const folderB = path.join(tmp, "projB");
before(() => {
  fs.mkdirSync(folderA);
  fs.mkdirSync(folderB);
});

const sample = (over: Partial<import("../src/workspaces.js").Workspace> = {}) => ({
  name: "web",
  folder: folderA,
  botId: "111",
  botName: "web-bot",
  guildId: "900",
  channelId: "222",
  channelName: "web",
  userId: "333",
  ...over,
});

// ---------- workspaces ----------

test("access.json allows only the owner, only the bound channel, without @mention", () => {
  const a = ws.accessConfig(sample());
  assert.equal(a.dmPolicy, "allowlist");
  assert.deepEqual(a.allowFrom, ["333"]);
  assert.deepEqual(Object.keys(a.groups), ["222"]);
  assert.deepEqual(a.groups["222"], { requireMention: false, allowFrom: ["333"] });
});

test("state folder gets the token in .env and access.json", () => {
  ws.writeStateDir(sample(), "TOKEN123456789");
  const dir = ws.stateDir("web");
  assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "DISCORD_BOT_TOKEN=TOKEN123456789\n");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "access.json"), "utf8")).groups["222"].requireMention, false);
});

test("validation rejects shared channel, shared bot, shared folder and bad names", () => {
  const existing = [sample()];
  assert.deepEqual(ws.validateWorkspace(sample({ name: "api", folder: folderB, botId: "444", channelId: "555" }), existing), []);
  assert.match(ws.validateWorkspace(sample({ name: "api", folder: folderB, botId: "444" }), existing).join(), /Channel #web is already used/);
  assert.match(ws.validateWorkspace(sample({ name: "api", folder: folderB, channelId: "555" }), existing).join(), /bot is already used/);
  assert.match(ws.validateWorkspace(sample({ name: "api", botId: "444", channelId: "555" }), existing).join(), /Folder is already used/);
  assert.match(ws.validateWorkspace(sample({ name: "Bad Name" }), []).join(), /Name must be/);
  assert.match(ws.validateWorkspace(sample({ folder: path.join(tmp, "nope") }), []).join(), /does not exist/);
  // replacing a workspace with the same name is fine
  assert.deepEqual(ws.validateWorkspace(sample(), existing), []);
});

test("registry upsert and remove", async () => {
  ws.upsertWorkspace(sample());
  ws.upsertWorkspace(sample({ name: "api", folder: folderB, botId: "444", channelId: "555" }));
  ws.upsertWorkspace(sample({ channelName: "web-renamed" }));
  assert.deepEqual(ws.loadWorkspaces().map((w) => w.name).sort(), ["api", "web"]);
  const { removeWorkspace } = await import("../src/remove.js");
  assert.equal(removeWorkspace("api", { quiet: true }), true);
  assert.deepEqual(ws.loadWorkspaces().map((w) => w.name), ["web"]);
  assert.equal(fs.existsSync(ws.stateDir("api")), false);
});

test("claude project folder naming and previous-session detection", () => {
  if (process.platform === "win32") assert.equal(path.basename(ws.claudeProjectDir("C:\\projects\\bridge")), "C--projects-bridge");
  else assert.equal(path.basename(ws.claudeProjectDir("/home/me/my_proj")), "-home-me-my-proj");
  const claudeHome = path.join(tmp, "claude");
  assert.equal(ws.hasPreviousSession(folderA, claudeHome), false);
  const proj = ws.claudeProjectDir(folderA, claudeHome);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, "abc.jsonl"), "{}");
  assert.equal(ws.hasPreviousSession(folderA, claudeHome), true);
});

// ---------- discord api ----------

test("message content intent detection uses either flag", () => {
  assert.equal(api.hasMessageContentIntent(0), false);
  assert.equal(api.hasMessageContentIntent(undefined), false);
  assert.equal(api.hasMessageContentIntent(api.FLAG_GATEWAY_MESSAGE_CONTENT), true);
  assert.equal(api.hasMessageContentIntent(api.FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED | 1), true);
  assert.equal(api.hasMessageContentIntent(1 << 17), false);
});

test("invite link carries exactly the plugin's permissions", () => {
  const url = new URL(api.inviteUrl("123"));
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("scope"), "bot");
  assert.equal(url.searchParams.get("permissions"), "274878008384");
  assert.equal(new URL(api.inviteUrl("123", "999")).searchParams.get("guild_id"), "999");
});

test("token cleanup and text channel filtering", () => {
  assert.equal(api.cleanToken('  "DISCORD_BOT_TOKEN=abc.def"  '), "abc.def");
  const chans = api.textChannels([
    { id: "1", name: "voice", type: 2, position: 0 },
    { id: "2", name: "b", type: 0, position: 2 },
    { id: "3", name: "a", type: 0, position: 1 },
  ]);
  assert.deepEqual(chans.map((c) => c.name), ["a", "b"]);
});

test("REST client reports a bad token clearly", async () => {
  const fake = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(new api.DiscordRest("x", fake).me(), /token is not valid/);
  const ok = async (url: string, init: { headers: Record<string, string> }) => {
    assert.equal(init.headers.Authorization, "Bot tok");
    assert.ok(url.endsWith("/users/@me"));
    return { ok: true, status: 200, json: async () => ({ id: "1", username: "web-bot" }) };
  };
  assert.equal((await new api.DiscordRest("tok", ok).me()).username, "web-bot");
});

// ---------- check parsing ----------

test("parses claude auth status and plugin list output", () => {
  assert.deepEqual(check.parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'), {
    loggedIn: true,
    method: "claude.ai",
    plan: "pro",
  });
  assert.equal(check.parseAuthStatus("garbage").loggedIn, false);
  assert.deepEqual(check.parsePluginList('[{"id":"discord@claude-plugins-official","enabled":true}]'), { installed: true, enabled: true });
  assert.deepEqual(check.parsePluginList('[{"id":"other@x","enabled":true}]'), { installed: false, enabled: false });
});

// launch / supervisor tests live in test/supervisor.test.ts

test("network errors are explained, including HTTPS inspection", async () => {
  const err = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.match(api.networkErrorMessage(err("SELF_SIGNED_CERT_IN_CHAIN")), /inspects HTTPS/);
  assert.match(api.networkErrorMessage(err("ENOTFOUND")), /Cannot resolve/);
  assert.match(api.networkErrorMessage(err("ETIMEDOUT")), /Cannot connect/);
  const failing = async () => {
    throw err("SELF_SIGNED_CERT_IN_CHAIN");
  };
  await assert.rejects(new api.DiscordRest("t", failing).me(), /HTTPS certificate/);
  assert.deepEqual(await api.pingDiscord(async () => ({ ok: true, status: 200, json: async () => ({}) })), { ok: true, detail: "reachable" });
  assert.equal((await api.pingDiscord(failing)).ok, false);
});

test("every failed check explains what to do, with copyable commands and real links", () => {
  for (const [id, make] of Object.entries(check.FIXES)) {
    const steps = (make as (d: string) => import("../src/check.js").FixStep[])("detail");
    assert.ok(steps.length > 0, id);
    for (const s of steps) {
      assert.ok(s.text.length > 5, `${id}: step text`);
      if (s.cmd) assert.ok(!s.cmd.includes("\n"), `${id}: one-line command`);
      if (s.link) assert.match(s.link.url, /^https:\/\//, `${id}: https link`);
    }
  }
  assert.match(check.FIXES.pluginInstall()[0].cmd!, /^claude plugin install discord@claude-plugins-official$/);
  assert.equal(check.fixLine([{ text: "a", cmd: "b" }, { text: "c", link: { url: "https://x", label: "x" } }]), "a b / c https://x");
});

test("optional misses don't count as problems; blocked ones do", () => {
  const r = (o: Partial<import("../src/check.js").CheckResult>) => ({ id: "x", name: "x", ok: false, detail: "", ...o });
  assert.equal(check.problems([r({ ok: true }), r({ optional: true }), r({ blocked: true }), r({})]).length, 2);
});

test("fresh PATH keeps what we had and adds nothing twice", () => {
  if (process.platform !== "win32") {
    assert.equal(check.freshPath({ PATH: "/a:/b" }), "/a:/b");
    return;
  }
  const parts = check.freshPath({ PATH: "C:\\a;C:\\b;c:\\A" })!.split(";");
  assert.ok(parts.includes("C:\\a") && parts.includes("C:\\b"));
  assert.equal(parts.filter((x) => x.toLowerCase() === "c:\\a").length, 1);
});
