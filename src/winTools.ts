// Windows only: small helper programs compiled from shim/*.cs with the C# compiler built into Windows
// (.NET Framework 4.x), so nothing extra has to be downloaded.
//   bun.exe       strips BUN_INSPECT* before running the real Bun (see shim/bun-shim.cs)
//   awake.exe     keeps the PC from sleeping while the supervisor runs
// (Background start does NOT use a helper exe: security software such as Cortex XDR blocks unsigned
// windowless launchers. Node starts the supervisor hidden instead; see src/autostart.ts.)

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homeDir } from "./workspaces.js";

export const SHIM_SOURCES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "shim");
const CSC_CANDIDATES = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

export const shimDir = () => path.join(homeDir(), "shim");

export function findCsc(): string | null {
  return CSC_CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** Compile shim/<source> to ~/.workspace-bridge/shim/<exe> if it is missing or older than its source. Returns the exe path. */
export function buildTool(source: string, exe: string, opts: { windowless?: boolean } = {}): string {
  const src = path.join(SHIM_SOURCES, source);
  const out = path.join(shimDir(), exe);
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) return out;
  const csc = findCsc();
  if (!csc) throw new Error(`The .NET Framework C# compiler (csc.exe) was not found, so ${exe} cannot be built.`);
  fs.mkdirSync(shimDir(), { recursive: true });
  const args = ["/nologo", "/optimize", ...(opts.windowless ? ["/target:winexe"] : []), `/out:${out}`, src];
  const r = spawnSync(csc, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Building ${exe} failed:\n${r.stdout}${r.stderr}`);
  return out;
}

export const awakeExe = () => buildTool("awake.cs", "awake.exe", { windowless: true });
