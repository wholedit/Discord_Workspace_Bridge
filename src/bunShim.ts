// Windows only: the bun.exe wrapper (shim/bun-shim.cs) that strips BUN_INSPECT* before running the real Bun.
// See the comment at the top of shim/bun-shim.cs for why this is needed.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildTool, findCsc, shimDir } from "./winTools.js";

export { findCsc, shimDir };
export const shimExe = () => path.join(shimDir(), "bun.exe");

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
  buildTool("bun-shim.cs", "bun.exe");
  return { dir: shimDir(), realBun };
}
