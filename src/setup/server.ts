// `npm run setup`: a local web page that walks through connecting bots, channels and folders.
// Safety: listens on 127.0.0.1 only, every API call needs the random key from the URL that was opened,
// the Host and Origin headers must match (blocks other websites and DNS-rebinding tricks), and the server
// shuts down when you click "Finish" or after 20 minutes without the page open.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runChecks } from "../check.js";
import { loadWorkspaces, modeOf } from "../workspaces.js";
import { loadManager } from "../manager/config.js";
import { SetupApi, SetupError, errorMessage } from "./api.js";
import { autostartStatus, disableAutostart, enableAutostart, startInBackground, waitForSupervisor, type AutostartStatus } from "../autostart.js";
import { logFile, readStatus, stopSupervisor, supervisorPid } from "../supervisor/control.js";
import { openTrustWindow } from "../trust.js";

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "static");
const FILES: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const IDLE_MS = 20 * 60_000;

/** Native "choose a folder" dialog on the PC (the person doing setup is sitting at it). */
export function browseFolder(): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const ps = [
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Workspace folder'",
    "$d.ShowNewFolderButton = $true",
    "$f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }",
    "if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }",
  ].join("; ");
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", ps], { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString("utf8")));
    p.on("error", () => resolve(null));
    p.on("exit", () => resolve(out.trim() || null));
  });
}

export function startSetupServer(opts: { port?: number; open?: boolean; onClose?: () => void } = {}) {
  const api = new SetupApi();
  const key = randomBytes(24).toString("base64url");
  const keyBuf = Buffer.from(key);
  let lastSeen = Date.now();
  let port = 0;
  let autostartCache: { at: number; v: AutostartStatus } | null = null;
  const autostart = () => {
    if (!autostartCache || Date.now() - autostartCache.at > 15_000) autostartCache = { at: Date.now(), v: autostartStatus() };
    return autostartCache.v;
  };
  const trusting = new Set<string>();

  const state = () => {
    const pid = supervisorPid();
    const status = pid ? readStatus() : null;
    const live = new Map<string, any>((status?.workspaces ?? []).map((w: any) => [w.name, w]));
    const mgr = loadManager();
    return {
      platform: process.platform,
      workspaces: loadWorkspaces().map((w) => {
        const l = live.get(w.name);
        return {
          name: w.name,
          channelName: w.channelName,
          folder: w.folder,
          botName: w.botName,
          mode: modeOf(w),
          state: l?.state ?? null,
          detail: l?.detail ?? "",
          plugin: l?.plugin ?? null,
          trusting: trusting.has(w.name),
        };
      }),
      manager: mgr ? { botName: mgr.botName, channelName: mgr.channelName, state: (status as any)?.manager ?? null } : null,
      supervisor: { running: !!pid, pid, awake: status?.awake ?? null, log: logFile() },
      autostart: autostart(),
    };
  };

  const routes: Record<string, (b: any) => unknown> = {
    state: () => state(),
    checks: () => runChecks(),
    "bot/token": (b) => api.token(b.kind === "manager" ? "manager" : "workspace", b.token),
    "bot/settings": (b) => api.botSettings(b.draft),
    "bot/guilds": (b) => api.guilds(b.draft),
    "bot/channels": (b) => api.channels(b.draft, b.guildId),
    "folder/browse": async () => ({ folder: await browseFolder() }),
    "folder/check": (b) => api.checkFolder(b.folder, b.name),
    "workspace/save": (b) => api.saveWorkspace(b),
    "workspace/remove": (b) => api.removeWorkspace(b.name),
    "manager/save": (b) => api.saveManager(b),
    "manager/remove": () => api.removeManager(),
    trust: (b) => {
      const ws = loadWorkspaces().find((w) => w.name === b.name);
      if (!ws) throw new SetupError(`No workspace named "${b.name}".`);
      if (trusting.has(ws.name)) return { ok: true };
      trusting.add(ws.name);
      openTrustWindow(ws)
        .catch(() => {})
        .finally(() => trusting.delete(ws.name));
      return { ok: true };
    },
    "supervisor/start": async () => {
      const r = startInBackground();
      if (r.ok && !supervisorPid()) await waitForSupervisor();
      return r;
    },
    "supervisor/stop": async () => ({ ok: await stopSupervisor() }),
    "supervisor/restart": async () => {
      if (!(await stopSupervisor())) return { ok: false, detail: "The supervisor did not stop in 30 seconds." };
      const r = startInBackground();
      if (r.ok) await waitForSupervisor();
      return r;
    },
    autostart: (b) => {
      autostartCache = null;
      return b.on ? enableAutostart() : disableAutostart();
    },
    close: () => {
      setTimeout(close, 200);
      return { ok: true };
    },
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    // Only this exact host name: a web page on another site that points its own domain at 127.0.0.1 is refused.
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && FILES[url.pathname]) {
      if (url.pathname === "/" && url.searchParams.get("k") !== key) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Open the link printed by `npm run setup`.");
        return;
      }
      const file = FILES[url.pathname];
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)],
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(fs.readFileSync(path.join(STATIC, file)));
      return;
    }
    if (req.method !== "POST" || !url.pathname.startsWith("/api/")) {
      res.writeHead(404).end();
      return;
    }
    const origin = req.headers.origin;
    const given = Buffer.from(String(req.headers["x-setup-key"] ?? ""));
    if ((origin && origin !== `http://127.0.0.1:${port}`) || given.length !== keyBuf.length || !timingSafeEqual(given, keyBuf)) {
      send(res, 403, { error: "Not allowed. Reopen the link printed by npm run setup." });
      return;
    }
    const route = routes[url.pathname.slice(5)];
    if (!route) return send(res, 404, { error: "Unknown action." });
    lastSeen = Date.now();
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64_000) return send(res, 413, { error: "Too large." });
    }
    try {
      const body = raw ? JSON.parse(raw) : {};
      send(res, 200, await route(body));
    } catch (e) {
      send(res, e instanceof SetupError ? 400 : 500, { error: errorMessage(e) });
    }
  });

  const idle = setInterval(() => {
    if (Date.now() - lastSeen > IDLE_MS) {
      console.log("Setup page idle for 20 minutes; closing it. Run npm run setup to open it again.");
      close();
    }
  }, 30_000);

  function close() {
    clearInterval(idle);
    api.clear();
    server.close();
    server.closeAllConnections?.();
    opts.onClose?.();
  }

  return new Promise<{ url: string; port: number; close: () => void }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/?k=${key}`;
      if (opts.open !== false) openBrowser(url);
      resolve({ url, port, close });
    });
  });
}

export function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

export async function setupCommand() {
  const s = await startSetupServer({
    onClose: () => {
      console.log("Setup page closed.");
      process.exit(0);
    },
  });
  console.log("Setup page is open in your browser. If it didn't open, paste this link into the browser on this PC:");
  console.log(`  ${s.url}`);
  console.log("Close it with the Finish button on the page (or Ctrl+C here).");
  process.on("SIGINT", () => s.close());
}
