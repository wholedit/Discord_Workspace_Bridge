// Windows only: build the bun.exe wrapper (shim/bun-shim.cs) that strips BUN_INSPECT* before running the real Bun.
// See the comment at the top of shim/bun-shim.cs for why this is needed.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir } from "./workspaces.js";

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shim", "bun-shim.cs");
const CSC_CANDIDATES = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

export const shimDir = () => path.join(homeDir(), "shim");
export const shimExe = () => path.join(shimDir(), "bun.exe");

export function findCsc(): string | null {
  return CSC_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** The real bun.exe on PATH, ignoring our own wrapper folder. */
export function findRealBun(): string | null {
  const r = spawnSync("where", ["bun"], { encoding: "utf8" });
  const own = path.resolve(shimDir()).toLowerCase();
  const hit = (r.stdout ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /\.exe$/i.test(s))
    .find((s) => path.dirname(path.resolve(s)).toLowerCase() !== own);
  if (hit) return hit;
  const fallback = path.join(process.env.USERPROFILE ?? "", ".bun", "bin", "bun.exe");
  return fs.existsSync(fallback) ? fallback : null;
}

/** Build the wrapper if it is missing or older than its source. Returns its folder and the real Bun path. */
export function ensureBunShim(): { dir: string; realBun: string } {
  const realBun = findRealBun();
  if (!realBun) throw new Error("bun.exe not found. Install Bun first (npm run check shows how).");
  const exe = shimExe();
  const fresh = fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
  if (!fresh) {
    const csc = findCsc();
    if (!csc) throw new Error("The .NET Framework C# compiler (csc.exe) was not found, so the bun wrapper cannot be built.");
    fs.mkdirSync(shimDir(), { recursive: true });
    const r = spawnSync(csc, ["/nologo", "/optimize", `/out:${exe}`, SOURCE], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Building the bun wrapper failed:\n${r.stdout}${r.stderr}`);
  }
  return { dir: shimDir(), realBun };
}
