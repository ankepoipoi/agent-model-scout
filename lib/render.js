/**
 * Plain-text report rendering for `/scout`.
 *
 * The command result is logged verbatim in `command/done`, so this text is the
 * durable record of why a model was picked. Keep it self-contained: someone
 * replaying the session later should understand the decision without the probe
 * transcripts.
 *
 * @module agent-model-scout/render
 */

import { formatTokens } from "./estimate.js";

/**
 * Pad a string to a fixed display width, truncating with an ellipsis.
 * @param {string} value - source text.
 * @param {number} width - target width in characters.
 * @returns {string} padded or truncated text.
 */
function pad(value, width) {
  const text = String(value);
  if (text.length > width) return `${text.slice(0, Math.max(0, width - 1))}…`;
  return text.padEnd(width, " ");
}

/**
 * Describe one row's plan shape and whether its files were verified.
 * @param {object} row - ranked row.
 * @returns {string} NOTE cell text.
 */
function noteOf(row) {
  if (row.priorMode === true) {
    const reask = row.priorReaskRate !== undefined ? ` · reask ${Math.round(row.priorReaskRate * 100)}%` : "";
    return `prior mode · ${row.priorDispatches} settled dispatches${reask}`;
  }
  if (row.plan.steps.length === 0) return "empty plan — est. unreliable";
  const base = `${plural(row.plan.steps.length, "step")}, ${plural(row.plan.files.length, "file")}`;
  const cal = row.priorCalibration !== undefined ? ` · cal ×${row.priorCalibration.toFixed(2)}` : "";
  if (row.groundingChecked !== true) return `${base} · unverified${cal}`;
  if ((row.missing?.length ?? 0) > 0) return `${base} · ${row.missing.length} missing${cal}`;
  return row.plan.files.length > 0 ? `${base} · grounded${cal}` : `${base}${cal}`;
}

/**
 * Render a count with a correctly pluralized noun.
 * @param {number} count - quantity.
 * @param {string} noun - singular noun.
 * @returns {string} e.g. "1 step", "4 steps".
 */
function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Render the full `/scout` report.
 * @param {object} input - report inputs.
 * @param {string} input.task - the probed task text.
 * @param {object[]} input.rows - ranked rows, each optionally carrying `error`/`elapsedMs`.
 * @param {number} input.lambda - cost weight used for ranking.
 * @param {boolean} [input.applied] - whether the winner was applied to this agent.
 * @param {string} [input.recommendation] - one-line recommendation, when a winner exists.
 * @param {object} [input.qualityLeader] - highest-quality row, when it differs from the utility winner.
 * @returns {string} report text.
 */
export function renderReport(input) {
  const { task, rows, lambda, applied = false, recommendation, qualityLeader } = input;
  const lines = [];

  lines.push(`scout · ${rows.length} candidate(s) · λ=${lambda.toFixed(2)}`);
  lines.push(`task: ${truncate(task, 120)}`);
  lines.push("");
  lines.push(`  ${pad("#", 2)} ${pad("MODEL", 34)} ${pad("Q", 5)} ${pad("EST.TOK", 8)} ${pad("U", 6)} ${pad("TIME", 6)} NOTE`);

  rows.forEach((row, index) => {
    const model = `${row.candidate.provider}/${row.candidate.model}`;
    if (row.error !== undefined) {
      lines.push(`  ${pad(String(index + 1), 2)} ${pad(model, 34)} ${pad("-", 5)} ${pad("-", 8)} ${pad("-", 6)} ${pad(`${row.elapsedMs ?? 0}ms`, 6)} ${row.error}`);
      return;
    }
    const note = noteOf(row);
    lines.push(
      `  ${pad(String(index + 1), 2)} ${pad(model, 34)} ${pad(row.quality.toFixed(2), 5)} ${pad(formatTokens(row.totalTokens), 8)} ${pad(row.utility.toFixed(2), 6)} ${pad(`${row.elapsedMs ?? 0}ms`, 6)} ${note}`,
    );
  });

  const winner = rows.find((row) => row.error === undefined);
  if (winner !== undefined) {
    lines.push("");
    lines.push(`  top plan: ${winner.plan.steps.slice(0, 3).map((step, i) => `${i + 1}) ${truncate(step, 60)}`).join("  ") || "(empty)"}`);
    if (winner.plan.files.length > 0) {
      lines.push(`  files: ${winner.plan.files.slice(0, 4).join(", ")}${winner.plan.files.length > 4 ? " …" : ""}`);
    }
  }

  lines.push("");
  if (recommendation !== undefined) {
    lines.push(`  ▸ ${recommendation}`);
  } else {
    lines.push("  ▸ no usable plan came back; nothing was applied.");
  }

  const key = (row) => `${row.candidate.provider}/${row.candidate.model}`;
  if (qualityLeader !== undefined && winner !== undefined && key(qualityLeader) !== key(winner)) {
    const dq = (qualityLeader.quality - winner.quality).toFixed(2);
    const dt = formatTokens(qualityLeader.totalTokens - winner.totalTokens);
    lines.push(`  ▸ quality leader: ${key(qualityLeader)} — ${qualityLeader.quality.toFixed(2)} at ${formatTokens(qualityLeader.totalTokens)} (+${dq} quality, +${dt} tokens)`);
  }
  if (applied) {
    lines.push("  ▸ model selection recorded; it takes effect from the next step.");
  } else if (recommendation !== undefined) {
    lines.push("  ▸ dry run — add --apply to switch this agent's model.");
  }

  return lines.join("\n");
}

/**
 * Shorten text to a maximum length with an ellipsis.
 * @param {string} text - source text.
 * @param {number} max - maximum characters.
 * @returns {string} shortened text.
 */
export function truncate(text, max) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
