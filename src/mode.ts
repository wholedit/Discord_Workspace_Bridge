// npm run mode -- <workspace> [auto|manual|acceptEdits|plan]
// Shows or changes a workspace's permission mode. A running supervisor notices the change within a few seconds
// and restarts just that workspace (the conversation continues via its session ID).

import fs from "node:fs";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, loadWorkspaces, modeOf, parsePermissionMode, saveWorkspaces } from "./workspaces.js";
import { statusFile } from "./supervisor/index.js";

const HELP: Record<string, string> = {
  auto: "a safety classifier approves low-risk actions; risky ones ask by DM (default)",
  manual: "every file edit and command asks for approval by DM",
  acceptEdits: "file edits are approved automatically; commands ask by DM",
  plan: "Claude only plans and changes nothing",
};

function supervisorRunning(): boolean {
  try {
    const pid = JSON.parse(fs.readFileSync(statusFile(), "utf8")).supervisorPid;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function modeCommand(name?: string, value?: string) {
  const list = loadWorkspaces();
  const options = PERMISSION_MODES.map((m) => `  ${m.padEnd(12)} ${HELP[m]}`).join("\n");
  if (!name) {
    for (const w of list) console.log(`${w.name.padEnd(14)} ${modeOf(w)}`);
    console.log(`\nChange with: npm run mode -- <workspace> <mode>\n${options}`);
    return;
  }
  const ws = list.find((w) => w.name === name);
  if (!ws) {
    console.log(`No workspace named "${name}". See: npm run list`);
    process.exitCode = 1;
    return;
  }
  if (!value) {
    console.log(`${ws.name}: ${modeOf(ws)}${ws.permissionMode ? "" : " (default)"}\n\n${options}`);
    return;
  }
  const mode = parsePermissionMode(value);
  if (!mode) {
    console.log(`Unknown mode "${value}". Choose one of:\n${options}`);
    process.exitCode = 1;
    return;
  }
  if (mode === modeOf(ws)) {
    console.log(`${ws.name} is already in ${mode} mode.`);
    return;
  }
  if (mode === DEFAULT_PERMISSION_MODE) delete ws.permissionMode;
  else ws.permissionMode = mode;
  saveWorkspaces(list);
  console.log(`${ws.name}: permission mode set to ${mode} — ${HELP[mode]}.`);
  console.log(
    supervisorRunning()
      ? `The running supervisor will restart ${ws.name} within a few seconds to apply it. The conversation continues; a task in progress is interrupted.`
      : "It applies the next time you run npm start (or npm run launch).",
  );
}
