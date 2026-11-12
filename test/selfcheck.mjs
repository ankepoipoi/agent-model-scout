/**
 * Self-check: does scout's quality score carry signal, or is it noise?
 *
 * Mines real session logs for every `/scout` run and answers:
 *   1. Score stability — same task, same model, different runs: how much does
 *      Q drift? Compared against between-model spread on the same run. If
 *      within-model drift >= between-model spread, the ranking is a coin flip.
 *   2. Probe reliability — failure rate per provider (e.g. "no text" probes).
 *   3. Dispatch tracking — closed-loop runs (pick -> followup) with the actual
 *      turn's step count and duration vs. what the plan predicted.
 *
 * Usage: node test/selfcheck.mjs [sessions-root]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const root = process.argv[2] ?? "C:/Users/atoura/.dsh/sessions";

// ---------- decode every session log (multi-frame zstd) ----------
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

const files = [];
(function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.startsWith("session") && entry.name.endsWith(".zstd")) files.push(full);
  }
})(root);

const events = [];
let fileIndex = 0;
for (const path of files) {
  fileIndex += 1;
  try {
    for (const line of decodeAll(readFileSync(path)).split("\n")) {
      if (!line.trim()) continue;
      try { events.push({ ...JSON.parse(line), file: fileIndex }); } catch { /* torn tail line */ }
    }
  } catch { /* undecodable file */ }
}
// Epoch time is the only key monotonic across files: seq and turn numbers
// both restart per session, so they must never order or key anything alone.
events.sort((a, b) => a.time - b.time);

// ---------- collect scout runs ----------
const dones = new Map(); // commandId -> report text
const runs = [];
for (const event of events) {
  if (event.type === "command/run" && event.data?.name === "scout" && !/\s--dry\b/.test(event.data.args ?? "")) {
    runs.push({ id: event.data.commandId, time: event.time, args: (event.data.args ?? "").trim() });
  } else if (event.type === "command/done" && event.data?.text) {
    dones.set(event.data.commandId, event.data.text);
  }
}

const ROW = /^\s*\d+\s+(\S+)\s+([\d.]+)\s+([\d.]+)k?\s+(-?[\d.]+)\s+(?:\d+ms|[\d.]+s)\s+(.*)$/;
for (const run of runs) {
  const report = dones.get(run.id);
  if (!report) continue;
  run.task = (report.match(/^task: (.+)$/m) ?? [])[1] ?? run.args;
  run.rows = [];
  for (const line of report.split("\n")) {
    const match = line.match(ROW);
    if (!match) continue;
    const steps = Number((match[5].match(/(\d+) steps?/) ?? [])[1] ?? 0);
    const failed = /failed|no text/i.test(match[5]) || (Number(match[2]) === 0 && steps === 0);
    run.rows.push({
      route: match[1],
      quality: Number(match[2]),
      estTokensK: match[3],
      utility: Number(match[4]),
      steps,
      note: match[5],
      failed,
    });
  }
  run.winner = run.rows.filter((row) => !row.failed).sort((a, b) => b.utility - a.utility)[0];
}

const probed = runs.filter((run) => run.rows?.length > 0);
console.log(`scout runs found: ${probed.length} (of ${runs.length} non-dry; logs scanned: ${files.length})\n`);

// ---------- 1. score stability on repeated tasks ----------
const groups = new Map();
for (const run of probed) {
  const key = run.task.replace(/\s+/g, "").toLowerCase();
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(run);
}
const repeated = [...groups.values()].filter((group) => group.length > 1);

console.log("=== 1. score stability (same task, multiple runs) ===");
if (repeated.length === 0) console.log("(no exact repeated task yet — run /scout twice on the same task to enable this check)");
for (const group of repeated) {
  console.log(`\ntask: ${group[0].task}`);
  const models = [...new Set(group.flatMap((run) => run.rows.filter((row) => !row.failed).map((row) => row.route)))];
  const within = [];
  for (const model of models) {
    const scores = group.flatMap((run) => run.rows.filter((row) => row.route === model && !row.failed).map((row) => row.quality));
    if (scores.length >= 2) {
      const drift = Math.max(...scores) - Math.min(...scores);
      within.push(drift);
      console.log(`  ${model.padEnd(34)} Q across runs: ${scores.map((s) => s.toFixed(2)).join(" -> ")}  drift ${drift.toFixed(2)}`);
    } else if (scores.length === 1) {
      console.log(`  ${model.padEnd(34)} Q ${scores[0].toFixed(2)} (probed once)`);
    }
  }
  for (const run of group) {
    const ok = run.rows.filter((row) => !row.failed);
    const spread = ok.length > 1 ? Math.max(...ok.map((row) => row.quality)) - Math.min(...ok.map((row) => row.quality)) : 0;
    const winners = ok.length > 0 ? ok.slice().sort((a, b) => b.utility - a.utility)[0].route : "-";
    console.log(`  run ${new Date(run.time).toISOString().slice(11, 19)}: between-model Q spread ${spread.toFixed(2)}, winner ${winners}`);
  }
  if (within.length > 0) {
    const meanWithin = within.reduce((sum, value) => sum + value, 0) / within.length;
    const spreads = group.flatMap((run) => {
      const ok = run.rows.filter((row) => !row.failed);
      return ok.length > 1 ? [Math.max(...ok.map((row) => row.quality)) - Math.min(...ok.map((row) => row.quality))] : [];
    });
    const meanBetween = spreads.length > 0 ? spreads.reduce((sum, value) => sum + value, 0) / spreads.length : 0;
    console.log(`  -> mean within-model drift ${meanWithin.toFixed(2)} vs mean between-model spread ${meanBetween.toFixed(2)}` +
      (meanWithin >= meanBetween ? "  [NO SIGNAL: drift >= spread, ranking is luck]" : "  [some signal, drift still large]"));
  }
}

// ---------- 2. probe reliability per provider ----------
console.log("\n=== 2. probe reliability ===");
const providerStats = new Map();
for (const run of probed) {
  for (const row of run.rows) {
    const provider = row.route.split("/")[0];
    const entry = providerStats.get(provider) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (row.failed) entry.failed += 1;
    providerStats.set(provider, entry);
  }
}
for (const [provider, { total, failed }] of providerStats) {
  console.log(`  ${provider.padEnd(22)} ${failed}/${total} failed (${((failed / total) * 100).toFixed(0)}%)`);
}

// ---------- 3. dispatched tasks: predicted vs actual ----------
console.log("\n=== 3. closed-loop dispatches (predicted vs actual) ===");
const turnStarts = events.filter((event) => event.type === "turn/start");
const stepStarts = events.filter((event) => event.type === "step/start");

// Per-turn real usage lives on assistant/message events (data.usage), the
// same source read_token_usage.js counts from.
const usageByTurn = new Map();
for (const event of events) {
  if (event.type !== "assistant/message" || !event.data?.usage) continue;
  const key = `${event.file}:${event.data.turn}`;
  const u = event.data.usage;
  const bucket = usageByTurn.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, turn: event.data.turn };
  bucket.input += u.inputTokens ?? 0;
  bucket.output += u.outputTokens ?? 0;
  bucket.cacheRead += u.cacheReadTokens ?? 0;
  bucket.cacheWrite += u.cacheWriteTokens ?? 0;
  bucket.calls += 1;
  usageByTurn.set(key, bucket);
}

const modelSelections = events.filter((event) => event.type === "model/selection");
const userMessages = events.filter((event) => event.type === "user/message");

let dispatchCount = 0;
const calibrations = [];
for (const run of probed) {
  const dispatched = userMessages.find((event) =>
    event.time > run.time && event.time < run.time + 5 * 60_000 &&
    (event.data?.content ?? []).some((block) => block.type === "text" && block.text === run.task));
  if (!dispatched) continue;
  const turnStart = turnStarts.find((event) => event.file === dispatched.file && event.time >= dispatched.time);
  if (!turnStart) continue;
  const turn = turnStart.data.turn;
  const steps = stepStarts.filter((event) => event.file === turnStart.file && event.data?.turn === turn).length;
  const usage = usageByTurn.get(`${turnStart.file}:${turn}`);
  const selection = [...modelSelections].reverse().find((event) => event.file === dispatched.file && event.time <= turnStart.time);
  dispatchCount += 1;
  const predicted = run.winner;
  console.log(`  task "${run.task.slice(0, 30)}..." -> turn ${turn} on ${selection ? `${selection.data.provider}/${selection.data.model}` : "?"}`);
  console.log(`    predicted: ${predicted ? `${predicted.steps} steps, ${predicted.estTokensK}k tokens (${predicted.route})` : "n/a"}`);
  console.log(`    actual   : ${steps} steps${usage ? `, ${(usage.input + usage.cacheRead + usage.cacheWrite + usage.output).toLocaleString()} billed tokens over ${usage.calls} calls` : ", usage not logged"}`);
  if (predicted && usage) {
    const actualK = (usage.input + usage.cacheRead + usage.cacheWrite + usage.output) / 1000;
    const predictedK = Number(predicted.estTokensK);
    calibrations.push({ task: run.task, route: predicted.route, predictedK, actualK, ratio: actualK / predictedK });
  }
}
if (dispatchCount === 0) console.log("  (no dispatched executions in the logs yet — closed loop shipped after the last logged run)");

// ---------- 4. estimator calibration ----------
console.log("\n=== 4. token estimator calibration (dispatched tasks) ===");
if (calibrations.length === 0) {
  console.log("  (needs dispatched turns with logged usage)");
} else {
  for (const calibration of calibrations) {
    console.log(`  ${calibration.route.padEnd(34)} predicted ${calibration.predictedK}k vs actual ${calibration.actualK.toFixed(1)}k  (actual/predicted ${calibration.ratio.toFixed(2)}x)  "${calibration.task.slice(0, 24)}..."`);
  }
  const meanRatio = calibrations.reduce((sum, value) => sum + value.ratio, 0) / calibrations.length;
  console.log(`  -> mean actual/predicted ${meanRatio.toFixed(2)}x ${meanRatio > 1.5 ? "[underestimates]" : meanRatio < 0.67 ? "[overestimates]" : "[roughly calibrated]"}`);
}

// Session-wide totals, same numbers read_token_usage.js prints.
console.log("\n=== 5. session-wide usage ===");
{
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
  for (const bucket of usageByTurn.values()) {
    totals.input += bucket.input;
    totals.output += bucket.output;
    totals.cacheRead += bucket.cacheRead;
    totals.cacheWrite += bucket.cacheWrite;
    totals.calls += bucket.calls;
  }
  const billed = totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
  console.log(`  calls ${totals.calls} · uncached input ${totals.input.toLocaleString()} · cache read ${totals.cacheRead.toLocaleString()} · cache write ${totals.cacheWrite.toLocaleString()} · output ${totals.output.toLocaleString()}`);
  console.log(`  billed total ${billed.toLocaleString()} tokens`);
}
