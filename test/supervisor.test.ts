import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wsb-sup-"));
process.env.WORKSPACE_BRIDGE_HOME = path.join(tmp, "home");
const claudeHome = path.join(tmp, "claude");

const spec = await import("../src/supervisor/spec.js");
const runnerMod = await import("../src/supervisor/runner.js");
const progress = await import("../src/supervisor/progress.js");
const launch = await import("../src/launch.js");
const { claudeProjectDir } = await import("../src/workspaces.js");

const folder = path.join(tmp, "proj");
fs.mkdirSync(folder);
const ws = { name: "web", folder, botId: "1", botName: "web-bot", guildId: "2", channelId: "3", channelName: "web", userId: "4" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- spec ----------

test("environment cleanup drops leaky variables and keeps the rest", () => {
  const env = spec.cleanEnv({
    PATH: "p",
    CLAUDE_CONFIG_DIR: "keep",
    BUN_INSPECT: "ws://x",
    bun_inspect_notify: "y",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_SESSION_ID: "abc",
    DISCORD_BOT_TOKEN: "secret",
    MCP_CONNECTION_NONBLOCKING: "true",
  });
  assert.deepEqual(env, { PATH: "p", CLAUDE_CONFIG_DIR: "keep" });
});

test("session ID is kept per workspace; fresh makes a new one; resume only once the conversation file exists", () => {
  const a = spec.getSessionId(ws);
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(spec.getSessionId(ws), a);
  const b = spec.getSessionId(ws, true);
  assert.notEqual(b, a);
  assert.equal(spec.sessionExists(ws, b, claudeHome), false);
  const dir = claudeProjectDir(folder, claudeHome);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${b}.jsonl`), "{}");
  assert.equal(spec.sessionExists(ws, b, claudeHome), true);
});

test("launch spec: args, environment, hook settings", () => {
  const fresh = spec.buildSpec(ws, { fresh: true, shim: { dir: "D:/shim", realBun: "D:/bun.exe" }, baseEnv: { PATH: "C:/x", BUN_INSPECT: "ws://1", DISCORD_BOT_TOKEN: "t" }, claudeHome });
  assert.equal(fresh.resume, false);
  assert.deepEqual(fresh.args.slice(0, 2), ["--session-id", fresh.sessionId]);
  assert.ok(fresh.args.includes("--channels") && fresh.args.includes("plugin:discord@claude-plugins-official"));
  assert.equal(fresh.env.DISCORD_ACCESS_MODE, "static");
  assert.equal(fresh.env.MCP_TIMEOUT, "120000");
  assert.equal(fresh.env.WSB_REAL_BUN, "D:/bun.exe");
  assert.ok(String(fresh.env.PATH).startsWith("D:/shim" + path.delimiter));
  assert.equal(fresh.env.BUN_INSPECT, undefined);
  assert.equal(fresh.env.DISCORD_BOT_TOKEN, undefined);
  assert.match(String(fresh.env.DISCORD_STATE_DIR), /workspaces[\\/]web$/);

  const settings = JSON.parse(fs.readFileSync(fresh.args[fresh.args.indexOf("--settings") + 1], "utf8"));
  for (const ev of ["UserPromptSubmit", "PreToolUse", "Notification", "Stop", "StopFailure"]) {
    assert.equal(settings.hooks[ev][0].hooks[0].async, true, ev);
    assert.match(settings.hooks[ev][0].hooks[0].command, /progress-hook\.mjs"$/);
  }

  // once the conversation file exists, the same ID is resumed
  fs.mkdirSync(claudeProjectDir(folder, claudeHome), { recursive: true });
  fs.writeFileSync(path.join(claudeProjectDir(folder, claudeHome), `${fresh.sessionId}.jsonl`), "{}");
  const again = spec.buildSpec(ws, { claudeHome });
  assert.deepEqual(again.args.slice(0, 2), ["--resume", fresh.sessionId]);
});

test("visible-mode script re-applies the environment and puts the bun wrapper first", () => {
  const s = spec.buildSpec(ws, { fresh: true, shim: { dir: "D:\\shim", realBun: "D:\\bun.exe" }, baseEnv: { Path: "C:\\x" }, claudeHome });
  const script = launch.runScript(ws, s, "C:\\bin\\claude.exe", ["BUN_INSPECT", "CLAUDECODE"]);
  assert.ok(script.includes('set "BUN_INSPECT="') && script.includes('set "CLAUDECODE="') && script.includes('set "DISCORD_BOT_TOKEN="'));
  assert.ok(script.includes('set "MCP_TIMEOUT=120000"') && script.includes('set "WSB_REAL_BUN=D:\\bun.exe"'));
  assert.ok(script.includes('set "PATH=D:\\shim;%PATH%"'));
  assert.ok(script.indexOf("PATH=") < script.indexOf('"C:\\bin\\claude.exe"'));
  assert.match(script, /"C:\\bin\\claude\.exe" --session-id [0-9a-f-]{36} --name web/);
  assert.match(launch.posixCommand(s), /^cd '.*proj' && env .*-u BUN_INSPECT.* DISCORD_STATE_DIR=.* claude '--session-id'/);
});

// ---------- runner helpers ----------

test("trust prompt detection works on squashed terminal text", () => {
  const screen = "\x1b[2KQuick\x1b[1Csafety\x1b[1Ccheck: Is this a project you trust?\r\n❯No,exitYes,ItrustthisfolderEntertoconfirm";
  const text = runnerMod.stripAnsi(screen);
  assert.ok(!text.includes("\x1b"));
  assert.equal(runnerMod.looksLikeTrustPrompt(text), true);
  assert.equal(runnerMod.looksLikeTrustPrompt("Welcome back! ❯ Try \"fix lint errors\""), false);
});

test("backoff grows and caps", () => {
  assert.equal(runnerMod.backoffDelay(0), 5_000);
  assert.equal(runnerMod.backoffDelay(2), 30_000);
  assert.equal(runnerMod.backoffDelay(99), 300_000);
});

test("plugin log parsing finds the latest connect result after start", () => {
  const t0 = Date.parse("2026-11-18T01:00:00Z");
  const line = (ts: string, o: object) => JSON.stringify({ ...o, timestamp: ts });
  const log = [
    line("2026-11-18T00:50:00Z", { debug: "Channel notifications registered" }), // before start: ignored
    line("2026-11-18T01:00:05Z", { error: "Server stderr: Failed to start inspector:\n port in use" }),
    line("2026-11-18T01:00:06Z", { error: "Connection failed (CONNECTION_CLOSED): Connection closed" }),
  ].join("\n");
  assert.equal(runnerMod.parsePluginLog(log, t0)?.state, "failed");
  const ok = log + "\n" + line("2026-11-18T01:00:40Z", { debug: "Channel notifications registered" });
  assert.deepEqual(runnerMod.parsePluginLog(ok, t0), { state: "connected", detail: "" });
  assert.equal(runnerMod.parsePluginLog("", t0), null);
});

// ---------- runner with a fake terminal ----------

function fakePty() {
  const spawned: { args: string[]; out: (d: string) => void; exit: (c: number) => void; killed: boolean }[] = [];
  const spawn = (_file: string, args: string[]) => {
    let onData = (_d: string) => {};
    let onExit = (_e: { exitCode: number }) => {};
    const rec = { args, out: (d: string) => onData(d), exit: (c: number) => onExit({ exitCode: c }), killed: false };
    spawned.push(rec);
    return {
      pid: 1000 + spawned.length,
      onData: (cb: (d: string) => void) => (onData = cb),
      onExit: (cb: (e: { exitCode: number }) => void) => (onExit = cb),
      kill: () => {
        rec.killed = true;
        setTimeout(() => onExit({ exitCode: 1 }), 1);
      },
      write: () => {},
    };
  };
  return { spawn, spawned };
}

const runnerOpts = (spawn: any) => ({ claude: { file: "claude", prefixArgs: [] }, spawn, backoff: [20, 40], mcpLogRoot: null, claudeHome });

test("runner restarts claude after it exits", async () => {
  const { spawn, spawned } = fakePty();
  const r = new runnerMod.WorkspaceRunner({ ...ws, name: "r1" }, runnerOpts(spawn));
  r.start();
  assert.equal(spawned.length, 1);
  spawned[0].out("Welcome to Claude Code\r\n");
  assert.equal(r.state, "running");
  spawned[0].exit(1);
  assert.equal(r.state, "restarting");
  await sleep(60);
  assert.equal(spawned.length, 2);
  assert.equal(r.restarts, 1);
  r.stop();
  assert.equal(r.state, "stopped");
});

test("runner stops and waits for a person when claude asks about folder trust", async () => {
  const { spawn, spawned } = fakePty();
  const r = new runnerMod.WorkspaceRunner({ ...ws, name: "r2" }, runnerOpts(spawn));
  r.start();
  spawned[0].out("Quick safety check: Is this a project you created or one you trust?\r\n❯ 1. Yes, I trust this folder\r\n");
  assert.equal(r.state, "needs-trust");
  assert.equal(spawned[0].killed, true);
  await sleep(80);
  assert.equal(spawned.length, 1, "must not restart into the same question");
  assert.equal(r.state, "needs-trust");
});

test("runner falls back to a new conversation when resuming keeps failing", async () => {
  const name = "r3";
  const { spawn, spawned } = fakePty();
  const w = { ...ws, name };
  const id = spec.getSessionId(w, true);
  fs.writeFileSync(path.join(claudeProjectDir(folder, claudeHome), `${id}.jsonl`), "{}"); // so it resumes
  const r = new runnerMod.WorkspaceRunner(w, runnerOpts(spawn));
  r.start();
  assert.deepEqual(spawned[0].args.slice(0, 2), ["--resume", id]);
  spawned[0].exit(1);
  await sleep(50);
  spawned[1].exit(1);
  await sleep(80);
  assert.equal(spawned.length, 3);
  assert.equal(spawned[2].args[0], "--session-id");
  assert.notEqual(spawned[2].args[1], id);
  r.stop();
});

// ---------- progress ----------

function fakeSink() {
  const sent: string[] = [];
  const edits: { id: string; content: string }[] = [];
  return {
    sent,
    edits,
    sink: {
      send: async (c: string) => {
        sent.push(c);
        return "m" + sent.length;
      },
      edit: async (id: string, content: string) => void edits.push({ id, content }),
    },
  };
}

test("progress: one quiet status message per task, throttled edits, closed on Stop", async () => {
  const { sent, edits, sink } = fakeSink();
  const p = new progress.ProgressReporter(sink, { minEditMs: 30, tickMs: 10_000 });
  const t = Date.now();
  p.handle({ t, e: "UserPromptSubmit" });
  p.handle({ t, e: "PreToolUse", tool: "mcp__plugin_discord_discord__react", input: {} }); // ignored
  p.handle({ t, e: "PreToolUse", tool: "Read", input: { file_path: "C:\\p\\src\\a.ts" } });
  p.handle({ t, e: "PreToolUse", tool: "Bash", input: { command: "npm test" } });
  p.handle({ t, e: "PreToolUse", tool: "Edit", input: { file_path: "/p/src/b.ts" }, sub: 1 });
  await sleep(60);
  await p.flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Running/);
  assert.match(sent[0], /Read src\/a\.ts/);
  assert.ok(edits.length >= 1 && edits.length <= 2, `throttled edits, got ${edits.length}`);
  assert.match(edits.at(-1)!.content, /tools 3/);
  assert.match(edits.at(-1)!.content, /↳ ✏️ Edit src\/b\.ts/);

  p.handle({ t, e: "Notification", nt: "permission_prompt" });
  await sleep(20);
  await p.flush();
  assert.match(edits.at(-1)!.content, /Waiting for approval/);

  p.handle({ t, e: "Stop" });
  await p.flush();
  assert.match(edits.at(-1)!.content, /Done/);
  assert.equal(edits.at(-1)!.id, "m1");
  p.close();
});

test("progress: a reply without tools sends nothing", async () => {
  const { sent, edits, sink } = fakeSink();
  const p = new progress.ProgressReporter(sink, { minEditMs: 10 });
  p.handle({ t: Date.now(), e: "UserPromptSubmit" });
  p.handle({ t: Date.now(), e: "PreToolUse", tool: "mcp__plugin_discord_discord__reply", input: {} });
  p.handle({ t: Date.now(), e: "Stop" });
  await sleep(30);
  await p.flush();
  assert.equal(sent.length + edits.length, 0);
  p.close();
});

test("event tail reads only new lines", async () => {
  const file = path.join(tmp, "events.jsonl");
  fs.writeFileSync(file, JSON.stringify({ t: 1, e: "Old" }) + "\n");
  const got: string[] = [];
  const stop = progress.tailEvents(file, (ev) => got.push(ev.e), 20);
  fs.appendFileSync(file, JSON.stringify({ t: 2, e: "PreToolUse" }) + "\n" + JSON.stringify({ t: 3, e: "Stop" }) + "\n");
  await sleep(80);
  stop();
  assert.deepEqual(got, ["PreToolUse", "Stop"]);
});

test("hook script writes a short event and never the file contents", () => {
  const out = path.join(tmp, "hook-events.jsonl");
  const input = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s",
    tool_name: "Write",
    tool_input: { file_path: "C:\\p\\secret.txt", content: "TOP SECRET CONTENT" },
  });
  const r = spawnSync(process.execPath, [path.join("hooks", "progress-hook.mjs")], { input, env: { ...process.env, WSB_EVENTS: out }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const line = fs.readFileSync(out, "utf8").trim();
  const ev = JSON.parse(line);
  assert.equal(ev.e, "PreToolUse");
  assert.equal(ev.tool, "Write");
  assert.equal(ev.input.file_path, "C:\\p\\secret.txt");
  assert.ok(!line.includes("TOP SECRET"));
  // without WSB_EVENTS it does nothing and exits cleanly
  const env = { ...process.env };
  delete env.WSB_EVENTS;
  assert.equal(spawnSync(process.execPath, [path.join("hooks", "progress-hook.mjs")], { input, env }).status, 0);
});

// ---------- permission mode ----------

test("permission mode: auto by default, configurable, friendly names", async () => {
  const { parsePermissionMode, modeOf } = await import("../src/workspaces.js");
  assert.equal(modeOf(ws), "auto");
  const a = spec.buildSpec(ws, { claudeHome });
  assert.equal(a.args[a.args.indexOf("--permission-mode") + 1], "auto");
  const m = spec.buildSpec({ ...ws, permissionMode: "manual" }, { claudeHome });
  assert.equal(m.args[m.args.indexOf("--permission-mode") + 1], "manual");
  assert.equal(parsePermissionMode("Manual"), "manual");
  assert.equal(parsePermissionMode("default"), "manual");
  assert.equal(parsePermissionMode("accept-edits"), "acceptEdits");
  assert.equal(parsePermissionMode("bypassPermissions"), null);
  assert.equal(parsePermissionMode("dontAsk"), null);
});

test("mode command saves the mode and resets to default by removing it", async () => {
  const { upsertWorkspace, loadWorkspaces } = await import("../src/workspaces.js");
  const { modeCommand } = await import("../src/mode.js");
  upsertWorkspace({ ...ws, name: "modews" });
  const quiet = console.log;
  console.log = () => {};
  try {
    modeCommand("modews", "manual");
    assert.equal(loadWorkspaces().find((w) => w.name === "modews")?.permissionMode, "manual");
    modeCommand("modews", "auto");
    assert.equal(loadWorkspaces().find((w) => w.name === "modews")?.permissionMode, undefined);
    modeCommand("modews", "bypassPermissions");
    assert.equal(loadWorkspaces().find((w) => w.name === "modews")?.permissionMode, undefined);
  } finally {
    console.log = quiet;
    process.exitCode = 0;
  }
});

test("restart starts exactly one new claude (late exit of the old one is ignored)", async () => {
  const { spawn, spawned } = fakePty();
  const r = new runnerMod.WorkspaceRunner({ ...ws, name: "r4" }, runnerOpts(spawn));
  r.start();
  r.ws = { ...r.ws, permissionMode: "manual" };
  r.restart(); // kills #1; its exit arrives a moment later
  await sleep(80);
  assert.equal(spawned.length, 2, "old process exit must not trigger another start");
  assert.equal(spawned[1].args[spawned[1].args.indexOf("--permission-mode") + 1], "manual");
  assert.notEqual(r.state, "restarting");
  r.stop();
});
