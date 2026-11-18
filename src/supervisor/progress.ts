// Shows what Claude is doing in the workspace's Discord channel.
// Hook events (hooks/progress-hook.mjs) are appended to events.jsonl; this tails that file and keeps one quiet
// status message per task up to date: created at the first tool call, edited at most every 2 s, closed on Stop.

import fs from "node:fs";
import { describeTool, renderStatus } from "../format.js";

export type HookEvent = { t: number; e: string; tool?: string; input?: Record<string, string>; sub?: number; nt?: string };

export interface MessageSink {
  send(content: string): Promise<string>; // returns message id
  edit(id: string, content: string): Promise<void>;
}

/** Tool calls that are just the Discord plugin talking back; not worth a progress line. */
const QUIET_TOOL = /^mcp__plugin_discord_discord__/;

type Turn = { startedAt: number; lines: string[]; msgId?: string; phase: "running" | "waiting"; creating?: Promise<void> };

export class ProgressReporter {
  private turn?: Turn;
  private lastEdit = 0;
  private timer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private sink: MessageSink,
    private opts: { minEditMs?: number; tickMs?: number; now?: () => number; onError?: (e: unknown) => void; baseFolder?: string } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  handle(ev: HookEvent) {
    switch (ev.e) {
      case "UserPromptSubmit":
        // A new prompt while a previous turn is still open means that turn ended without a Stop event.
        if (this.turn) this.finish("done");
        break;
      case "PreToolUse": {
        if (!ev.tool || QUIET_TOOL.test(ev.tool)) return;
        const t = this.ensureTurn(ev.t);
        t.phase = "running";
        t.lines.push((ev.sub ? "↳ " : "") + describeTool(ev.tool, ev.input ?? {}, this.opts.baseFolder));
        this.scheduleEdit();
        break;
      }
      case "Notification":
        if (ev.nt === "permission_prompt" && this.turn) {
          this.turn.phase = "waiting";
          this.scheduleEdit(true);
        }
        break;
      case "Stop":
        this.finish("done");
        break;
      case "StopFailure":
        this.finish("error");
        break;
    }
  }

  /** Wait until all pending Discord calls are done (tests and shutdown). */
  async flush() {
    await this.chain;
  }

  close() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
  }

  private ensureTurn(t: number): Turn {
    if (this.turn) return this.turn;
    const turn: Turn = { startedAt: t, lines: [], phase: "running" };
    this.turn = turn;
    this.lastEdit = this.now();
    turn.creating = this.enqueue(async () => {
      turn.msgId = await this.sink.send(this.render(turn, turn.phase));
    });
    this.ticker = setInterval(() => this.scheduleEdit(), this.opts.tickMs ?? 15_000);
    return turn;
  }

  private render(turn: Turn, state: "running" | "waiting" | "done" | "error") {
    return renderStatus({ state, elapsedMs: this.now() - turn.startedAt, toolLines: turn.lines, maxLines: 6 });
  }

  private scheduleEdit(immediate = false) {
    if (!this.turn || this.timer) return;
    const wait = immediate ? 0 : Math.max(0, (this.opts.minEditMs ?? 2000) - (this.now() - this.lastEdit));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const turn = this.turn;
      if (!turn) return;
      this.lastEdit = this.now();
      const content = this.render(turn, turn.phase);
      this.enqueue(async () => {
        await turn.creating;
        if (turn.msgId) await this.sink.edit(turn.msgId, content);
      });
    }, wait);
  }

  private finish(state: "done" | "error") {
    const turn = this.turn;
    if (!turn) return; // no tools were used: nothing to close
    this.turn = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearInterval(this.ticker);
    const content = this.render(turn, state);
    this.enqueue(async () => {
      await turn.creating;
      if (turn.msgId) await this.sink.edit(turn.msgId, content);
    });
  }

  private enqueue(fn: () => Promise<void>) {
    const p = this.chain.then(fn).catch((e) => this.opts.onError?.(e));
    this.chain = p;
    return p;
  }
}

/** Follow a JSON-lines file from its current end, calling onEvent for each new line. Polling works reliably on Windows. */
export function tailEvents(file: string, onEvent: (ev: HookEvent) => void, intervalMs = 500): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let rest = "";
  const timer = setInterval(() => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < offset) offset = 0; // file was truncated
    if (size === offset) return;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    offset = size;
    const lines = (rest + buf.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        onEvent(JSON.parse(l));
      } catch {}
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
