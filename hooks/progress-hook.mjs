// Claude Code hook (async): append a small event line for the workspace-bridge supervisor.
// Runs on UserPromptSubmit, PreToolUse, Notification(permission_prompt), Stop and StopFailure.
// Plain JavaScript on purpose: it starts in a few dozen milliseconds and never touches the network.
// Only short summaries are written (file names, first part of a command), never file contents.

import fs from "node:fs";

const out = process.env.WSB_EVENTS;
if (!out) process.exit(0);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(raw);
    const i = j.tool_input ?? {};
    const pick = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : undefined);
    const input = {
      file_path: pick(i.file_path ?? i.notebook_path),
      command: pick(i.command),
      pattern: pick(i.pattern, 80),
      url: pick(i.url, 120),
      query: pick(i.query, 80),
      description: pick(i.description, 120),
    };
    for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k];
    const ev = { t: Date.now(), e: j.hook_event_name, tool: j.tool_name, input, sub: j.agent_id ? 1 : 0, nt: j.notification_type };
    fs.appendFileSync(out, JSON.stringify(ev) + "\n");
  } catch {
    // never break the session because of progress reporting
  }
});
