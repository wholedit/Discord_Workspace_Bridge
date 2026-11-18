// Environment check: everything the official Discord channel plugin needs on this PC.
// Reads only status output from the claude CLI (never credentials).
// Each failed item carries step-by-step fixes (text, a command to copy, or a link) for the setup page and the CLI.

import { spawn, spawnSync } from "node:child_process";
import { PLUGIN_ID } from "./workspaces.js";
import { pingDiscord } from "./discordApi.js";
import { cleanEnv } from "./supervisor/spec.js";

export type FixStep = { text: string; cmd?: string; link?: { url: string; label: string } };
export type CheckResult = {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  /** Not needed for normal use; a miss is shown as "optional", not as a problem. */
  optional?: boolean;
  /** Can't be checked until an earlier item is fixed. */
  blocked?: boolean;
  steps?: FixStep[];
  /** One-line version of steps (CLI, older callers). */
  fix?: string;
};

const NEW_TERMINAL: FixStep = { text: "설치가 끝나면 '다시 점검'을 누르세요. 그래도 안 보이면 설정 페이지를 끄고 새 터미널에서 npm run setup을 다시 실행하세요." };

/**
 * PATH as Windows has it now (machine + user, from the registry) plus ours. Programs installed after this process
 * started (Bun, Claude Code) are found without restarting the setup page.
 */
export function freshPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  if (process.platform !== "win32") return env[key];
  const read = (hive: string) => {
    const r = spawnSync("reg", ["query", hive, "/v", "Path"], { encoding: "utf8", windowsHide: true });
    const m = (r.stdout ?? "").match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return m ? m[1].trim().replace(/%([^%]+)%/g, (s, v) => env[Object.keys(env).find((k) => k.toUpperCase() === v.toUpperCase()) ?? ""] ?? s) : "";
  };
  const parts = [env[key] ?? "", read("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"), read("HKCU\\Environment")]
    .join(";")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return parts.filter((p) => !seen.has(p.toLowerCase()) && seen.add(p.toLowerCase())).join(";");
}

/** cleanEnv() with the fresh PATH: for anything we start (checks, background supervisor). */
export function freshEnv(): NodeJS.ProcessEnv {
  const env = cleanEnv(); // a debugger variable inherited from the Claude app's terminal makes claude itself fail to start
  const fp = freshPath(env);
  if (fp) env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"] = fp;
  return env;
}

/** Async so the setup page's server stays responsive while the checks run. */
function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; out: string }> {
  // On Windows, go through the shell so .cmd/.exe shims on PATH resolve. Args are fixed strings, never user input.
  return new Promise((resolve) => {
    const p =
      process.platform === "win32"
        ? spawn([cmd, ...args].join(" "), { shell: true, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] }); // stdin closed: claude waits for input on an open pipe
    let out = "";
    p.stdout?.on("data", (d) => (out += d));
    p.stderr?.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill(), 60_000);
    p.on("error", () => (clearTimeout(timer), resolve({ ok: false, out })));
    p.on("close", (code) => (clearTimeout(timer), resolve({ ok: code === 0, out })));
  });
}

/** Parse `claude auth status` JSON. Exported for tests. */
export function parseAuthStatus(out: string): { loggedIn: boolean; method?: string; plan?: string } {
  try {
    const j = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
    return { loggedIn: !!j.loggedIn, method: j.authMethod, plan: j.subscriptionType };
  } catch {
    return { loggedIn: false };
  }
}

/** Parse `claude plugin list --json`. Exported for tests. */
export function parsePluginList(out: string, id = PLUGIN_ID): { installed: boolean; enabled: boolean } {
  try {
    const list = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)) as { id: string; enabled?: boolean }[];
    const p = list.find((x) => x.id === id);
    return { installed: !!p, enabled: !!p?.enabled };
  } catch {
    return { installed: false, enabled: false };
  }
}

export function fixLine(steps: FixStep[] = []): string {
  return steps.map((s) => [s.text, s.cmd, s.link?.url].filter(Boolean).join(" ")).join(" / ");
}

const win = process.platform === "win32";

export const FIXES = {
  node: (): FixStep[] => [
    { text: "Node.js LTS 버전을 설치하세요.", link: { url: "https://nodejs.org", label: "nodejs.org 열기" } },
    { text: "설치한 뒤 이 설정 페이지를 끄고, 새 터미널에서 다시 실행하세요.", cmd: "npm run setup" },
  ],
  discord: (detail: string): FixStep[] => [
    { text: detail },
    { text: "인터넷 연결, 프록시, 방화벽을 확인하세요. 회사망에서는 반드시 npm run … 명령으로 실행해야 Windows 인증서를 씁니다." },
  ],
  claude: (): FixStep[] => [
    win
      ? { text: "PowerShell을 열고 이 명령으로 Claude Code를 설치하세요.", cmd: "irm https://claude.ai/install.ps1 | iex" }
      : { text: "터미널에서 이 명령으로 Claude Code를 설치하세요.", cmd: "curl -fsSL https://claude.ai/install.sh | bash" },
    { text: "다른 설치 방법은 공식 안내를 보세요.", link: { url: "https://code.claude.com/docs/en/quickstart", label: "설치 안내 열기" } },
    NEW_TERMINAL,
  ],
  login: (): FixStep[] => [
    { text: "새 터미널에서 claude를 실행하고, 안내에 따라 내 Claude 계정(Pro/Max)으로 로그인하세요. 로그인 화면이 안 나오면 claude 안에서 /login을 입력합니다.", cmd: "claude" },
    { text: "로그인했으면 claude를 종료(/exit)하고 '다시 점검'을 누르세요." },
  ],
  bun: (): FixStep[] => [
    win
      ? { text: "PowerShell에서 Bun을 설치하세요. 공식 디스코드 플러그인이 Bun으로 실행됩니다.", cmd: 'powershell -c "irm bun.sh/install.ps1 | iex"' }
      : { text: "터미널에서 Bun을 설치하세요. 공식 디스코드 플러그인이 Bun으로 실행됩니다.", cmd: "curl -fsSL https://bun.sh/install | bash" },
    NEW_TERMINAL,
  ],
  pluginInstall: (): FixStep[] => [
    { text: "터미널에서 공식 디스코드 플러그인을 설치하세요.", cmd: `claude plugin install ${PLUGIN_ID}` },
    { text: "'marketplace not found' 오류가 나면 이것을 먼저 실행한 뒤 위 명령을 다시 실행하세요.", cmd: "claude plugin marketplace add anthropics/claude-plugins-official" },
    { text: "/discord:configure는 쓰지 마세요. 토큰은 이 설정 페이지가 워크스페이스별로 따로 저장합니다." },
  ],
  pluginEnable: (): FixStep[] => [{ text: "플러그인이 꺼져 있습니다. 이 명령으로 켜세요.", cmd: `claude plugin enable ${PLUGIN_ID}` }],
  csc: (): FixStep[] => [
    { text: "Windows 10/11에는 .NET Framework 4.x가 기본으로 들어 있습니다. 없다면 Windows 업데이트를 하거나 .NET Framework 4.8을 설치하세요.", link: { url: "https://dotnet.microsoft.com/download/dotnet-framework/net48", label: ".NET Framework 4.8 다운로드" } },
    { text: "회사 PC에서 보안 정책으로 막혀 있다면 IT 담당자에게 문의하세요." },
  ],
  wt: (): FixStep[] => [
    { text: "디버깅용 창 모드(npm run launch)에서만 씁니다. 필요하면 Microsoft Store에서 Windows Terminal을 설치하세요.", link: { url: "https://aka.ms/terminal", label: "Microsoft Store 열기" } },
  ],
};

function item(r: Omit<CheckResult, "fix">): CheckResult {
  return r.ok ? { ...r, steps: undefined } : { ...r, fix: fixLine(r.steps) };
}

const BLOCKED_BY_CLAUDE = "Claude Code를 먼저 설치하세요";

export async function runChecks(): Promise<CheckResult[]> {
  const env = freshEnv();

  // Start the slow commands together (each claude call can take several seconds).
  const pending = {
    ver: run("claude", ["--version"], env),
    auth: run("claude", ["auth", "status"], env),
    bun: run("bun", ["--version"], env),
    plugin: run("claude", ["plugin", "list", "--json"], env),
    wt: win ? run("where", ["wt"], env) : Promise.resolve({ ok: true, out: "" }),
  };
  const results: CheckResult[] = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  results.push(item({ id: "node", name: "Node.js 22.15 이상", ok: major > 22 || (major === 22 && minor >= 15), detail: `v${process.versions.node}`, steps: FIXES.node() }));

  const net = await pingDiscord();
  results.push(item({ id: "discord", name: "디스코드 연결 (HTTPS)", ok: net.ok, detail: net.ok ? "연결됨" : "연결 안 됨", steps: FIXES.discord(net.detail) }));

  const ver = await pending.ver;
  results.push(item({ id: "claude", name: "Claude Code 설치", ok: ver.ok, detail: ver.ok ? ver.out.trim().split("\n")[0] : "claude 명령을 찾을 수 없음", steps: FIXES.claude() }));

  if (ver.ok) {
    const auth = parseAuthStatus((await pending.auth).out);
    results.push(
      item({ id: "login", name: "Claude 로그인", ok: auth.loggedIn, detail: auth.loggedIn ? `${auth.method ?? "?"}${auth.plan ? ` (${auth.plan})` : ""}` : "로그인 안 됨", steps: FIXES.login() }),
    );
  } else results.push({ id: "login", name: "Claude 로그인", ok: false, blocked: true, detail: BLOCKED_BY_CLAUDE });

  const bun = await pending.bun;
  results.push(item({ id: "bun", name: "Bun 설치 (공식 플러그인이 Bun으로 실행됨)", ok: bun.ok, detail: bun.ok ? `v${bun.out.trim()}` : "bun 명령을 찾을 수 없음", steps: FIXES.bun() }));

  if (ver.ok) {
    const plugin = parsePluginList((await pending.plugin).out);
    results.push(
      item({
        id: "plugin",
        name: "공식 디스코드 플러그인",
        ok: plugin.installed && plugin.enabled,
        detail: plugin.installed ? (plugin.enabled ? "설치됨, 켜짐" : "설치됨, 꺼짐") : "설치 안 됨",
        steps: plugin.installed ? FIXES.pluginEnable() : FIXES.pluginInstall(),
      }),
    );
  } else results.push({ id: "plugin", name: "공식 디스코드 플러그인", ok: false, blocked: true, detail: BLOCKED_BY_CLAUDE });

  if (win) {
    const { findCsc } = await import("./bunShim.js");
    const csc = findCsc();
    results.push(item({ id: "csc", name: "도우미 프로그램 빌드 도구 (.NET csc.exe)", ok: !!csc, detail: csc ? "있음" : "없음", steps: FIXES.csc() }));
    const wt = await pending.wt;
    results.push(item({ id: "wt", name: "Windows Terminal (선택)", ok: wt.ok, optional: true, detail: wt.ok ? "있음" : "없음 (필수 아님)", steps: FIXES.wt() }));
  }
  return results;
}

/** Items that still need fixing (blocked ones count; optional ones don't). */
export const problems = (results: CheckResult[]) => results.filter((r) => !r.ok && !r.optional);
