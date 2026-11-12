/**
 * Pure-logic tests for the route plugin. These cover everything that does not
 * need the DSH runtime: estimation, plan parsing, scoring, ranking, rendering.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 "<app>" test/run.mjs   (see README)
 */
import assert from "node:assert/strict";
import { estimateTaskTokens, estimateTextTokens, formatTokens } from "../lib/estimate.js";
import { buildRow, normalizePlan, parsePlan, qualityOf, rankRows } from "../lib/plan.js";
import { renderReport, truncate } from "../lib/render.js";

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
  assert.equal(many.turns, 2, "six steps cannot run in one turn");
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

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL ${failure.label}\n${failure.error?.stack ?? failure.error}`);
  }
  console.error(`\n${passed} passed, ${failures.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`all ${passed} tests passed`);
}
