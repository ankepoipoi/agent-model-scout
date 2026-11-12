/**
 * Plan parsing, quality scoring, and candidate ranking.
 *
 * The probe never asks a model to score itself: it asks for a plan, and this
 * module turns that plan into a number with a fixed, inspectable rubric. The
 * rubric is deliberately simple — v0 exists to test whether plans differ
 * enough to predict execution, not to be the final scorer.
 *
 * @module agent-model-scout/plan
 */

import { clamp, estimateTaskTokens, estimateTextTokens } from "./estimate.js";

/** Fields a probe reply is expected to carry. */
const PLAN_KEYS = ["plan", "files", "est_turns", "tool_calls", "risk", "blockers", "confidence"];

/**
 * Extract the first balanced JSON object from model output.
 *
 * Models wrap JSON in fences, prepend prose, or append commentary. A naive
 * first-`{`-to-last-`}` slice breaks on trailing text, so this scans for a
 * balanced object while respecting string literals and escapes.
 *
 * @param {string} text - raw model output.
 * @returns {object|undefined} parsed object, or undefined when no valid JSON object exists.
 */
export function parsePlan(text) {
  if (typeof text !== "string") return undefined;
  const cleaned = text.replace(/```(?:json)?/giu, "");

  for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
    const end = matchBrace(cleaned, start);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not valid JSON at this position; try the next opening brace.
    }
  }
  return undefined;
}

/**
 * Find the index of the brace closing the object opened at `start`.
 * @param {string} text - source text.
 * @param {number} start - index of the opening `{`.
 * @returns {number} index of the matching `}`, or -1 when unbalanced.
 */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Coerce a raw plan into the shape the scorer expects.
 * @param {object} raw - parsed JSON from a probe.
 * @returns {object} normalized plan with stable field types.
 */
export function normalizePlan(raw) {
  const steps = Array.isArray(raw?.plan)
    ? raw.plan
        .map((step) => (typeof step === "string" ? step : typeof step?.step === "string" ? step.step : ""))
        .map((step) => step.trim())
        .filter((step) => step.length > 0)
    : [];

  const files = Array.isArray(raw?.files)
    ? raw.files.filter((file) => typeof file === "string" && file.trim().length > 0).map((file) => file.trim())
    : [];

  const rawCalls = raw?.tool_calls;
  const toolCalls = {};
  if (rawCalls !== null && typeof rawCalls === "object" && !Array.isArray(rawCalls)) {
    for (const [key, value] of Object.entries(rawCalls)) {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) toolCalls[key] = n;
    }
  }

  const blockers = Array.isArray(raw?.blockers)
    ? raw.blockers.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  return {
    steps,
    files,
    estTurns: clamp(Math.round(Number(raw?.est_turns) || 0), 0, 60),
    toolCalls,
    risk: typeof raw?.risk === "string" ? raw.risk.trim().toLowerCase() : "",
    blockers,
    confidence: clamp(Number(raw?.confidence), 0, 1),
    present: PLAN_KEYS.filter((key) => raw?.[key] !== undefined),
  };
}

/** Tokens that look like a path, identifier, or code span — a proxy for concreteness. */
const CONCRETE_STEP = /(`[^`]+`|\/[\w.@-]+|[\w-]+\.[a-z]{1,4}\b|\b[a-z]+[A-Z]\w*\b)/u;

/**
 * Score a plan's quality in [0, 1] with a fixed rubric.
 *
 * Weights (max 1.0):
 *   0.30 structure    — step count, saturating at 6
 *   0.15 scope        — files named, saturating at 2 (most tasks touch one or two)
 *   0.25 concreteness — share of steps naming a path, symbol, or code span
 *   0.20 coverage     — plan both edits something and verifies something
 *   0.05 risk         — lower stated risk scores higher
 *   0.05 confidence   — self-reported, deliberately the smallest term
 * minus up to 0.10 for stated blockers.
 *
 * @param {ReturnType<typeof normalizePlan>} plan - normalized plan.
 * @returns {{quality: number, parts: Record<string, number>}} score and its components.
 */
export function qualityOf(plan) {
  const parts = {};

  parts.structure = Math.min(plan.steps.length / 6, 1) * 0.3;
  parts.scope = Math.min(plan.files.length / 2, 1) * 0.15;

  const concrete = plan.steps.filter((step) => CONCRETE_STEP.test(step)).length;
  parts.concreteness = plan.steps.length === 0 ? 0 : (concrete / plan.steps.length) * 0.25;

  const calls = plan.toolCalls;
  const edits = (calls.edit ?? 0) + (calls.write ?? 0) + (calls.patch ?? 0);
  const verifies = (calls.test ?? 0) + (calls.bash ?? 0) + (calls.grep ?? 0) + (calls.read ?? 0);
  parts.coverage = (edits > 0 ? 0.1 : 0) + (verifies > 0 ? 0.1 : 0);

  parts.risk = plan.risk === "low" ? 0.05 : plan.risk === "medium" ? 0.025 : 0;
  parts.confidence = plan.confidence * 0.05;

  const penalty = Math.min(plan.blockers.length * 0.05, 0.1);

  const quality = clamp(
    parts.structure + parts.scope + parts.concreteness + parts.coverage + parts.risk + parts.confidence - penalty,
    0,
    1,
  );

  return { quality, parts };
}

/**
 * Build the full comparison row for one candidate.
 * @param {object} input - row inputs.
 * @param {{provider: string, model: string}} input.candidate - probed route.
 * @param {ReturnType<typeof normalizePlan>} input.plan - its normalized plan.
 * @param {number} input.taskTokens - task text tokens.
 * @param {number} [input.fixedOverheadTokens] - per-turn fixed prompt cost.
 * @param {(path: string) => boolean} [input.pathExists] - grounding check for planned files.
 * @returns {object} row with quality, turns, and estimated total tokens.
 */
export function buildRow(input) {
  const { candidate, plan, taskTokens, fixedOverheadTokens = 3000, pathExists } = input;
  const { quality: shapeQuality, parts } = qualityOf(plan);

  // Grounding is worth more than any shape term: a plan that names files which
  // do not exist is guessing, and one that names real files has actually looked.
  // Without a predicate nothing was checked, so the term stays neutral — an
  // unverified plan must never inherit the bonus.
  const checked = typeof pathExists === "function";
  const missing = checked ? plan.files.filter((file) => !pathExists(file)) : [];
  const grounding = !checked || plan.files.length === 0 ? 0 : missing.length === 0 ? 0.1 : -0.2;
  const quality = clamp(shapeQuality + grounding, 0, 1);

  // A plan's self-reported turn count is the least reliable field it sends: a
  // multi-step plan cannot execute in one turn, so floor it by step count.
  const stepFloor = plan.steps.length > 1 ? Math.ceil(plan.steps.length / 3) : 1;
  const effectiveTurns = Math.max(plan.estTurns, stepFloor);

  const { turns, totalTokens } = estimateTaskTokens({
    plan: { est_turns: effectiveTurns },
    taskTokens,
    fixedOverheadTokens,
  });

  return {
    candidate,
    plan,
    quality,
    parts: { ...parts, grounding },
    missing,
    groundingChecked: checked,
    turns,
    totalTokens,
    probeTokens: estimateTextTokens(plan.steps.join(" ")),
  };
}

/**
 * Rank rows by utility, where utility = quality − λ · normalized cost.
 *
 * Cost is normalized against the most expensive candidate so the penalty is
 * scale-free: 0 for the cheapest, 1 for the priciest.
 *
 * @param {object[]} rows - rows from {@link buildRow}.
 * @param {number} lambda - cost weight; 0 ignores cost, 1 makes it decisive.
 * @returns {object[]} new array sorted by descending utility, with `utility` set.
 */
export function rankRows(rows, lambda) {
  const maxTokens = rows.reduce((max, row) => Math.max(max, row.totalTokens), 0);
  return rows
    .map((row) => {
      const normalizedCost = maxTokens > 0 ? row.totalTokens / maxTokens : 0;
      return { ...row, utility: row.quality - clamp(lambda, 0, 1) * normalizedCost };
    })
    .sort((a, b) => b.utility - a.utility || a.totalTokens - b.totalTokens);
}
