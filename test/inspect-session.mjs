/**
 * Show the LAST scout command lifecycle pair and everything logged after the
 * app restart, to see what the bare `/scout` actually returned.
 */
import { readFileSync, statSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const file =
  "C:/Users/atoura/.dsh/sessions/--C-Users-atoura-Documents-deepseek-harness-default-workspace--/session-b296d2b4-732a-4a05-a20f-df8b4d073184/session.v4.jsonl.zstd";
const buf = readFileSync(file);

function decodeAll(buffer) {
  const chunks = [];
  let offset = 0;
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  while (offset < buffer.length) {
    let out;
    try { out = zstdDecompressSync(buffer.subarray(offset)); } catch { break; }
    if (out.length === 0) break;
    chunks.push(out);
    let next = -1;
    for (let i = offset + 4; i <= buffer.length - 4; i += 1) {
      if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) { next = i; break; }
    }
    if (next === -1) break;
    offset = next;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const lines = decodeAll(buf).split("\n").filter((l) => l.trim().length > 0);
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };

const commandEvents = lines.map(parse).filter((e) => e?.type === "command/run" || e?.type === "command/done");
console.log(`command events total: ${commandEvents.length}`);
console.log("\n--- last 4 command events ---");
for (const event of commandEvents.slice(-4)) {
  console.log(JSON.stringify(event).slice(0, 900));
}

// Restart was ~10:55:38 local = 1794452138000 ms.
const cutoff = 1794452138000;
const after = lines.map(parse).filter((e) => e && e.time > cutoff && e.type !== "tool/result" && e.type !== "assistant/message" && e.type !== "job/registered");
console.log(`\n--- non-tool events after restart (${after.length}) ---`);
for (const event of after.slice(-15)) {
  console.log(JSON.stringify(event).slice(0, 600));
}
