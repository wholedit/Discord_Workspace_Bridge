// One-time folder trust. claude asks "Do you trust the files in this folder?" the first time it opens a folder.
// We never answer that for you: this opens claude in a normal window in that folder so you can answer it yourself.
// When the window closes, the supervisor (if running) restarts that workspace.

import { spawn } from "node:child_process";
import type { Workspace } from "./workspaces.js";
import { cleanEnv, resolveClaude } from "./supervisor/spec.js";
import { sendRequest, supervisorPid } from "./supervisor/control.js";

export const TRUST_STEPS = [
  'Choose "Yes, I trust this folder" in the new window.',
  "Then type /exit (or close the window).",
];

/** Opens the window and resolves when it is closed. */
export function openTrustWindow(ws: Workspace): Promise<void> {
  const claude = resolveClaude();
  const env = { ...cleanEnv(), NODE_USE_SYSTEM_CA: "1" };
  return new Promise((resolve, reject) => {
    // detached on Windows = its own console window, so you can type in it.
    const child = spawn(claude.file, claude.prefixArgs, { cwd: ws.folder, env, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("exit", () => {
      if (supervisorPid()) sendRequest({ kind: "restart", name: ws.name });
      resolve();
    });
  });
}

export async function trustCommand(ws: Workspace) {
  console.log(`Opening claude in ${ws.folder}`);
  TRUST_STEPS.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  await openTrustWindow(ws);
  console.log(supervisorPid() ? `✓ Done. The supervisor will restart "${ws.name}" in a few seconds.` : "✓ Done. Start the workspaces with: npm start");
}
