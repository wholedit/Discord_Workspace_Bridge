import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkText, describeTool, renderStatus, DISCORD_LIMIT } from "../src/format.js";

test("short text stays in one chunk", () => {
  assert.deepEqual(chunkText("hello"), ["hello"]);
});

test("long text splits under the Discord limit", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i} ` + "x".repeat(30)).join("\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= DISCORD_LIMIT, `chunk too long: ${c.length}`);
  assert.equal(chunks.join("\n").replace(/\n+/g, "\n").length > 0, true);
});

test("code fences stay balanced across chunks", () => {
  const text = "intro\n```ts\n" + Array.from({ length: 200 }, (_, i) => `const a${i} = ${i};`).join("\n") + "\n```\nafter";
  const chunks = chunkText(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const fences = (c.match(/^```/gm) ?? []).length;
    assert.equal(fences % 2, 0, `unbalanced fences in chunk:\n${c.slice(0, 80)}`);
  }
});

test("tool descriptions are short and readable", () => {
  assert.equal(describeTool("Edit", { file_path: "C:\\projects\\web\\src\\Login.tsx" }), "✏️ Edit src/Login.tsx");
  assert.equal(describeTool("Bash", { command: "npm test" }), "▶️ npm test");
  assert.ok(describeTool("Bash", { command: "x".repeat(200) }).length < 70);
  assert.equal(describeTool("SomethingNew", {}), "🔧 SomethingNew");
  // relative to the workspace folder, including folders with spaces and either slash style
  const base = "C:\\projects\\my web";
  assert.equal(describeTool("Write", { file_path: "C:\\projects\\my web\\index.html" }, base), "📝 Write index.html");
  assert.equal(describeTool("Write", { file_path: "C:/projects/my web/css/style.css" }, base), "📝 Write css/style.css");
  assert.equal(describeTool("Read", { file_path: "C:\\other\\proj\\a.ts" }, base), "📖 Read proj/a.ts");
});

test("status keeps only the last lines", () => {
  const out = renderStatus({ state: "running", elapsedMs: 65_000, toolLines: Array.from({ length: 12 }, (_, i) => `t${i}`), costUsd: 0.1234 });
  assert.match(out, /Running.*1m 05s.*tools 12.*\$0\.123/);
  assert.match(out, /… 4 earlier/);
  assert.ok(!out.includes("t3\n") && out.includes("t11"));
});
