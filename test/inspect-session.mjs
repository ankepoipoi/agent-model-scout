/**
 * Inspect request/header, request/context, model/selection and one turn's
 * step timing, to find what real-outcome data exists (input size, model, time).
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const file =
  "C:/Users/atoura/.dsh/sessions/--C-Users-atoura-Documents-deepseek-harness-default-workspace--/session-b296d2b4-732a-4a05-a20f-df8b4d073184/session.v4.jsonl.zstd";

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

const events = decodeAll(readFileSync(file)).split("\n").filter((l) => l.trim().length > 0).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

const show = (type, n = 2, slice = 1000) => {
  const samples = events.filter((e) => e.type === type).slice(0, n);
  console.log(`\n===== ${type} (${events.filter((e) => e.type === type).length} total) =====`);
  for (const sample of samples) console.log(JSON.stringify(sample).slice(0, slice));
};

show("request/header", 2, 1600);
show("request/context", 1, 1600);
show("model/selection", 3, 400);

// Turn duration: pair turn/start and turn/end.
console.log("\n===== turn durations =====");
const starts = new Map();
for (const event of events) {
  if (event.type === "turn/start") starts.set(event.data.turn, event.time);
  else if (event.type === "turn/end" && starts.has(event.data.turn)) {
    const seconds = ((event.time - starts.get(event.data.turn)) / 1000).toFixed(0);
    console.log(`turn ${String(event.data.turn).padStart(2)}: ${seconds}s`);
  }
}
