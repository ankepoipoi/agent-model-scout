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

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { estimateTextTokens, formatTokens } from "./estimate.js";
import { buildRow, normalizePlan, parsePlan, rankRows } from "./plan.js";
import { renderReport, truncate } from "./render.js";

/** Cordis plugin identity. */
export const name = "scout";

/** Services this plugin needs mounted before it can apply. */
export const inject = ["commands", "llm"];

const USAGE = [
  "Usage: /scout <task> [--apply] [--dry] [--models provider/model,provider/model] [--top N]",
  "",
  "  --apply   switch this agent onto the winning model (takes effect next step)",
  "  --dry     list the candidates that would be probed, without spending tokens",
  "  --models  probe exactly these routes instead of the configured/discovered set",
  "  --top     cap how many discovered candidates are probed (default 4)",
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
  "Rules: 3-10 steps, concrete and ordered; name real-looking paths; estimate the number of",
  "model turns the work needs; list only blockers you genuinely cannot resolve from the task.",
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
  if (args.task.length === 0) return { kind: "error", text: USAGE };

  const signal = invocation.signal;
  const taskTokens = estimateTextTokens(args.task);

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
    const lines = [`scout · dry run · ${candidates.length} candidate(s)`, `task: ${truncate(args.task, 120)}`, ""];
    for (const candidate of candidates) lines.push(`  - ${candidate.provider}/${candidate.model}`);
    lines.push("", "  ▸ nothing was probed; drop --dry to run the probes.");
    return { kind: "success", text: lines.join("\n") };
  }

  const results = await Promise.all(
    candidates.map(async (candidate) => {
      const started = Date.now();
      try {
        const probed = await probe(ctx, invocation.agent, candidate, args.task, settings, signal);
        return { candidate, ...probed, elapsedMs: Date.now() - started };
      } catch (error) {
        return { candidate, error: messageOf(error), elapsedMs: Date.now() - started };
      }
    }),
  );

  const rows = results.map((result) =>
    result.error !== undefined
      ? result
      : buildRow({
          candidate: result.candidate,
          plan: result.plan,
          taskTokens,
          fixedOverheadTokens: settings.fixedOverheadTokens,
        }),
  );

  const usable = rows.filter((row) => row.error === undefined);
  const failed = rows.filter((row) => row.error !== undefined);
  const ranked = [...rankRows(usable, settings.lambda), ...failed];

  const winner = ranked.find((row) => row.error === undefined);
  const recommendation =
    winner === undefined
      ? undefined
      : `recommend: ${winner.candidate.provider}/${winner.candidate.model} — quality ${winner.quality.toFixed(2)}, est. ${formatTokens(winner.totalTokens)} tokens (${winner.turns} turns)`;

  let applied = false;
  if (args.apply && winner !== undefined) {
    invocation.agent.model.select({ provider: winner.candidate.provider, model: winner.candidate.model });
    applied = true;
  }

  const text = renderReport({ task: args.task, rows: ranked, lambda: settings.lambda, applied, recommendation });
  return { kind: winner === undefined ? "error" : "success", text };
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
      // Probe at the cheapest reasoning effort the route advertises.
      const effort = modelInfo?.reasoning?.efforts?.[0]?.id;
      return effort === undefined ? controls : { ...controls, reasoningEffort: effort };
    },
  );

  const messages = [
    createUserMessage({
      content: [{ type: "text", text: `Task:\n${task}\n\nReply with the JSON object only.` }],
      source: { kind: "user" },
    }),
  ];

  const request = Object.freeze({
    ...call.config,
    messages,
    system: PROBE_SYSTEM,
    sessionId: agent?.session?.id,
    signal: callSignal,
  });

  const assembler = new BlockAssembler();
  for await (const chunk of call.stream(request)) assembler.push(chunk);

  const finish = assembler.finish;
  if (finish === undefined) throw new Error("probe stream ended without a finish reason");
  if (finish.kind === "error") throw new Error(finish.failure?.message ?? "probe request failed");
  if (finish.kind === "aborted") throw new Error("probe aborted");

  const text = assembler
    .blocks()
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (text.length === 0) throw new Error("probe returned no text");

  const parsed = parsePlan(text);
  if (parsed === undefined) throw new Error(`reply is not a JSON plan: ${truncate(text, 100)}`);

  return { plan: normalizePlan(parsed) };
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
    } else rest.push(token);
  }

  return {
    task: rest.join(" ").trim(),
    apply,
    dry,
    models,
    top: Number.isFinite(top) && top > 0 ? Math.round(top) : undefined,
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
