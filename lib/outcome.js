/**
 * Outcome log (v0.3): what actually happened after scout dispatched a task.
 *
 * Every dispatch appends one record keyed by the `scout-` message id injected
 * via `followup()`. The next `/scout` run reconciles pending records against
 * the session logs — the same multi-frame zstd pipeline the self-check uses —
 * and settles them with the turn's real billed tokens, step count, and the
 * route that actually ran. Settled records become per-model priors: a
 * calibration multiplier on future token estimates for that route.
 *
 * Deliberately local and best-effort: one JSONL file under
 * `~/.dsh/agent-model-scout/`, never required for `/scout` to work.
 *
 * @module agent-model-scout/outcome
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";

/**
 * Where the outcome log lives; overridable for tests via SCOUT_OUTCOME_DIR.
 * @returns {string} directory path.
 */
export function outcomeDir() {
  return process.env.SCOUT_OUTCOME_DIR ?? join(homedir(), ".dsh", "agent-model-scout");
}

/**
 * Where session logs live; overridable for tests via SCOUT_SESSIONS_DIR.
 * @returns {string} directory path.
 */
export function sessionsRoot() {
  return process.env.SCOUT_SESSIONS_DIR ?? join(homedir(), ".dsh", "sessions");
}

/**
 * Read every outcome record, tolerating a missing or corrupt file.
 * @param {string} [dir] - outcome directory; defaults to {@link outcomeDir}.
 * @returns {object[]} parsed records.
 */
export function loadOutcomes(dir = outcomeDir()) {
  const path = join(dir, "outcomes.jsonl");
  if (!existsSync(path)) return [];
  const records = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* torn tail line from a mid-write crash — drop it */
    }
  }
  return records;
}

/**
 * Rewrite the whole outcome file (records are few; settle rewrites all).
 * @param {string} dir - outcome directory.
 * @param {object[]} records - complete record list.
 */
export function saveOutcomes(dir, records) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "outcomes.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
}

/**
 * Append one dispatch record at the moment a task is queued.
 * @param {string} dir - outcome directory.
 * @param {object} record - dispatch record (messageId, task, route, effort,
 *   quality, predictedTokens, predictedTurns, predictedSteps, dispatchedAt).
 */
export function appendDispatch(dir, record) {
  if (typeof record.messageId !== "string" || record.messageId.length === 0) return;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "outcomes.jsonl"), JSON.stringify(record) + "\n", "utf8");
}

/**
 * Records still waiting for their session-log actuals.
 * @param {object[]} records - loaded outcome records.
 * @returns {object[]} records with no `settledAt` and a usable `messageId`.
 */
export function pendingDispatches(records) {
  return records.filter((record) => record.settledAt === undefined && typeof record.messageId === "string");
}

/**
 * Build per-model priors from settled dispatches. A record counts toward the
 * route that actually ran (`actualRoute`) when known, else the intended one.
 *
 * @param {object[]} records - loaded outcome records.
 * @returns {Map<string, {dispatches: number, tokenRatio?: number, stepRatio?: number,
 *   meanTokens?: number, reaskRate?: number}>} keyed by `provider/model`.
 */
export function priorsFrom(records) {
  const buckets = new Map();
  for (const record of records) {
    if (record.settledAt === undefined) continue;
    const route = typeof record.actualRoute === "string" && record.actualRoute.length > 0 ? record.actualRoute : record.route;
    if (typeof route !== "string" || route.length === 0 || route === "(current)") continue;
    const entry = buckets.get(route) ?? { dispatches: 0, tokenRatios: [], stepRatios: [], tokenList: [], followUps: [] };
    entry.dispatches += 1;
    if (record.actualTokens > 0 && record.predictedTokens > 0) {
      entry.tokenRatios.push(record.actualTokens / record.predictedTokens);
    }
    if (record.actualTokens > 0) entry.tokenList.push(record.actualTokens);
    if (record.actualSteps > 0 && record.predictedSteps > 0) {
      entry.stepRatios.push(record.actualSteps / record.predictedSteps);
    }
    if (typeof record.followUp?.kind === "string" && record.followUp.kind !== "none") {
      entry.followUps.push(record.followUp.kind);
    }
    buckets.set(route, entry);
  }

  const priors = new Map();
  const mean = (values) => (values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined);
  for (const [route, entry] of buckets) {
    priors.set(route, {
      dispatches: entry.dispatches,
      tokenRatio: mean(entry.tokenRatios),
      stepRatio: mean(entry.stepRatios),
      meanTokens: mean(entry.tokenList),
      reaskRate:
        entry.followUps.length > 0
          ? entry.followUps.filter((kind) => kind === "reask").length / entry.followUps.length
          : undefined,
    });
  }
  return priors;
}

/**
 * High-precision markers that the user is redoing or complaining about the
 * dispatched task, regardless of wording overlap. Deliberately short: a false
 * "reask" poisons the quality prior, a missed one only delays it.
 */
const REASK_PATTERN = /重试|重新|再来一次|还是不|不对|不行|没做完|没上传|没推送|没改|还没|retry|redo|again|still not|didn'?t (work|finish|run)|not working|failed/i;

/**
 * Classify the first user message after a dispatched turn: did the task come
 * back as a re-ask (the run failed or underdelivered) or a normal continuation?
 *
 * @param {string} taskText - the dispatched task, verbatim.
 * @param {string|undefined} followUpText - the next user message's text.
 * @returns {"reask"|"continuation"|"none"} classification.
 */
export function classifyFollowUp(taskText, followUpText) {
  if (typeof followUpText !== "string" || followUpText.trim().length === 0) return "none";
  if (REASK_PATTERN.test(followUpText)) return "reask";
  const task = contentUnits(taskText);
  const follow = contentUnits(followUpText);
  if (task.size === 0 || follow.size === 0) return "continuation";
  let shared = 0;
  for (const unit of task) if (follow.has(unit)) shared += 1;
  // The follow-up repeating most of the task's own units is a re-ask even
  // without an explicit complaint word.
  return shared / task.size >= 0.6 ? "reask" : "continuation";
}

/**
 * Split text into content units for overlap comparison: latin words as words,
 * CJK text as individual characters (CJK carries meaning per character).
 * @param {string} text - source text.
 * @returns {Set<string>} units.
 */
function contentUnits(text) {
  const units = new Set();
  for (const word of String(text ?? "").toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/gu) ?? []) {
    if (word.length > 1 || /[\u4e00-\u9fff]/u.test(word)) units.add(word);
  }
  return units;
}

/**
 * Calibrate probed rows in place with per-model priors.
 *
 * @param {object[]} usable - rows that returned a plan (mutated).
 * @param {Map} priors - from {@link priorsFrom}.
 * @param {number} minDispatches - priors below this many dispatches are ignored.
 * @returns {string[]} human-readable `route ×ratio (n)` entries for the report.
 */
export function applyPriors(usable, priors, minDispatches) {
  const applied = [];
  for (const row of usable) {
    const route = `${row.candidate.provider}/${row.candidate.model}`;
    const prior = priors.get(route);
    if (prior === undefined || prior.dispatches < minDispatches || prior.tokenRatio === undefined) continue;
    row.totalTokens = Math.round(row.totalTokens * prior.tokenRatio);
    row.priorCalibration = prior.tokenRatio;
    applied.push(`${route} ×${prior.tokenRatio.toFixed(2)} (${prior.dispatches})`);
  }
  return applied;
}

/**
 * Build a probe-free row for `--trust` mode from one route's priors alone.
 *
 * Quality is the complement of the measured re-ask rate (the only quality
 * signal that ever survived the self-check); cost is the route's mean actual
 * tokens. Both are cross-task historical averages, not per-task estimates —
 * the row is flagged `priorMode` so the report says so.
 *
 * @param {{provider: string, model: string}} candidate - route to rank.
 * @param {object} prior - confident prior for that route.
 * @returns {object} row shaped like a probed row, marked `priorMode`.
 */
export function priorRow(candidate, prior) {
  return {
    candidate,
    plan: { steps: [], files: [] },
    quality: 1 - (prior.reaskRate ?? 0),
    totalTokens: Math.round(prior.meanTokens ?? 0),
    turns: 0,
    probeTokens: 0,
    elapsedMs: 0,
    priorMode: true,
    priorDispatches: prior.dispatches,
    priorReaskRate: prior.reaskRate,
  };
}

/**
 * Settle pending records against decoded session-log events (pure).
 *
 * Linkage: the injected `scout-` message id on a `user/message` event, then
 * the first same-file `turn/start` at/after it. Usage and steps come from that
 * turn's `assistant/message` (`data.usage`) and `step/start` events. A record
 * only settles once something later exists in the same file (a follow-up turn
 * or user message), because the newest turn in a log may still be running.
 *
 * @param {object[]} records - loaded outcome records (mutated copies not made).
 * @param {object[]} events - time-sorted events tagged with `file`.
 * @returns {{settled: number}} how many records gained actuals.
 */
export function settleFromEvents(records, events) {
  const userById = new Map();
  for (const event of events) {
    if (event.type === "user/message" && typeof event.data?.id === "string") userById.set(event.data.id, event);
  }

  const turnsByFile = new Map();
  const usersByFile = new Map();
  const usageByTurn = new Map();
  const stepsByTurn = new Map();
  const selectionsByFile = new Map();
  for (const event of events) {
    if (event.type === "turn/start") pushTo(turnsByFile, event.file, event);
    else if (event.type === "user/message") pushTo(usersByFile, event.file, event);
    else if (event.type === "model/selection") pushTo(selectionsByFile, event.file, event);
    else if (event.type === "step/start") pushTo(stepsByTurn, `${event.file}:${event.data?.turn}`, event);
    else if (event.type === "assistant/message" && event.data?.usage) {
      const key = `${event.file}:${event.data.turn}`;
      const u = event.data.usage;
      const bucket = usageByTurn.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
      bucket.input += u.inputTokens ?? 0;
      bucket.output += u.outputTokens ?? 0;
      bucket.cacheRead += u.cacheReadTokens ?? 0;
      bucket.cacheWrite += u.cacheWriteTokens ?? 0;
      bucket.calls += 1;
      usageByTurn.set(key, bucket);
    }
  }

  let settled = 0;
  for (const record of records) {
    if (record.settledAt !== undefined || typeof record.messageId !== "string") continue;
    const message = userById.get(record.messageId);
    if (message === undefined) continue;

    const turnStart = (turnsByFile.get(message.file) ?? []).find((event) => event.time >= message.time);
    if (turnStart === undefined) continue;

    // Closure: something must follow in the same file, or the turn may still
    // be streaming and its usage would be a partial sum.
    const closed =
      (turnsByFile.get(message.file) ?? []).some((event) => event.time > turnStart.time) ||
      (usersByFile.get(message.file) ?? []).some((event) => event.time > message.time);
    if (!closed) continue;

    const turn = turnStart.data?.turn;
    const usage = usageByTurn.get(`${message.file}:${turn}`);
    const selection = [...(selectionsByFile.get(message.file) ?? [])].reverse().find((event) => event.time <= turnStart.time);

    record.settledAt = Date.now();
    record.actualRoute = selection ? `${selection.data.provider}/${selection.data.model}` : undefined;
    record.actualSteps = (stepsByTurn.get(`${message.file}:${turn}`) ?? []).length;
    if (usage !== undefined) {
      record.actualTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      record.actualCalls = usage.calls;
    }

    // The first user message after the turn says whether the run satisfied:
    // a repeat of the task or a complaint is a re-ask, anything else a
    // continuation. A later scout dispatch of the same task counts too —
    // re-dispatching is the strongest re-ask there is.
    const followUp = (usersByFile.get(message.file) ?? []).find((event) => {
      if (event.time < turnStart.time || event.data?.id === record.messageId) return false;
      const blocks = event.data?.content;
      return Array.isArray(blocks) && blocks.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.length > 0);
    });
    if (followUp !== undefined) {
      const text = followUp.data.content.find((block) => block?.type === "text")?.text ?? "";
      record.followUp = { kind: classifyFollowUp(record.task ?? "", text), text: text.slice(0, 120) };
    }
    settled += 1;
  }
  return { settled };
}

/**
 * Decode one session log: concatenated independent zstd frames.
 * Ported from the self-check; `node:zlib` gained zstd in the bundled runtime.
 * @param {Buffer} buffer - raw file bytes.
 * @returns {string} decoded text, possibly partial on torn frames.
 */
export function decodeSessionLog(buffer) {
  const chunks = [];
  let offset = 0;
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  while (offset < buffer.length) {
    let out;
    try {
      out = zlib.zstdDecompressSync(buffer.subarray(offset));
    } catch {
      break;
    }
    if (out.length === 0) break;
    chunks.push(out);
    let next = -1;
    for (let i = offset + 4; i <= buffer.length - 4; i += 1) {
      if (buffer[i] === magic[0] && buffer[i + 1] === magic[1] && buffer[i + 2] === magic[2] && buffer[i + 3] === magic[3]) {
        next = i;
        break;
      }
    }
    if (next === -1) break;
    offset = next;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Load session-log events from every file modified after `sinceTime`.
 * @param {string} root - sessions directory.
 * @param {number} sinceTime - epoch ms watermark.
 * @returns {{events: object[], scanned: number}} time-sorted, file-tagged events.
 */
export function collectEvents(root, sinceTime) {
  const files = [];
  (function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.startsWith("session") && entry.name.endsWith(".zstd")) files.push(full);
    }
  })(root);

  const events = [];
  let scanned = 0;
  let fileIndex = 0;
  for (const path of files) {
    fileIndex += 1;
    let mtime;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < sinceTime) continue;
    scanned += 1;
    let text;
    try {
      text = decodeSessionLog(readFileSync(path));
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push({ ...JSON.parse(line), file: fileIndex });
      } catch {
        /* torn tail line */
      }
    }
  }
  events.sort((a, b) => a.time - b.time);
  return { events, scanned };
}

/**
 * Full reconcile pass: load records, settle pending ones against recent
 * session logs, persist, and return the fresh record list. Never throws —
 * the outcome log must not break `/scout`.
 *
 * @param {string} [dir] - outcome directory.
 * @param {string} [root] - sessions directory.
 * @returns {{records: object[], settled: number, scanned: number, error?: string}}
 */
export function reconcile(dir = outcomeDir(), root = sessionsRoot()) {
  try {
    const records = loadOutcomes(dir);
    const pending = pendingDispatches(records);
    if (pending.length === 0) return { records, settled: 0, scanned: 0 };
    const since = Math.min(...pending.map((record) => record.dispatchedAt ?? Number.MAX_SAFE_INTEGER)) - 5 * 60_000;
    const { events, scanned } = collectEvents(root, since);
    const { settled } = settleFromEvents(records, events);
    if (settled > 0) saveOutcomes(dir, records);
    return { records, settled, scanned };
  } catch (error) {
    return { records: [], settled: 0, scanned: 0, error: String(error?.message ?? error) };
  }
}

/**
 * @param {Map} map - grouping map.
 * @param {*} key - group key.
 * @param {object} value - event to append.
 */
function pushTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
