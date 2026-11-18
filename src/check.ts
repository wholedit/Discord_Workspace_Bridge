// Environment check: everything the official Discord channel plugin needs on this PC.
// Reads only status output from the claude CLI (never credentials).

import { spawnSync } from "node:child_process";
import { PLUGIN_ID } from "./workspaces.js";
import { pingDiscord } from "./discordApi.js";
import { cleanEnv } from "./supervisor/spec.js";

export type CheckResult = { name: string; ok: boolean; detail: string; fix?: string };

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  // On Windows, go through the shell so .cmd/.exe shims on PATH resolve. Args are fixed strings, never user input.
  // cleanEnv: a debugger variable inherited from the Claude app's terminal makes claude itself fail to start.
  const env = cleanEnv();
  const r =
    process.platform === "win32"
      ? spawnSync([cmd, ...args].join(" "), { encoding: "utf8", shell: true, timeout: 60_000, env })
      : spawnSync(cmd, args, { encoding: "utf8", timeout: 60_000, env });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") };
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

export async function runChecks(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const [major, minor] = process.versions.node.split(".").map(Number);
  results.push({
    name: "Node.js 22.15+",
    ok: major > 22 || (major === 22 && minor >= 15),
    detail: `v${process.versions.node}`,
    fix: "Install the current Node.js LTS from https://nodejs.org",
  });

  const net = await pingDiscord();
  results.push({ name: "Discord reachable over HTTPS", ok: net.ok, detail: net.ok ? net.detail : "failed", fix: net.ok ? undefined : net.detail });

  const ver = run("claude", ["--version"]);
  results.push({
    name: "Claude Code installed",
    ok: ver.ok,
    detail: ver.ok ? ver.out.trim().split("\n")[0] : "claude command not found",
    fix: "Install Claude Code: https://code.claude.com/docs/en/quickstart",
  });
  if (!ver.ok) return results;

  const auth = parseAuthStatus(run("claude", ["auth", "status"]).out);
  results.push({
    name: "Signed in to Claude",
    ok: auth.loggedIn,
    detail: auth.loggedIn ? `${auth.method ?? "?"}${auth.plan ? ` (${auth.plan})` : ""}` : "not signed in",
    fix: "Run `claude` once in a terminal and sign in with your Claude account (/login).",
  });

  const bun = run("bun", ["--version"]);
  results.push({
    name: "Bun installed (the official plugin runs on Bun)",
    ok: bun.ok,
    detail: bun.ok ? `v${bun.out.trim()}` : "bun command not found",
    fix:
      process.platform === "win32"
        ? 'Install Bun: powershell -c "irm bun.sh/install.ps1 | iex"  (then open a new terminal)'
        : "Install Bun: curl -fsSL https://bun.sh/install | bash  (then open a new terminal)",
  });

  const plugin = parsePluginList(run("claude", ["plugin", "list", "--json"]).out);
  results.push({
    name: "Official Discord plugin installed",
    ok: plugin.installed && plugin.enabled,
    detail: plugin.installed ? (plugin.enabled ? "installed, enabled" : "installed but disabled") : "not installed",
    fix: plugin.installed
      ? `claude plugin enable ${PLUGIN_ID}`
      : `In a terminal run \`claude\`, then type: /plugin install ${PLUGIN_ID}  (choose user scope). If the marketplace is missing: /plugin marketplace add anthropics/claude-plugins-official`,
  });

  if (process.platform === "win32") {
    const { findCsc } = await import("./bunShim.js");
    const csc = findCsc();
    results.push({
      name: "Bun wrapper can be built (.NET csc.exe)",
      ok: !!csc,
      detail: csc ? "csc.exe found" : "csc.exe not found",
      fix: "Enable .NET Framework 4.x (Windows Features). It is built into Windows 10/11 by default.",
    });
    const wt = run("where", ["wt"]);
    results.push({ name: "Windows Terminal", ok: wt.ok, detail: wt.ok ? "found" : "not found", fix: "Install Windows Terminal from the Microsoft Store." });
  }
  return results;
}
