/**
 * Renders the `/scout` report from fabricated probe replies, so the output can
 * be inspected without the DSH runtime or spending tokens.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 "<app>" test/demo.mjs
 */
import { buildRow, normalizePlan, rankRows } from "../lib/plan.js";
import { renderReport } from "../lib/render.js";

const task = "把 config loader 改成支持 .toml，并补测试";

const replies = {
  "deepseek-official/deepseek-flash": {
    plan: [
      "读 src/config/loader.ts，确认现有 json/yaml 分支结构",
      "在 parseConfig() 里加 toml 分支，复用 readFile + 统一错误包装",
      "补 test/loader.test.ts 的 toml 用例（合法、缺字段、语法错误）",
      "跑 pnpm test -- loader",
    ],
    files: ["src/config/loader.ts", "test/loader.test.ts"],
    est_turns: 7,
    tool_calls: { read: 4, grep: 2, edit: 2, bash: 2 },
    risk: "low",
    blockers: [],
    confidence: 0.78,
  },
  "acme/big": {
    plan: [
      "先梳理 src/config 下所有入口与调用方",
      "抽一个 ConfigParser 接口，把 json/yaml/toml 都做成实现",
      "迁移 loader.ts 到新接口并保持向后兼容",
      "补 3 组单测 + 1 组集成测试",
      "更新 docs/config.md",
      "跑全量测试并检查类型",
    ],
    files: ["src/config/loader.ts", "src/config/parser.ts", "src/config/parsers/toml.ts", "test/loader.test.ts", "docs/config.md"],
    est_turns: 16,
    tool_calls: { read: 8, grep: 5, edit: 6, bash: 3 },
    risk: "medium",
    blockers: [],
    confidence: 0.86,
  },
  "acme/tiny": {
    plan: ["改 loader 支持 toml"],
    files: [],
    est_turns: 3,
    tool_calls: { edit: 1 },
    risk: "high",
    blockers: ["不确定仓库里有没有 toml 解析依赖"],
    confidence: 0.3,
  },
};

const taskTokens = 40;
const rows = Object.entries(replies).map(([route, reply]) => {
  const slash = route.indexOf("/");
  return buildRow({
    candidate: { provider: route.slice(0, slash), model: route.slice(slash + 1) },
    plan: normalizePlan(reply),
    taskTokens,
  });
});

const ranked = rankRows(rows, 0.5);
const winner = ranked[0];

console.log(
  renderReport({
    task,
    rows: ranked,
    lambda: 0.5,
    recommendation: `recommend: ${winner.candidate.provider}/${winner.candidate.model} — quality ${winner.quality.toFixed(2)}, est. ${winner.totalTokens} tokens (${winner.turns} turns)`,
  }),
);
