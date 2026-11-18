import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.WORKSPACE_BRIDGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-mgr-"));
const cmds = await import("../src/manager/commands.js");
const runnerMod = await import("../src/supervisor/runner.js");
const { getHostInfo } = await import("../src/manager/host.js");
const { saveManager, loadManager, readManagerToken } = await import("../src/manager/config.js");
const { inviteUrl, MANAGER_PERMISSIONS } = await import("../src/discordApi.js");

type Info = import("../src/manager/commands.js").WorkspaceInfo;
const info = (over: Partial<Info> = {}): Info => ({
  name: "web",
  channel: "web",
  folder: "C:\\p\\web",
  state: "running",
  detail: "",
  plugin: "connected",
  mode: "auto",
  pid: 123,
  startedAt: Date.now() - 65 * 60_000,
  restarts: 1,
  sessionId: "abcdef12-0000-0000-0000-000000000000",
  ...over,
});

function fakeController(list: Info[]) {
  const calls: string[] = [];
  let locked = false;
  const c: import("../src/manager/commands.js").Controller = {
    list: () => list,
    interrupt: (n) => (calls.push(`interrupt ${n}`), list.find((w) => w.name === n)?.state === "running"),
    restart: (n, fresh) => void calls.push(`restart ${n}${fresh ? " fresh" : ""}`),
    setMode: (n, m) => void calls.push(`mode ${n} ${m}`),
    logs: () => "line1\n```danger```\nline3",
    lockdown: () => ((locked = true), calls.push("lockdown"), list.length),
    host: () => ({ hostname: "PC", uptimeSec: 7200, supervisorUptimeSec: 600, cpuPercent: 12.3, memUsedGb: 8, memTotalGb: 16, diskFreeGb: 100, diskTotalGb: 500 }),
    lockedDown: () => locked,
  };
  return { c, calls };
}

test("slash command definitions are valid for Discord", () => {
  const names = new Set<string>();
  for (const cmd of cmds.COMMANDS) {
    assert.match(cmd.name, /^[a-z][a-z0-9_-]{0,31}$/);
    assert.ok(!names.has(cmd.name));
    names.add(cmd.name);
    assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100, `${cmd.name} description length`);
    let optionalSeen = false;
    for (const o of (cmd as any).options ?? []) {
      assert.ok(o.description.length <= 100);
      if (!o.required) optionalSeen = true;
      else assert.ok(!optionalSeen, `${cmd.name}: required options must come first`);
    }
  }
  for (const n of ["dashboard", "status", "stop", "restart", "new", "mode", "logs", "ping", "lockdown"]) assert.ok(names.has(n), n);
});

test("dashboard and status read well on a phone", async () => {
  const { c } = fakeController([info(), info({ name: "api", state: "needs-trust", detail: "trust folder", plugin: "unknown", mode: "manual", restarts: 0 })]);
  const d = await cmds.runCommand("dashboard", {}, c);
  assert.match(d, /1\/2 running/);
  assert.match(d, /🟢 \*\*web\*\* · auto · bot online · up 1h 05m · restarts 1/);
  assert.match(d, /🔐 \*\*api\*\* · manual · trust folder/);
  const s = await cmds.runCommand("status", { ws: "web" }, c);
  assert.match(s, /session: `abcdef12`/);
  assert.match(s, /folder: `C:\\p\\web`/);
  assert.match(await cmds.runCommand("status", { ws: "nope" }, c), /No workspace named `nope`. Workspaces: web, api/);
});

test("stop interrupts only a running workspace", async () => {
  const { c, calls } = fakeController([info(), info({ name: "api", state: "stopped" })]);
  assert.match(await cmds.runCommand("stop", { ws: "web" }, c), /Sent stop to \*\*web\*\*/);
  assert.match(await cmds.runCommand("stop", { ws: "api" }, c), /not running \(stopped\)/);
  assert.deepEqual(calls, ["interrupt web", "interrupt api"]);
});

test("restart, restart all, new", async () => {
  const { c, calls } = fakeController([info(), info({ name: "api" })]);
  await cmds.runCommand("restart", { ws: "web" }, c);
  assert.match(await cmds.runCommand("restart", { ws: "all" }, c), /Restarting all 2/);
  assert.match(await cmds.runCommand("new", { ws: "api" }, c), /new, empty conversation/);
  assert.match(await cmds.runCommand("new", { ws: "all" }, c), /No workspace named `all`/); // no mass reset by accident
  assert.deepEqual(calls, ["restart web", "restart web", "restart api", "restart api fresh"]);
});

test("mode validates and skips no-op changes", async () => {
  const { c, calls } = fakeController([info({ mode: "auto" })]);
  assert.match(await cmds.runCommand("mode", { ws: "web", mode: "auto" }, c), /already in auto/);
  assert.match(await cmds.runCommand("mode", { ws: "web", mode: "bypassPermissions" }, c), /Unknown mode/);
  assert.match(await cmds.runCommand("mode", { ws: "web", mode: "manual" }, c), /web\*\* → manual/);
  assert.deepEqual(calls, ["mode web manual"]);
});

test("logs are fenced safely and limited", async () => {
  const { c } = fakeController([info()]);
  const out = await cmds.runCommand("logs", { ws: "web", lines: 5 }, c);
  assert.match(out, /last 10 lines/); // clamped to 10-60
  assert.equal((out.match(/```/g) ?? []).length, 2, "inner fences must not break the code block");
});

test("lockdown needs confirm:True", async () => {
  const { c, calls } = fakeController([info(), info({ name: "api" })]);
  assert.match(await cmds.runCommand("lockdown", { confirm: false }, c), /Not stopped/);
  assert.deepEqual(calls, []);
  assert.match(await cmds.runCommand("lockdown", { confirm: true }, c), /stopped 2/);
  assert.match(await cmds.runCommand("dashboard", {}, c), /locked down/);
});

test("ping shows host health", async () => {
  const { c } = fakeController([info()]);
  const p = await cmds.runCommand("ping", {}, c);
  assert.match(p, /PC\*\* is online/);
  assert.match(p, /CPU 12% · memory 8\.0 \/ 16\.0 GB/);
  const real = await getHostInfo(Date.now() - 1000);
  assert.ok(real.memTotalGb > 0 && real.cpuPercent >= 0 && real.cpuPercent <= 100);
});

test("autocomplete offers 'all' only for restart and filters by what was typed", () => {
  const { c } = fakeController([info(), info({ name: "api" })]);
  assert.deepEqual(cmds.autocompleteChoices(c, "", true).map((x) => x.value), ["all", "web", "api"]);
  assert.deepEqual(cmds.autocompleteChoices(c, "AP", false).map((x) => x.value), ["api"]);
});

test("runner interrupt sends Esc to a running claude only", () => {
  const writes: string[] = [];
  let onData = (_: string) => {};
  const spawn = () => ({ pid: 1, onData: (cb: any) => (onData = cb), onExit: () => {}, kill: () => {}, write: (d: string) => void writes.push(d) });
  const ws = { name: "int", folder: os.tmpdir(), botId: "1", botName: "b", guildId: "2", channelId: "3", channelName: "c", userId: "4" };
  const r = new runnerMod.WorkspaceRunner(ws, { claude: { file: "claude", prefixArgs: [] }, spawn: spawn as any, mcpLogRoot: null });
  assert.equal(r.interrupt(), false);
  r.start();
  onData("ready\r\n");
  assert.equal(r.interrupt(), true);
  assert.deepEqual(writes, ["\x1b"]);
  r.stop();
  assert.equal(r.interrupt(), false);
});

test("manager config round-trip and invite link with slash commands", () => {
  saveManager({ botId: "9", botName: "mgr", guildId: "2", channelId: "5", channelName: "control", ownerId: "4" }, "TOKEN");
  assert.equal(loadManager()?.channelName, "control");
  assert.equal(readManagerToken(), "TOKEN");
  const u = new URL(inviteUrl("9", "2", { permissions: MANAGER_PERMISSIONS, scopes: ["bot", "applications.commands"] }));
  assert.equal(u.searchParams.get("scope"), "bot applications.commands");
  assert.equal(u.searchParams.get("permissions"), String(1024 + 2048 + 16384 + 65536));
  assert.equal(u.searchParams.get("guild_id"), "2");
});
