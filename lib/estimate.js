/**
 * Token estimation for the route plugin.
 *
 * Uses a fixed-density heuristic rather than a model tokenizer: every provider
 * tokenizes differently, so a shared density estimate is the only number that
 * can be compared across candidates. Calibrate the constants against real
 * `usage` numbers as they accumulate (see README, "Calibration").
 *
 * @module agent-model-scout/estimate
 */

/** CJK code-point ranges priced at the ideograph density. */
const CJK_RANGES = [
  [0x2e80, 0x2eff], // CJK radicals / Kangxi
  [0x3000, 0x303f], // CJK punctuation
  [0x3040, 0x30ff], // kana
  [0x3400, 0x4dbf], // CJK ext A
  [0x4e00, 0x9fff], // CJK unified
  [0xf900, 0xfaff], // compatibility ideographs
  [0xff00, 0xffef], // fullwidth forms
  [0x20000, 0x2fa1f], // ext B+
];

/** Approximate tokens per CJK character (DeepSeek guidance: ~0.6). */
export const CJK_TOKENS_PER_CHAR = 0.6;
/** Approximate tokens per non-CJK character (DeepSeek guidance: ~0.3). */
export const ASCII_TOKENS_PER_CHAR = 0.3;

/**
 * Test whether one code point belongs to a CJK block.
 * @param {number} code - Unicode code point.
 * @returns {boolean} true for ideographic / kana / fullwidth blocks.
 */
function isCjk(code) {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/**
 * Estimate tokens for one piece of text under the fixed-density heuristic.
 * @param {string} text - any text; `undefined` prices as zero.
 * @returns {number} non-negative integer token estimate.
 */
export function estimateTextTokens(text) {
  if (typeof text !== "string" || text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (isCjk(code)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk * CJK_TOKENS_PER_CHAR + other * ASCII_TOKENS_PER_CHAR);
}

/**
 * Estimate the input tokens of one probe request (system + user turn).
 * @param {string} system - probe system prompt.
 * @param {string} user - framed task text.
 * @returns {number} non-negative integer token estimate.
 */
export function estimateProbeInputTokens(system, user) {
  // Role/structural framing is small but not free; 16 covers it for a 2-message call.
  return estimateTextTokens(system) + estimateTextTokens(user) + 16;
}

/**
 * Estimate the total token consumption of the real task, given a plan.
 *
 * Model: the loop re-sends the whole context every turn, so input cost grows
 * quadratically with turn count, not linearly.
 *
 *   total ≈ Σ_turns (fixed + task + accumulated tool output) + assistant output
 *
 * @param {object} input - pricing inputs.
 * @param {object|undefined} input.plan - normalized plan (uses `est_turns`).
 * @param {number} input.taskTokens - tokens of the task description itself.
 * @param {number} [input.fixedOverheadTokens] - system prompt + tool schemas per turn.
 * @param {number} [input.toolOutputPerTurn] - average tool result tokens per turn.
 * @param {number} [input.assistantOutputPerTurn] - average assistant text tokens per turn.
 * @param {number} [input.defaultTurns] - turn count assumed when the plan omits one.
 * @returns {{turns: number, totalTokens: number}} rounded estimate.
 */
export function estimateTaskTokens(input) {
  const {
    plan,
    taskTokens,
    fixedOverheadTokens = 3000,
    toolOutputPerTurn = 1200,
    assistantOutputPerTurn = 500,
    defaultTurns = 8,
  } = input;

  const rawTurns = Number(plan?.est_turns);
  const turns = clamp(Math.round(Number.isFinite(rawTurns) && rawTurns > 0 ? rawTurns : defaultTurns), 1, 60);

  // Each turn re-sends the fixed overhead plus the task text.
  const base = (fixedOverheadTokens + taskTokens) * turns;
  // Tool results accumulate: turn k carries k turns of output already.
  const accumulated = toolOutputPerTurn * ((turns * (turns + 1)) / 2);
  const assistant = assistantOutputPerTurn * turns;

  return { turns, totalTokens: Math.round(base + accumulated + assistant) };
}

/**
 * Clamp a number into an inclusive range, replacing non-finite values with the minimum.
 * @param {number} value - candidate number.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} clamped value.
 */
export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Format a token count for humans: 1234 → "1.2k", 1234567 → "1.23M".
 * @param {number} n - non-negative count.
 * @returns {string} compact label.
 */
export function formatTokens(n) {
  const value = Math.max(0, Math.round(n));
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}
