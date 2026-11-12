/**
 * `/scout <task>` — probe every configured model with one cheap planning call,
 * rank the plans by quality vs. estimated token cost, and optionally switch
 * this agent onto the winner.
 *
 * v0 scope: manual trigger only, no learned priors, no mid-run escalation.
 * The probe answers "which model plans this task better"; it does not answer
 * "which model will actually finish it" — that is what the v2 outcome log is for.
 *
 * @module agent-model-scout
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { estimateTextTokens, formatTokens } from "./estimate.js";
import { buildRow, combineRows, normalizePlan, parsePlan, rankRows } from "./plan.js";
import { renderReport, truncate } from "./render.js";

/** Cordis plugin identity. */
export const name = "scout";

/** Services this plugin needs mounted before it can apply. */
export const inject = ["commands", "llm", "userQuestions"];

const USAGE = [
  "Usage: /scout [task] [--apply] [--dry] [--models provider/model,...] [--top N] [--lambda 0..1]",
  "",
  "  (no task)  ask for the task first, then probe",
  "  (task)     probe it directly — a model picker appears after the probe",
  "  --apply   switch onto the winning model and run the task without asking",
  "  --dry     list the candidates that would be probed, without spending tokens",
  "  --models  probe exactly these routes instead of the configured/discovered set",
  "  --top     cap how many discovered candidates are probed (default 4)",
  "  --lambda  cost weight for this run: 0 = quality only, 1 = cost dominates",
].join("\n");

/** Instruction for the probe call: plan only, JSON only, no prose. */
const PROBE_SYSTEM = [
  "You are scoping a software engineering task before any work starts.",
  "Do not write code and do not explain. Reply with one JSON object and nothing else.",
  "",
  "Schema:",
  '{"plan":["<step>", "..."],"files":["<path>"],"est_turns":<int>,',
  '"tool_calls":{"read":<int>,"grep":<int>,"edit":<int>,"bash":<int>},',
  '"risk":"low|medium|high","blockers":["<missing fact or permission>"],"confidence":<0..1>}',
  "",
  "Rules: 3-10 steps, concrete and ordered; use paths from the workspace listing when one is given",
  "and never invent files outside it; estimate the number of model turns the work needs; list only",
  "blockers you genuinely cannot resolve from the task.",
].join("\n");

/** Defaults for one `/scout` invocation; every field is overridable from plugin config. */
const DEFAULTS = {
  /** Explicit candidate routes; when empty the plugin discovers configured models. */
  candidates: [],
  /** Cost weight in the utility function: 0 ignores cost, 1 makes it decisive. */
  lambda: 0.5,
  /** Max candidates probed per invocation. */
  topK: 4,
  /** `max_tokens` for one probe reply. */
  maxProbeTokens: 500,
  /** Wall-clock budget for one probe. */
  probeTimeoutMs: 60_000,
  /** Sampling temperature for probes; undefined leaves the route default. */
  probeTemperature: 0,
  /** Re-probe the top-2 when their utility gap is below this; 0 disables. */
  reprobeGap: 0.15,
  /** Per-turn system prompt + tool schema cost assumed for the real task. */
  fixedOverheadTokens: 3000,
};

/** Model ids that are clearly not chat models and should not be probed. */
const NON_CHAT_MODEL = /(embed|rerank|whisper|tts|speech|dall|stable-diffusion|moderation)/iu;

/**
 * Register `/scout` for every composed human-command adapter.
 * @param {object} ctx - Cordis context carrying `commands` and `llm`.
 * @param {object} [config] - plugin configuration overriding {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: "scout",
      description: "Probe configured models for a task, rank them by plan quality vs. token cost",
      input: {
        hint: "task description [--apply] [--dry] [--models a/b] [--top N]",
      },
      handler: (invocation) => runScout(ctx, settings, invocation),
    });
  }, "scout: /scout command");
}

/**
 * Merge plugin config over the defaults, rejecting malformed values loudly.
 * @param {object} config - untrusted plugin configuration.
 * @returns {typeof DEFAULTS} resolved settings.
 */
function resolveSettings(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };

  const candidates = Array.isArray(merged.candidates)
    ? merged.candidates.map(parseRouteSpec).filter((route) => route !== undefined)
    : [];

  return {
    ...merged,
    candidates,
    lambda: clamp01(Number(merged.lambda), DEFAULTS.lambda),
    topK: positiveInt(merged.topK, DEFAULTS.topK),
    maxProbeTokens: positiveInt(merged.maxProbeTokens, DEFAULTS.maxProbeTokens),
    probeTimeoutMs: positiveInt(merged.probeTimeoutMs, DEFAULTS.probeTimeoutMs),
    probeTemperature: Number.isFinite(Number(merged.probeTemperature)) ? Number(merged.probeTemperature) : DEFAULTS.probeTemperature,
    reprobeGap: Number.isFinite(Number(merged.reprobeGap)) ? Math.max(0, Number(merged.reprobeGap)) : DEFAULTS.reprobeGap,
    fixedOverheadTokens: positiveInt(merged.fixedOverheadTokens, DEFAULTS.fixedOverheadTokens),
  };
}

/**
 * Parse `provider/model` or `{ provider, model }` into a candidate route.
 * @param {string|object} spec - configuration entry.
 * @returns {{provider: string, model: string}|undefined} parsed route.
 */
function parseRouteSpec(spec) {
  if (spec !== null && typeof spec === "object") {
    const { provider, model } = spec;
    if (typeof provider === "string" && typeof model === "string" && provider.length > 0 && model.length > 0) {
      return { provider, model };
    }
    return undefined;
  }
  if (typeof spec !== "string") return undefined;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/**
 * Execute one `/scout` invocation.
 * @param {object} ctx - plugin context.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @param {object} invocation - command invocation from `dsh-commands`.
 * @returns {Promise<{kind: string, text: string}>} command result.
 */
async function runScout(ctx, settings, invocation) {
  const args = parseArgs(invocation.rawInput ?? "");
  const signal = invocation.signal;
  const wizard = args.task.length === 0;

  let task = args.task;

  // Bare `/scout` is a wizard: ask for the task instead of demanding it as an argument.
  if (wizard) {
    if (args.dry) return { kind: "error", text: USAGE };
    if (typeof ctx.userQuestions?.ask !== "function") {
      return { kind: "error", text: "scout: this surface has no question UI. Pass the task instead: /scout <task>" };
    }
    let answer;
    try {
      answer = await askUser(
        ctx,
        invocation.agent,
        [
          {
            id: "task",
            header: "Scout",
            question: "要对哪个任务做模型探测？",
            detail: "探测只让各模型给出一份计划，不执行任何操作。",
          },
        ],
        signal,
      );
    } catch (error) {
      return { kind: "error", text: `scout: 问题卡没有弹出来（${messageOf(error)}）。可以改用 /scout <task> 直接传任务。` };
    }
    task = answerValue(answer, "task");
    if (task.length === 0) {
      return { kind: "error", text: "scout: 已取消（没有收到任务描述）。用法见 /scout --dry。" };
    }
  }

  const taskTokens = estimateTextTokens(task);

  let candidates;
  try {
    candidates = await resolveCandidates(ctx, invocation.agent, settings, args, signal);
  } catch (error) {
    return { kind: "error", text: `scout: could not resolve candidates — ${messageOf(error)}` };
  }

  if (candidates.length === 0) {
    return {
      kind: "error",
      text: 'scout: no models to probe. Add `candidates: ["provider/model", ...]` to the plugin config, or configure a provider with a model catalog.',
    };
  }

  if (args.dry) {
    const lines = [`scout · dry run · ${candidates.length} candidate(s)`, `task: ${truncate(task, 120)}`, ""];
    for (const candidate of candidates) lines.push(`  - ${candidate.provider}/${candidate.model}`);
    lines.push("", "  ▸ nothing was probed; drop --dry to run the probes.");
    return { kind: "success", text: lines.join("\n") };
  }

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const started = Date.now();
      try {
        const probed = await probe(ctx, invocation.agent, candidate, task, settings, signal);
        return { candidate, ...probed, elapsedMs: Date.now() - started };
      } catch (error) {
        return { candidate, error: messageOf(error), elapsedMs: Date.now() - started };
      }
    }),
  );

  const rows = results.map((result) =>
    result.error !== undefined
      ? result
      : {
          ...buildRow({
            candidate: result.candidate,
            plan: result.plan,
            taskTokens,
            fixedOverheadTokens: settings.fixedOverheadTokens,
            pathExists: makePathExists(invocation.agent),
          }),
          elapsedMs: result.elapsedMs,
        },
  );

  const usable = rows.filter((row) => row.error === undefined);
  const failed = rows.filter((row) => row.error !== undefined);
  const lambda = args.lambda ?? settings.lambda;
  let ranked = [...rankRows(usable, lambda), ...failed];

  // A single sample cannot separate models that drift by more than they
  // differ (self-check: mean within-model drift 0.45 vs between-model spread
  // 0.26), so when the top-2 land inside that noise, probe them once more and
  // average before anyone picks a winner.
  let reprobeNote = "";
  if (settings.reprobeGap > 0 && usable.length >= 2) {
    const preview = rankRows(usable, lambda);
    const gap = preview[0].utility - preview[1].utility;
    if (gap < settings.reprobeGap) {
      const resampled = await Promise.all(
        [preview[0], preview[1]].map(async (row) => {
          const started = Date.now();
          try {
            const { plan } = await probe(ctx, invocation.agent, row.candidate, task, settings, signal);
            const second = {
              ...buildRow({
                candidate: row.candidate,
                plan,
                taskTokens,
                fixedOverheadTokens: settings.fixedOverheadTokens,
                pathExists: makePathExists(invocation.agent),
              }),
              elapsedMs: Date.now() - started,
            };
            return { row, second };
          } catch {
            return { row, second: undefined };
          }
        }),
      );

      const notes = [];
      for (const { row, second } of resampled) {
        if (second === undefined) {
          notes.push(`${labelOf(row)} re-probe failed`);
          continue;
        }
        const merged = combineRows(row, second);
        usable[usable.findIndex((entry) => entry.candidate === row.candidate)] = merged;
        notes.push(
          `${labelOf(row)} ${row.quality.toFixed(2)}+${second.quality.toFixed(2)}→${merged.quality.toFixed(2)}` +
            (merged.qualitySpread >= 0.2 ? " volatile" : " stable"),
        );
      }
      ranked = [...rankRows(usable, lambda), ...failed];
      reprobeNote = `\n\n  ▸ re-probe (gap ${gap.toFixed(2)} < ${settings.reprobeGap}): ${notes.join(" · ")}`;
    }
  }

  const winner = ranked.find((row) => row.error === undefined);
  const qualityLeader = usable.length > 0 ? [...usable].sort((a, b) => b.quality - a.quality)[0] : undefined;

  // Pick a model interactively after every probe, unless `--apply` opted out.
  // A card is the point of the command; the table alone never switches anything.
  let chosen = args.apply ? winner : undefined;
  let pickNote = "";
  let skipped = false;
  if (winner !== undefined && !args.apply) {
    try {
      const pairs = pickerPairs(usable);
      const pick = await askUser(
        ctx,
        invocation.agent,
        [
          {
            id: "pick",
            header: "Scout",
            question: `用哪个模型执行？（已探测 ${usable.length} 个，选完立即开始）`,
            options: [
              ...pairs.map((pair, index) => ({
                label: index === 0 ? `${pair.label} ⭐推荐` : pair.label,
                description: pairDescription(pair.row, index),
              })),
              { label: KEEP_CURRENT, description: "不切换，直接用当前模型执行" },
            ],
          },
        ],
        signal,
      );

      const pickValue = answerValue(pick, "pick");
      const pair = pairs.find((candidate) => pickValue === candidate.label || pickValue === `${candidate.label} ⭐推荐`);
      if (pair !== undefined) {
        chosen = pair.row;
      } else if (pickValue === KEEP_CURRENT) {
        chosen = undefined;
      } else {
        // Skipped or dismissed: switch nothing and run nothing.
        skipped = true;
      }
    } catch (error) {
      pickNote = `\n\n  ▸ 选择卡不可用（${messageOf(error)}），任务未执行；可加 --apply 直接采用推荐并执行。`;
    }
  }

  let applied = false;
  if (chosen !== undefined) {
    invocation.agent.model.select({ provider: chosen.candidate.provider, model: chosen.candidate.model });
    applied = true;
  }

  // Hand the task to the agent unless the card was dismissed. The selection is
  // already recorded, so the next step — the one this message opens — runs on
  // the chosen model. `--apply` runs too; it is the same closed loop, unattended.
  let dispatched = false;
  if (winner !== undefined && !skipped && pickNote.length === 0 && task.length > 0) {
    try {
      invocation.agent.followup(scoutTaskMessage(task));
      dispatched = true;
    } catch (error) {
      pickNote = `\n\n  ▸ 任务未能排队（${messageOf(error)}）；模型已${applied ? "切换" : "保持"}，可手动发送任务。`;
    }
  }

  const recommendation =
    winner === undefined
      ? undefined
      : dispatched
        ? applied && chosen !== undefined
          ? `queued on ${labelOf(chosen)} — quality ${chosen.quality.toFixed(2)}, est. ${formatTokens(chosen.totalTokens)} tokens (${chosen.turns} turn${chosen.turns === 1 ? "" : "s"}); the task starts now`
          : `queued on the current model — winner was ${labelOf(winner)} (quality ${winner.quality.toFixed(2)}, est. ${formatTokens(winner.totalTokens)} tokens)`
        : applied && chosen !== undefined
          ? `applied: ${labelOf(chosen)} — quality ${chosen.quality.toFixed(2)}, est. ${formatTokens(chosen.totalTokens)} tokens (${chosen.turns} turn${chosen.turns === 1 ? "" : "s"})`
          : `recommend: ${labelOf(winner)} — quality ${winner.quality.toFixed(2)}, est. ${formatTokens(winner.totalTokens)} tokens (${winner.turns} turn${winner.turns === 1 ? "" : "s"})`;

  const text = renderReport({ task, rows: ranked, lambda, applied, recommendation, qualityLeader }) + reprobeNote + pickNote;
  return { kind: winner === undefined ? "error" : "success", text };
}

/**
 * Build the follow-up user message that hands the probed task to the agent.
 *
 * The loop's own messages come from `createUserMessage`, which lives in a host
 * package this plugin cannot import; a hand-built frozen message with a
 * collision-free `scout-` prefixed id feeds `followup()` the same shape.
 *
 * @param {string} task - verbatim task text.
 * @returns {object} frozen user message.
 */
function scoutTaskMessage(task) {
  return Object.freeze({
    id: `scout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    role: "user",
    content: Object.freeze([{ type: "text", text: task }]),
    source: Object.freeze({ kind: "user" }),
  });
}

/** Option label meaning "run on the current model without switching". */
const KEEP_CURRENT = "保持当前模型";

/**
 * Build picker option labels: bare model id, disambiguated to provider/model
 * only when two candidates share a model id, and kept unique defensively.
 *
 * @param {object[]} usable - probed rows that returned a plan.
 * @returns {{label: string, row: object}[]} label-to-row pairs in rank order.
 */
function pickerPairs(usable) {
  const counts = new Map();
  for (const row of usable) {
    counts.set(row.candidate.model, (counts.get(row.candidate.model) ?? 0) + 1);
  }

  const seen = new Set();
  return usable.map((row) => {
    let label = (counts.get(row.candidate.model) ?? 0) > 1 ? labelOf(row) : row.candidate.model;
    while (seen.has(label)) label = `…${label}`;
    seen.add(label);
    return { label, row };
  });
}

/**
 * One scannable line per option: verdict first, then the two costs.
 * @param {object} row - probed row.
 * @param {number} index - rank position (0 = recommended).
 * @returns {string} option description.
 */
function pairDescription(row, index) {
  const quality = row.quality >= 0.6 ? "质量好" : row.quality >= 0.4 ? "质量一般" : "质量存疑";
  const tokens = formatTokens(row.totalTokens);
  const seconds = ((row.elapsedMs ?? 0) / 1000).toFixed(1);
  return `第${index + 1}名 · ${quality} ${row.quality.toFixed(2)} · 预计 ${tokens} token · 响应 ${seconds}s`;
}

/**
 * Route label used in tables and option labels.
 * @param {{candidate: {provider: string, model: string}}} row - ranked row.
 * @returns {string} `provider/model`.
 */
function labelOf(row) {
  return `${row.candidate.provider}/${row.candidate.model}`;
}

/**
 * Ask the human through the composed question UI.
 *
 * The service is optional: headless deployments have no answerer, so every
 * caller must handle `undefined` and fall back to non-interactive behaviour.
 *
 * @param {object} ctx - plugin context.
 * @param {object} agent - live root agent owning the session.
 * @param {object[]} questions - question descriptors.
 * @param {AbortSignal} signal - command cancellation.
 * @param {number} [timeoutMs] - soft bound, so an unanswered card cannot hang the command forever.
 * @returns {Promise<object|undefined>} structured answer, or undefined when unavailable/cancelled.
 */
async function askUser(ctx, agent, questions, signal, timeoutMs = 120_000) {
  if (typeof ctx.userQuestions?.ask !== "function") {
    throw new Error("userQuestions service is not mounted on this context");
  }

  const controller = new AbortController();
  const forward = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", forward, { once: true });

  const timer = setTimeout(() => controller.abort(new Error("scout: question timed out")), timeoutMs);

  try {
    return await ctx.userQuestions.ask({ agent, questions, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}

/**
 * Read one question's answer as a single string: custom text wins over options.
 * @param {object|undefined} answer - answer batch from `ctx.userQuestions.ask`.
 * @param {string} id - question id.
 * @returns {string} trimmed answer, or '' when unanswered.
 */
function answerValue(answer, id) {
  const item = answer?.answers?.find((entry) => entry.id === id);
  if (item === undefined) return "";
  if (typeof item.custom === "string" && item.custom.trim().length > 0) return item.custom.trim();
  return (item.selected?.[0] ?? "").trim();
}

/**
 * Run one probe call against one candidate route.
 * @param {object} ctx - plugin context.
 * @param {object} agent - the receiving agent (supplies the session id).
 * @param {{provider: string, model: string}} candidate - route to probe.
 * @param {string} task - the raw task text.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<{plan: ReturnType<typeof normalizePlan>}>} normalized plan.
 */
async function probe(ctx, agent, candidate, task, settings, signal) {
  const callSignal = withTimeout(settings.probeTimeoutMs, signal);

  const call = await ctx.llm.prepareCall(
    { provider: candidate.provider, model: candidate.model, maxTokens: settings.maxProbeTokens },
    callSignal,
    (controls, modelInfo) => {
      // Probe at the cheapest reasoning effort the route advertises, and pin the
      // temperature so two runs of the same task are comparable.
      const effort = modelInfo?.reasoning?.efforts?.[0]?.id;
      const next = settings.probeTemperature === undefined ? { ...controls } : { ...controls, temperature: settings.probeTemperature };
      return effort === undefined ? next : { ...next, reasoningEffort: effort };
    },
  );

  // Hand-built request: the plugin carries no host imports, so the message is a
  // plain object. The adapter only reads role/content; identity fields are the
  // loop's business, and probe calls never enter the session log.
  const request = Object.freeze({
    ...call.config,
    system: PROBE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: probeInput(task, agent) }],
        source: { kind: "user" },
      },
    ],
    sessionId: agent?.session?.id,
    signal: callSignal,
  });

  const text = await collectText(call.stream(request));

  if (text.length === 0) throw new Error("probe returned no text");

  const parsed = parsePlan(text);
  if (parsed === undefined) throw new Error(`reply is not a JSON plan: ${truncate(text, 100)}`);

  return { plan: normalizePlan(parsed) };
}

/**
 * Collect assistant text from a raw chunk stream.
 *
 * Prefers `text-delta` fragments; falls back to completed text blocks for
 * adapters that emit whole blocks instead of deltas. Terminal `error` /
 * `aborted` finishes throw so the caller reports a failed probe.
 *
 * @param {AsyncIterable<object>} stream - raw model chunks.
 * @returns {Promise<string>} trimmed assistant text.
 */
async function collectText(stream) {
  let deltas = "";
  let blocks = "";
  let finishKind;

  for await (const chunk of stream) {
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
      deltas += chunk.text;
    } else if (chunk?.type === "block-end" && chunk.block?.type === "text" && typeof chunk.block.text === "string") {
      blocks += chunk.block.text;
    }
    if (chunk?.type === "finish") {
      finishKind = chunk.finish?.kind ?? chunk.kind ?? finishKind;
    }
    if (chunk?.type === "error") {
      finishKind = "error";
    }
  }

  if (finishKind === "error") throw new Error("probe request failed");
  if (finishKind === "aborted") throw new Error("probe aborted");

  return (deltas.length > 0 ? deltas : blocks).trim();
}

/**
 * Resolve which routes to probe: explicit flags, then config, then discovery.
 * @param {object} ctx - plugin context.
 * @param {object} agent - the receiving agent.
 * @param {typeof DEFAULTS} settings - resolved settings.
 * @param {{models: string[], top: number}} args - parsed invocation flags.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<Array<{provider: string, model: string}>>} deduplicated candidates.
 */
async function resolveCandidates(ctx, agent, settings, args, signal) {
  if (args.models.length > 0) {
    return dedupe(args.models.map(parseRouteSpec).filter((route) => route !== undefined));
  }

  if (settings.candidates.length > 0) {
    return dedupe(settings.candidates).slice(0, args.top ?? settings.topK);
  }

  const discovered = await discoverCandidates(ctx, signal);
  const current = agent?.model?.current?.();

  const list = discovered.length > 0 ? discovered : current === undefined ? [] : [{ provider: current.provider, model: current.model }];
  return dedupe(list).slice(0, args.top ?? settings.topK);
}

/**
 * Enumerate chat models across every registered provider.
 *
 * Catalog calls are best-effort: a provider whose discovery fails, hangs, or
 * advertises nothing simply contributes no candidates.
 *
 * @param {object} ctx - plugin context.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<Array<{provider: string, model: string}>>} discovered routes.
 */
async function discoverCandidates(ctx, signal) {
  if (typeof ctx.llm?.listProviders !== "function") return [];

  const providers = ctx.llm.listProviders() ?? [];
  const out = [];

  for (const provider of providers) {
    const providerId = provider?.id ?? provider?.provider ?? provider?.name;
    if (typeof providerId !== "string" || providerId.length === 0) continue;

    try {
      const models = await withTimeout(8_000, signal, ctx.llm.listModels(providerId));
      for (const model of models ?? []) {
        const modelId = model?.id ?? model?.model ?? model?.name;
        if (typeof modelId !== "string" || modelId.length === 0) continue;
        if (NON_CHAT_MODEL.test(modelId)) continue;
        out.push({ provider: providerId, model: modelId });
      }
    } catch {
      // Provider catalog unavailable; skip it rather than failing the whole command.
    }
  }

  return out;
}

/**
 * Parse `/scout` arguments into a task and flags.
 * @param {string} raw - verbatim text after the command name.
 * @returns {{task: string, apply: boolean, dry: boolean, models: string[], top: number|undefined}} parsed arguments.
 */
function parseArgs(raw) {
  const tokens = raw.split(/\s+/u).filter((token) => token.length > 0);
  const rest = [];
  const models = [];
  let apply = false;
  let dry = false;
  let top;
  let lambda;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--apply") apply = true;
    else if (token === "--dry") dry = true;
    else if (token === "--models") {
      const value = tokens[i + 1] ?? "";
      i += 1;
      models.push(...value.split(",").filter((item) => item.length > 0));
    } else if (token.startsWith("--models=")) {
      models.push(...token.slice("--models=".length).split(",").filter((item) => item.length > 0));
    } else if (token === "--top") {
      top = Number(tokens[i + 1]);
      i += 1;
    } else if (token === "--lambda") {
      lambda = Number(tokens[i + 1]);
      i += 1;
    } else if (token.startsWith("--lambda=")) {
      lambda = Number(token.slice("--lambda=".length));
    } else rest.push(token);
  }

  return {
    task: rest.join(" ").trim(),
    apply,
    dry,
    models,
    top: Number.isFinite(top) && top > 0 ? Math.round(top) : undefined,
    lambda: Number.isFinite(lambda) ? Math.min(1, Math.max(0, lambda)) : undefined,
  };
}

/**
 * Combine a caller signal with a timeout.
 * @param {number} ms - timeout in milliseconds.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @param {Promise} [promise] - when supplied, race the promise against the timeout instead of returning a signal.
 * @returns {AbortSignal|Promise} combined signal, or a promise raced against the deadline.
 */
function withTimeout(ms, signal, promise) {
  const timeout = AbortSignal.timeout(ms);
  const combined =
    signal === undefined
      ? timeout
      : typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : fallbackAny(signal, timeout);

  if (promise === undefined) return combined;

  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const abort = () => reject(combined.reason ?? new Error(`timed out after ${ms}ms`));
      if (combined.aborted) abort();
      else combined.addEventListener("abort", abort, { once: true });
    }),
  ]);
}

/**
 * Combine two signals where `AbortSignal.any` is unavailable.
 * @param {AbortSignal} a - first signal.
 * @param {AbortSignal} b - second signal.
 * @returns {AbortSignal} controller signal aborted when either input aborts.
 */
function fallbackAny(a, b) {
  const controller = new AbortController();
  const forward = (source) => () => controller.abort(source.reason);
  if (a.aborted || b.aborted) controller.abort(a.reason ?? b.reason);
  else {
    a.addEventListener("abort", forward(a), { once: true });
    b.addEventListener("abort", forward(b), { once: true });
  }
  return controller.signal;
}

/**
 * Stable dedupe of candidate routes, preserving first-seen order.
 * @param {Array<{provider: string, model: string}>} routes - candidate routes.
 * @returns {Array<{provider: string, model: string}>} unique routes.
 */
function dedupe(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = `${route.provider}\u0000${route.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

/**
 * Compose the probe's user turn: workspace shape, then the task.
 *
 * Without this a plan can only guess at paths, and a plan that edits a file
 * which does not exist scores better than it deserves. The listing is shallow
 * on purpose — enough to anchor real names without paying for a tree walk.
 *
 * @param {string} task - raw task text.
 * @param {object} agent - receiving agent, for its session cwd.
 * @returns {string} probe input.
 */
function probeInput(task, agent) {
  const hint = workspaceHint(agent);
  const header = hint.length > 0 ? `${hint}\n\n` : "";
  return `${header}Task:\n${task}\n\nReply with the JSON object only.`;
}

/** Directories never worth listing: they are noise or huge. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor", "coverage"]);

/**
 * Build a shallow workspace listing anchored at the session's cwd.
 * @param {object} agent - receiving agent.
 * @returns {string} listing text, or '' when the cwd is unknown or unreadable.
 */
function workspaceHint(agent) {
  const cwd = cwdOf(agent);
  if (cwd === undefined) return "";

  try {
    const describe = (entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name);
    const top = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
      .slice(0, 40);

    const lines = [`Workspace root: ${cwd}`, `Top level: ${top.map(describe).join(", ")}`];

    for (const dir of top.filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name)).slice(0, 6)) {
      try {
        const children = readdirSync(join(cwd, dir.name), { withFileTypes: true })
          .filter((entry) => !entry.name.startsWith("."))
          .slice(0, 10)
          .map(describe);
        if (children.length > 0) lines.push(`${dir.name}/: ${children.join(", ")}`);
      } catch {
        // Unreadable subdirectory: list its parent only.
      }
    }

    return lines.join("\n");
  } catch {
    return `Workspace root: ${cwd}`;
  }
}

/**
 * Resolve the workspace directory for an agent, falling back to the process cwd.
 * @param {object} agent - receiving agent.
 * @returns {string|undefined} absolute directory path.
 */
function cwdOf(agent) {
  const candidates = [agent?.session?.meta?.cwd, agent?.session?.cwd, agent?.options?.cwd];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return typeof process?.cwd === "function" ? process.cwd() : undefined;
}

/**
 * Build a path-existence predicate rooted at the agent's cwd.
 *
 * Plans name files; this is the only cheap way to tell a plan that looked at
 * the repository from one that guessed. Absolute paths are honoured as-is.
 *
 * @param {object} agent - receiving agent.
 * @returns {((path: string) => boolean)|undefined} predicate, or undefined when cwd is unknown.
 */
function makePathExists(agent) {
  const cwd = cwdOf(agent);
  if (cwd === undefined) return undefined;
  return (file) => {
    const target = /^([A-Za-z]:[\\/]|\/)/u.test(file) ? file : join(cwd, file);
    try {
      return existsSync(target);
    } catch {
      return false;
    }
  };
}

/**
 * Clamp a number into [0, 1].
 * @param {number} value - candidate.
 * @param {number} fallback - used when `value` is not finite.
 * @returns {number} clamped value.
 */
function clamp01(value, fallback) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/**
 * Coerce to a positive integer or fall back.
 * @param {number} value - candidate.
 * @param {number} fallback - used when `value` is not a positive finite number.
 * @returns {number} positive integer.
 */
function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/**
 * Extract a human-readable message from an unknown error.
 * @param {unknown} error - thrown value.
 * @returns {string} message text.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
