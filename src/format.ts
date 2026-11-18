// Pure helpers for rendering Claude output in Discord. No Discord or SDK imports, so they are unit-testable.

export const DISCORD_LIMIT = 2000;

/** Split text into chunks that fit in one Discord message, preferring newline boundaries and keeping code fences balanced. */
export function chunkText(text: string, limit = DISCORD_LIMIT - 20): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  let openFence: string | null = null;

  while (rest.length > 0) {
    const prefix = openFence ? openFence + "\n" : "";
    const room = limit - prefix.length - 4; // leave space for a closing fence
    let piece: string;
    if (rest.length <= room) {
      piece = rest;
      rest = "";
    } else {
      let cut = rest.lastIndexOf("\n", room);
      if (cut < room * 0.5) cut = room; // no good newline: hard cut
      piece = rest.slice(0, cut);
      rest = rest.slice(cut).replace(/^\n/, "");
    }

    let body = prefix + piece;
    // Track whether this chunk ends inside a ``` block.
    const fences = piece.match(/^```.*$/gm) ?? [];
    for (const f of fences) openFence = openFence ? null : f;
    if (openFence && rest.length > 0) body += "\n```";
    chunks.push(body);
  }
  return chunks.length ? chunks : ["(empty response)"];
}

/** One short line describing a tool call, sized for a phone screen. */
export function describeTool(name: string, input: Record<string, unknown>, baseFolder?: string): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const short = (v: string, n = 60) => (v.length > n ? v.slice(0, n - 1) + "…" : v);
  // Inside the workspace: path relative to it (src/app.ts). Elsewhere: last two parts.
  const file = (p: string) => {
    const norm = (x: string) => x.replace(/\\/g, "/").replace(/\/+$/, "");
    const fp = norm(p);
    const base = baseFolder ? norm(baseFolder) : "";
    if (base && fp.toLowerCase().startsWith(base.toLowerCase() + "/")) return fp.slice(base.length + 1);
    return fp.split("/").slice(-2).join("/");
  };

  switch (name) {
    case "Read":
      return `📖 Read ${file(s(input.file_path))}`;
    case "Edit":
    case "MultiEdit":
      return `✏️ Edit ${file(s(input.file_path))}`;
    case "Write":
      return `📝 Write ${file(s(input.file_path))}`;
    case "Bash":
      return `▶️ ${short(s(input.command))}`;
    case "Glob":
    case "Grep":
      return `🔍 ${name} ${short(s(input.pattern), 40)}`;
    case "WebFetch":
    case "WebSearch":
      return `🌐 ${name} ${short(s(input.url) || s(input.query), 40)}`;
    case "TodoWrite":
      return "🗒️ Update todo list";
    default:
      return `🔧 ${name}`;
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Compact status block shown in the progress message. Keeps only the last few tool lines. */
export function renderStatus(opts: {
  state: "running" | "waiting" | "done" | "error" | "stopped";
  elapsedMs: number;
  toolLines: string[];
  costUsd?: number;
  maxLines?: number;
}): string {
  const icon = { running: "🟡 Running", waiting: "🟠 Waiting for approval", done: "🟢 Done", error: "🔴 Error", stopped: "⏹️ Stopped" }[opts.state];
  const max = opts.maxLines ?? 8;
  const lines = opts.toolLines.slice(-max);
  const hidden = opts.toolLines.length - lines.length;
  const cost = opts.costUsd !== undefined ? ` · $${opts.costUsd.toFixed(3)}` : "";
  const head = `**${icon}** · ${formatDuration(opts.elapsedMs)} · tools ${opts.toolLines.length}${cost}`;
  const body = [hidden > 0 ? `… ${hidden} earlier` : null, ...lines].filter(Boolean).join("\n");
  return body ? `${head}\n${body}` : head;
}
