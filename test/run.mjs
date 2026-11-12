/**
 * Pure-logic tests for the route plugin. These cover everything that does not
 * need the DSH runtime: estimation, plan parsing, scoring, ranking, rendering.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 "<app>" test/run.mjs   (see README)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTaskTokens, estimateTextTokens, formatTokens } from "../lib/estimate.js";
import { applyPriors, appendDispatch, classifyFollowUp, loadOutcomes, priorsFrom, priorRow, saveOutcomes, settleFromEvents } from "../lib/outcome.js";
import { buildRow, combineRows, normalizePlan, parsePlan, qualityOf, rankRows, suggestEffort } from "../lib/plan.js";
import { renderReport, truncate } from "../lib/render.js";

const tmpBase = mkdtempSync(join(tmpdir(), "scout-test-"));

let passed = 0;
const failures = [];

/**
 * Run one named assertion group.
 * @param {string} label - test name.
 * @param {() => void} fn - assertions to run.
 */
function test(label, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

test("estimateTextTokens prices CJK and ASCII separately", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("中文测试"), 2); // 4 * 0.6 = 2.4 → 2
  assert.equal(estimateTextTokens("abcd"), 1); // 4 * 0.3 = 1.2 → 1
  assert.ok(estimateTextTokens("中文中文中文") > estimateTextTokens("abcdef"));
});

test("estimateTaskTokens grows with turn count and is quadratic in tool output", () => {
  const short = estimateTaskTokens({ plan: { est_turns: 3 }, taskTokens: 500 });
  const long = estimateTaskTokens({ plan: { est_turns: 12 }, taskTokens: 500 });
  assert.equal(short.turns, 3);
  assert.equal(long.turns, 12);
  assert.ok(long.totalTokens > short.totalTokens * 3, "12 turns should cost far more than 4x of 3");
});

test("estimateTaskTokens clamps absurd turn counts", () => {
  assert.equal(estimateTaskTokens({ plan: { est_turns: 9999 }, taskTokens: 10 }).turns, 60);
  assert.equal(estimateTaskTokens({ plan: {}, taskTokens: 10, defaultTurns: 7 }).turns, 7);
});

test("formatTokens compacts counts", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(12345), "12k");
  assert.equal(formatTokens(1_234_567), "1.23M");
});

test("parsePlan accepts fenced JSON", () => {
  const plan = parsePlan('```json\n{"plan":["a"],"est_turns":2}\n```');
  assert.deepEqual(plan?.plan, ["a"]);
});

test("parsePlan survives prose around the object", () => {
  const plan = parsePlan('Sure! Here is the plan:\n{"plan":["read x"],"risk":"low"}\nHope that helps.');
  assert.equal(plan?.risk, "low");
});

test("parsePlan handles braces inside strings", () => {
  const plan = parsePlan('{"plan":["patch {loader}.ts"],"files":["src/a.ts"]}');
  assert.deepEqual(plan?.files, ["src/a.ts"]);
});

test("parsePlan returns undefined for non-JSON", () => {
  assert.equal(parsePlan("I would start by reading the config."), undefined);
  assert.equal(parsePlan('{"plan":["unterminated"'), undefined);
});

test("normalizePlan coerces hostile shapes", () => {
  const plan = normalizePlan({
    plan: ["a", { step: "b" }, "", 42],
    files: ["x.ts", null, "  "],
    est_turns: "12",
    tool_calls: { edit: "2", bogus: "many" },
    risk: "HIGH",
    blockers: ["needs creds", 7],
    confidence: 5,
  });
  assert.deepEqual(plan.steps, ["a", "b"]);
  assert.deepEqual(plan.files, ["x.ts"]);
  assert.equal(plan.estTurns, 12);
  assert.deepEqual(plan.toolCalls, { edit: 2 });
  assert.equal(plan.risk, "high");
  assert.deepEqual(plan.blockers, ["needs creds"]);
  assert.equal(plan.confidence, 1);
});

test("qualityOf rewards concrete, verifiable plans and punishes blockers", () => {
  const strong = qualityOf(
    normalizePlan({
      plan: ["read src/config/loader.ts", "add parseConfig() in src/config/loader.ts", "wire into src/index.ts", "add unit test", "run vitest"],
      files: ["src/config/loader.ts", "src/index.ts", "test/loader.test.ts"],
      tool_calls: { read: 4, edit: 3, bash: 1 },
      risk: "medium",
      confidence: 0.8,
    }),
  );
  const weak = qualityOf(normalizePlan({ plan: ["do the task"], risk: "high", confidence: 0.1 }));
  assert.ok(strong.quality > weak.quality + 0.3, `expected clear gap, got ${strong.quality} vs ${weak.quality}`);
  assert.ok(strong.quality <= 1 && weak.quality >= 0);

  const plain = qualityOf(normalizePlan({ plan: ["a", "b", "c"] }));
  const blocked = qualityOf(normalizePlan({ plan: ["a", "b", "c"], blockers: ["no creds", "no repo"] }));
  assert.ok(blocked.quality < plain.quality, "stated blockers must lower the score");
});

test("qualityOf gives an empty plan near zero", () => {
  const empty = qualityOf(normalizePlan({}));
  assert.ok(empty.quality <= 0.05, `empty plan scored ${empty.quality}`);
});

test("rankRows prefers quality at low lambda and cheapness at high lambda", () => {
  const cheap = buildRow({
    candidate: { provider: "p", model: "cheap" },
    plan: normalizePlan({ plan: ["a", "b", "c"], files: ["x.ts"], est_turns: 3, confidence: 0.5 }),
    taskTokens: 300,
  });
  const strong = buildRow({
    candidate: { provider: "p", model: "strong" },
    plan: normalizePlan({
      plan: ["read src/a.ts", "edit src/a.ts", "add test", "run tests"],
      files: ["src/a.ts", "src/b.ts"],
      est_turns: 12,
      confidence: 0.9,
      tool_calls: { read: 3, edit: 2, bash: 1 },
    }),
    taskTokens: 300,
  });

  const qualityFirst = rankRows([cheap, strong], 0);
  assert.equal(qualityFirst[0].candidate.model, "strong", "λ=0 must rank by quality only");

  const costFirst = rankRows([cheap, strong], 1);
  assert.equal(costFirst[0].candidate.model, "cheap", "λ=1 must let cost dominate");
});

test("combineRows averages re-probe samples and records the spread", () => {
  const candidate = { provider: "zai-coding-cn", model: "glm-5.3" };
  const first = buildRow({ candidate, plan: normalizePlan({ plan: ["read a", "edit b"], est_turns: 2 }), taskTokens: 40 });
  const second = buildRow({ candidate, plan: normalizePlan({ plan: ["read a", "edit b", "test c"], est_turns: 5 }), taskTokens: 40 });
  const merged = combineRows(first, second);
  assert.equal(merged.quality, (first.quality + second.quality) / 2);
  assert.equal(merged.totalTokens, (first.totalTokens + second.totalTokens) / 2);
  assert.equal(merged.qualitySpread, Math.abs(first.quality - second.quality));
  assert.equal(merged.probes, 2);
  assert.ok(merged.turns >= 1, "averaged turns stay at least 1");
  assert.equal(merged.candidate, candidate, "identity is preserved for the picker");
});

test("suggestEffort maps plan complexity onto the effort ladder", () => {
  const ladder = ["min", "low", "medium", "high", "max"];
  const complex = normalizePlan({ plan: ["a", "b", "c", "d", "e", "f"], est_turns: 5, risk: "high" });
  const simple = normalizePlan({ plan: ["a"], est_turns: 1, risk: "low" });
  const middling = normalizePlan({ plan: ["a", "b", "c"], est_turns: 2, risk: "low" });
  assert.equal(suggestEffort(ladder, "medium", complex), "max", "risky many-step plans earn the deepest effort");
  assert.equal(suggestEffort(ladder, "medium", simple), "min", "simple plans get the cheapest effort");
  assert.equal(suggestEffort(ladder, "medium", middling), "medium", "the model's own default covers the middle");
  assert.equal(suggestEffort(["turbo", "sport"], undefined, middling), "sport", "unknown ids keep discovery order and fall in the middle");
  assert.equal(suggestEffort([], undefined, complex), undefined, "no efforts exposed means no suggestion");
});

test("renderReport includes every candidate and the recommendation", () => {
  const rows = rankRows(
    [
      buildRow({ candidate: { provider: "deepseek", model: "flash" }, plan: normalizePlan({ plan: ["a", "b"], est_turns: 4 }) }),
      buildRow({ candidate: { provider: "acme", model: "big" }, plan: normalizePlan({ plan: ["a"], est_turns: 9 }) }),
    ],
    0.5,
  );
  const text = renderReport({ task: "fix the loader", rows, lambda: 0.5, recommendation: "recommend: deepseek/flash" });
  assert.match(text, /deepseek\/flash/);
  assert.match(text, /acme\/big/);
  assert.match(text, /recommend: deepseek\/flash/);
  assert.match(text, /dry run/);
});

test("renderReport flags an empty plan instead of listing zero steps", () => {
  const rows = rankRows(
    [buildRow({ candidate: { provider: "p", model: "m" }, plan: normalizePlan({ est_turns: 8 }), taskTokens: 40 })],
    0.5,
  );
  const text = renderReport({ task: "x", rows, lambda: 0.5 });
  assert.match(text, /empty plan/);
});

test("buildRow floors self-reported turns by step count", () => {
  const one = buildRow({ candidate: { provider: "p", model: "one" }, plan: normalizePlan({ plan: ["a"], est_turns: 1 }), taskTokens: 40 });
  const many = buildRow({
    candidate: { provider: "p", model: "many" },
    plan: normalizePlan({ plan: ["a", "b", "c", "d", "e", "f"], est_turns: 1 }),
    taskTokens: 40,
  });
  assert.equal(one.turns, 1);
  assert.equal(many.turns, 6, "six steps cost six calls — one call per step, per calibration");
  assert.ok(many.totalTokens > one.totalTokens);
});

test("renderReport surfaces a higher-quality leader when value wins", () => {
  const strong = buildRow({
    candidate: { provider: "p", model: "strong" },
    plan: normalizePlan({
      plan: ["read src/a.ts", "edit src/a.ts", "add test", "run tests", "check types", "update docs"],
      files: ["a.ts", "b.ts"],
      tool_calls: { edit: 2, bash: 2 },
      confidence: 0.9,
      est_turns: 12,
    }),
    taskTokens: 40,
  });
  const cheap = buildRow({
    candidate: { provider: "p", model: "cheap" },
    plan: normalizePlan({ plan: ["a"], est_turns: 1 }),
    taskTokens: 40,
  });
  const rows = rankRows([cheap, strong], 1);
  const text = renderReport({ task: "x", rows, lambda: 1, recommendation: "recommend: p/cheap", qualityLeader: strong });
  assert.match(text, /quality leader: p\/strong/);
});

test("buildRow rewards existing paths and punishes invented ones", () => {
  const plan = normalizePlan({ plan: ["a", "b", "c", "d", "e", "f"], files: ["README.md"], est_turns: 3 });
  const grounded = buildRow({ candidate: { provider: "p", model: "grounded" }, plan, taskTokens: 40, pathExists: () => true });
  const invented = buildRow({ candidate: { provider: "p", model: "invented" }, plan, taskTokens: 40, pathExists: () => false });
  const unfiled = buildRow({
    candidate: { provider: "p", model: "unfiled" },
    plan: normalizePlan({ plan: ["a", "b", "c"], files: [] }),
    taskTokens: 40,
    pathExists: () => true,
  });

  assert.equal(grounded.parts.grounding, 0.1);
  assert.equal(invented.parts.grounding, -0.2);
  assert.equal(unfiled.parts.grounding, 0);

  // No predicate means nothing was checked: an unverified plan must not inherit
  // the bonus just because the missing list came back empty.
  const unverified = buildRow({ candidate: { provider: "p", model: "unverified" }, plan, taskTokens: 40 });
  assert.equal(unverified.parts.grounding, 0);
  assert.equal(unverified.groundingChecked, false);

  assert.ok(grounded.quality > invented.quality + 0.25, "invented paths must lose clearly");
});

test("renderReport renders probe failures without crashing", () => {
  const text = renderReport({
    task: "x",
    rows: [{ candidate: { provider: "p", model: "broken" }, error: "429 rate limited", elapsedMs: 12 }],
    lambda: 0.5,
  });
  assert.match(text, /429 rate limited/);
  assert.match(text, /no usable plan/);
});

test("truncate never exceeds the budget", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

// ---------- outcome log (v0.3) ----------

test("settleFromEvents links a dispatch to its turn via the scout message id", () => {
  const events = [
    { type: "model/selection", file: 1, time: 105, data: { provider: "zai-coding-cn", model: "glm-5.3", reasoningEffort: "max" } },
    { type: "user/message", file: 1, time: 100, data: { id: "scout-abc-1", role: "user", content: [{ type: "text", text: "do it" }] } },
    { type: "turn/start", file: 1, time: 110, data: { turn: 3 } },
    { type: "step/start", file: 1, time: 111, data: { turn: 3 } },
    { type: "assistant/message", file: 1, time: 112, data: { turn: 3, usage: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 20_000, cacheWriteTokens: 1_000 } } },
    { type: "step/start", file: 1, time: 113, data: { turn: 3 } },
    { type: "assistant/message", file: 1, time: 114, data: { turn: 3, usage: { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 25_000, cacheWriteTokens: 0 } } },
    // A later user message closes the dispatched turn.
    { type: "user/message", file: 1, time: 200, data: { id: "next-human", role: "user", content: [{ type: "text", text: "thanks" }] } },
  ];
  const records = [
    { messageId: "scout-abc-1", route: "zai-coding-cn/glm-5.3", predictedTokens: 100_000, predictedSteps: 2, dispatchedAt: 90 },
  ];
  const { settled } = settleFromEvents(records, events);
  assert.equal(settled, 1);
  assert.equal(records[0].actualRoute, "zai-coding-cn/glm-5.3", "the route that actually ran");
  assert.equal(records[0].actualSteps, 2);
  assert.equal(records[0].actualTokens, 61_800, "billed = input + cacheRead + cacheWrite + output across calls");
  assert.equal(records[0].actualCalls, 2);
});

test("settleFromEvents leaves a still-running turn pending", () => {
  const events = [
    { type: "user/message", file: 1, time: 100, data: { id: "scout-live-1", role: "user", content: [{ type: "text", text: "go" }] } },
    { type: "turn/start", file: 1, time: 110, data: { turn: 1 } },
    { type: "assistant/message", file: 1, time: 120, data: { turn: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    // Nothing follows: the turn may still be streaming, usage is partial.
  ];
  const records = [{ messageId: "scout-live-1", route: "p/m", predictedTokens: 50_000, dispatchedAt: 90 }];
  const { settled } = settleFromEvents(records, events);
  assert.equal(settled, 0);
  assert.equal(records[0].settledAt, undefined);
});

test("settleFromEvents ignores scout ids from another session file's numbering", () => {
  // Turn numbers restart per file: a same-id message must only match its own file.
  const events = [
    { type: "user/message", file: 1, time: 100, data: { id: "scout-x-1", role: "user", content: [{ type: "text", text: "a" }] } },
    { type: "turn/start", file: 2, time: 105, data: { turn: 1 } },
    { type: "user/message", file: 2, time: 200, data: { id: "other", role: "user", content: [{ type: "text", text: "b" }] } },
  ];
  const records = [{ messageId: "scout-x-1", route: "p/m", dispatchedAt: 90 }];
  assert.equal(settleFromEvents(records, events).settled, 0, "turn/start in another file must not claim the dispatch");
});

test("priorsFrom averages per-route ratios and prefers the route that ran", () => {
  const records = [
    { settledAt: 1, route: "(current)", actualRoute: "zai-coding-cn/glm-5.3", predictedTokens: 100_000, actualTokens: 90_000, predictedSteps: 4, actualSteps: 4 },
    { settledAt: 2, route: "zai-coding-cn/glm-5.3", predictedTokens: 100_000, actualTokens: 110_000, predictedSteps: 4, actualSteps: 6 },
    { settledAt: 3, route: "deepseek-official/deepseek-flash", predictedTokens: 50_000, actualTokens: 60_000 },
    { messageId: "scout-pending-1", route: "zai-coding-cn/glm-5.3", dispatchedAt: 4 }, // pending: ignored
  ];
  const priors = priorsFrom(records);
  assert.equal(priors.get("zai-coding-cn/glm-5.3").dispatches, 2);
  assert.equal(Math.round(priors.get("zai-coding-cn/glm-5.3").tokenRatio * 100), 100, "mean(0.9, 1.1)");
  assert.equal(priors.get("zai-coding-cn/glm-5.3").stepRatio, 1.25, "mean(4/4, 6/4)");
  assert.equal(priors.get("deepseek-official/deepseek-flash").tokenRatio, 1.2);
  assert.equal(priors.has("(current)"), false);
});

test("applyPriors calibrates estimates only past the dispatch floor", () => {
  const rows = [
    { candidate: { provider: "p", model: "a" }, totalTokens: 100_000 },
    { candidate: { provider: "p", model: "b" }, totalTokens: 100_000 },
  ];
  const priors = new Map([
    ["p/a", { dispatches: 3, tokenRatio: 1.25 }],
    ["p/b", { dispatches: 1, tokenRatio: 2 }],
  ]);
  const applied = applyPriors(rows, priors, 2);
  assert.equal(rows[0].totalTokens, 125_000);
  assert.equal(rows[1].totalTokens, 100_000, "below the floor: estimate untouched");
  assert.deepEqual(applied, ["p/a ×1.25 (3)"]);
});

test("outcome records round-trip through the JSONL log", () => {  const dir = join(tmpBase, "outcomes-roundtrip");
  rmSync(dir, { recursive: true, force: true });
  appendDispatch(dir, { messageId: "scout-rt-1", route: "p/m", predictedTokens: 1, dispatchedAt: 1 });
  appendDispatch(dir, { messageId: "", route: "p/m", dispatchedAt: 2 }); // rejected: no id
  const loaded = loadOutcomes(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].messageId, "scout-rt-1");
  const { settled } = settleFromEvents(loaded, [
    { type: "user/message", file: 1, time: 10, data: { id: "scout-rt-1", role: "user", content: [{ type: "text", text: "t" }] } },
    { type: "turn/start", file: 1, time: 20, data: { turn: 1 } },
    { type: "assistant/message", file: 1, time: 30, data: { turn: 1, usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
    { type: "turn/start", file: 1, time: 40, data: { turn: 2 } },
  ]);
  assert.equal(settled, 1);
  saveOutcomes(dir, loaded);
  assert.equal(loadOutcomes(dir)[0].actualTokens, 50);
  rmSync(dir, { recursive: true, force: true });
});

test("classifyFollowUp spots re-asks by complaint word or task overlap", () => {
  const task = "把 config loader 改成支持 .toml 并补测试";
  assert.equal(classifyFollowUp(task, ""), "none");
  assert.equal(classifyFollowUp(task, undefined), "none");
  assert.equal(classifyFollowUp(task, "还是不行，再来一次"), "reask", "explicit complaint");
  assert.equal(classifyFollowUp(task, "retry, it failed"), "reask");
  assert.equal(classifyFollowUp(task, "把 config loader 改成支持 .toml 并补测试，刚才没做"), "reask", "task repeated verbatim");
  assert.equal(classifyFollowUp(task, "很好，接着把日志也改了吧"), "continuation", "different work");
  assert.equal(classifyFollowUp("push to github and add a description", "now update the About section"), "continuation");
});

test("settleFromEvents records the follow-up classification", () => {
  const base = [
    { type: "user/message", file: 1, time: 100, data: { id: "scout-fu-1", role: "user", content: [{ type: "text", text: "修好那个 bug" }] } },
    { type: "turn/start", file: 1, time: 110, data: { turn: 2 } },
    { type: "assistant/message", file: 1, time: 120, data: { turn: 2, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } } },
  ];
  const complaint = { type: "user/message", file: 1, time: 200, data: { id: "human-1", role: "user", content: [{ type: "text", text: "还是不行，重试" }] } };
  const records = [{ messageId: "scout-fu-1", route: "p/m", task: "修好那个 bug", predictedTokens: 1000, dispatchedAt: 90 }];
  assert.equal(settleFromEvents(records, [...base, complaint]).settled, 1);
  assert.equal(records[0].followUp.kind, "reask");
  assert.ok(records[0].followUp.text.length > 0 && records[0].followUp.text.length <= 120);

  const fresh = [{ messageId: "scout-fu-2", route: "p/m", task: "修好那个 bug", predictedTokens: 1000, dispatchedAt: 90 }];
  const next = { type: "user/message", file: 1, time: 200, data: { id: "human-2", role: "user", content: [{ type: "text", text: "顺便把文档也更新了" }] } };
  settleFromEvents(fresh, [
    { type: "user/message", file: 1, time: 100, data: { id: "scout-fu-2", role: "user", content: [{ type: "text", text: "修好那个 bug" }] } },
    ...base.slice(1),
    next,
  ]);
  assert.equal(fresh[0].followUp.kind, "continuation");
});

test("priorsFrom tracks re-ask rate and mean actual tokens", () => {
  const priors = priorsFrom([
    { settledAt: 1, route: "p/m", actualTokens: 100_000, predictedTokens: 100_000, followUp: { kind: "continuation" } },
    { settledAt: 2, route: "p/m", actualTokens: 200_000, predictedTokens: 100_000, followUp: { kind: "reask" } },
    { settledAt: 3, route: "p/m", actualTokens: 300_000, predictedTokens: 100_000 }, // unclassified follow-up
  ]);
  assert.equal(priors.get("p/m").dispatches, 3);
  assert.equal(priors.get("p/m").meanTokens, 200_000);
  assert.equal(priors.get("p/m").reaskRate, 0.5, "one reask of two classified follow-ups");
});

test("priorRow ranks probe-free from history and says so", () => {
  const cheap = priorRow({ provider: "p", model: "cheap" }, { dispatches: 3, meanTokens: 100_000, reaskRate: 0 });
  const pricey = priorRow({ provider: "p", model: "big" }, { dispatches: 5, meanTokens: 300_000, reaskRate: 0.5 });
  assert.equal(cheap.priorMode, true);
  assert.equal(cheap.quality, 1, "no re-asks maps to full prior quality");
  assert.equal(pricey.quality, 0.5);
  const ranked = rankRows([cheap, pricey], 0.5);
  assert.equal(`${ranked[0].candidate.provider}/${ranked[0].candidate.model}`, "p/cheap");
  const text = renderReport({ task: "t", rows: ranked, lambda: 0.5 });
  assert.match(text, /prior mode · 3 settled dispatches/);
  assert.match(text, /prior mode · 5 settled dispatches · reask 50%/);
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.label}\n${failure.error?.stack ?? failure.error}`);
  }
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${passed} tests passed`);
}
