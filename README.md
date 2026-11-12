# agent-model-scout

English | [简体中文](README.zh-CN.md)

`/scout <task>` — probe every configured model with one cheap planning call, rank the plans by quality vs. estimated token cost, and optionally switch this agent onto the winner.

Scout is a pre-flight check, not a router daemon: it gathers cheap intel (a plan), scores it locally, and lets you or the command make the call.

```text
scout · 3 candidates · λ=0.50
task: make the config loader support .toml and add tests

  #  MODEL                              Q     EST.TOK  U      TIME   NOTE
  1  deepseek-official/deepseek-flash   0.74  58k      0.61   3.1s   4 steps, 2 files
  2  acme/big                           0.90  220k     0.40   5.7s   6 steps, 5 files
  3  acme/tiny                          0.11  18k      0.07   1.2s   1 step, 0 files

  top plan: 1) read src/config/loader.ts  2) add a toml branch inside parseConfig() …
  files: src/config/loader.ts, test/loader.test.ts

  ▸ recommend: deepseek-official/deepseek-flash — quality 0.74, est. 58k tokens (7 turns)
  ▸ dry run — add --apply to switch this agent's model.
```

## Status

v0, manual trigger only. It answers *"which model plans this task better for the money"*, not *"which model will finish it"*. Learned priors, price tables, auto pre-flight, and mid-run escalation are deliberately out of scope (see [Roadmap](#roadmap)).

## Why probe instead of asking models to self-score

Asking a model to estimate its own token usage or grade its own answer is unreliable: tokenizers differ per provider, models cannot count tokens, and self-evaluation carries a known self-preference bias. Scout splits the job:

| Question | Who answers |
|---|---|
| What would you do? | the candidate model (a plan, as JSON) |
| How good is that plan? | a fixed local rubric |
| How many tokens will it take? | a local cost model |

The model only ever supplies a plan. Everything that becomes a number is computed here, so the scoring is inspectable, tunable, and replayable.

## Install

Requires DeepSeek Harness with a profile that has at least two configured models. The examples target the `desktop` profile — adjust if yours differs. All commands run in PowerShell.

### 1. Get the code

```powershell
git clone https://github.com/ankepoipoi/agent-model-scout.git
cd agent-model-scout
```

### 2. Copy the package into the profile

Close DeepSeek Harness first, then:

```powershell
$dest = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\agent-model-scout"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force .\package.json, .\lib $dest
```

Or run `.\install.ps1`, which does this step for you (idempotent; `-DryRun` shows the plan first).

### 3. Register the plugin

Append this entry to the **end** of `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- insert:
    - id: scout
      name: "agent-model-scout"
      config:
        candidates: []            # explicit "provider/model" routes; empty = auto-discover
        lambda: 0.5               # cost weight: 0 = quality only, 1 = cost dominates
        topK: 4                   # max candidates probed when discovering
        maxProbeTokens: 500       # output cap for one probe
        probeTimeoutMs: 60000     # wall-clock budget for one probe
        fixedOverheadTokens: 3000 # per-turn system prompt + tool schema cost
```

> `insert:` is required. A plain `- id: scout` entry patches an *existing* entry and is silently skipped when the id is not found.

### 4. Restart and verify

Restart DeepSeek Harness fully (quit from the tray, not just close the window), then run a zero-cost check:

```text
/scout any task here --dry
```

`--dry` lists the discovered candidates without probing — it spends nothing and proves the plugin is loaded. Drop `--dry` for the real run.

The plugin declares no `Config` schema: it reads a plain object from the patch entry, so it does not couple to a `schemastery` version.

## Configuration

```yaml
- id: scout
  name: "agent-model-scout"
  config:
    candidates: []            # explicit "provider/model" routes; empty = auto-discover
    lambda: 0.5               # cost weight: 0 ranks by quality only, 1 lets cost dominate
    topK: 4                   # max candidates probed when discovering
    maxProbeTokens: 500       # output cap for one probe
    probeTimeoutMs: 60000     # wall-clock budget for one probe
    probeTemperature: 0       # pin sampling so two runs are comparable
    fixedOverheadTokens: 3000 # per-turn system prompt + tool schema cost of the real task
```

Candidate resolution order: `--models` flag → `candidates` config → auto-discovery (`ctx.llm.listProviders()` + `listModels()`) → the agent's current model.

## Usage

Every successful probe ends in a picker card, and a picked model runs the task immediately — the loop is closed: probe → pick → execute.

```text
/scout
/scout make the config loader support .toml and add tests
/scout refactor the session storage layer --apply
/scout ... --models deepseek-official/deepseek-flash,acme/big --top 2
```

| Flag | Effect |
|---|---|
| *(no task)* | ask for the task, probe, pick, run |
| *(task)* | probe it, pick, run |
| `--apply` | switch onto the winner and run the task without asking |
| `--dry` | list the candidates that would be probed, spending nothing |
| `--models a/b,c/d` | probe exactly these routes |
| `--top N` | cap how many discovered candidates are probed |
| `--lambda X` | cost weight for this run (0 = quality only, 1 = cost dominates) |

Picking the keep-current option runs the task without switching; dismissing the card runs nothing. The hand-off is `agent.followup()` with a frozen user message, so the task enters the session log as an ordinary turn and the recorded model selection takes effect on that turn's first step.

The picker is rendered through `ctx.userQuestions.ask()`, the same service behind the `ask_user_question` tool, so it appears as a normal question card. On a surface without a question UI (headless), the wizard refuses and the flag-driven forms still work.

`--apply` calls the native `agent.model.select()`, which is durable in the session projection and takes effect on the next step. The decision record is the command's own log entry plus the report text in `command/done`, so a replayed session still shows why the model changed.

## How the score is computed

### Quality rubric (0–1)

| Term | Weight | Notes |
|---|---|---|
| structure | 0.30 | step count, saturating at 6 |
| scope | 0.15 | files named, saturating at 2 |
| concreteness | 0.25 | share of steps naming a path, symbol, or code span |
| coverage | 0.20 | plan both edits and verifies (edit + test/bash/grep/read) |
| risk | 0.05 | low full, medium half, high zero |
| confidence | 0.05 | self-reported, deliberately the smallest term |
| blockers | −0.10 | −0.05 each, capped at −0.10 |
| grounding | +0.10 / −0.20 | every planned file exists on disk (+0.10); any missing (−0.20); no files listed (0) |

Grounding outweighs every shape term on purpose: a plan that names files which do not exist is guessing. The check runs `fs.existsSync` against the session cwd, so absolute paths and cwd-relative paths both count.

`scope` saturates at two files because most tasks legitimately touch one or two; an earlier version rewarded naming many files and pushed models toward inventing extra targets.

### Token estimate

The loop re-sends the whole context every turn, so input cost grows quadratically with turn count:

```text
total ≈ (fixed + task)·turns + 1200·turns(turns+1)/2 + 500·turns
```

`turns` is the plan's `est_turns`, floored by step count (`ceil(steps/3)`) — a six-step plan cannot execute in one turn, and self-reported turn counts are the least reliable field a probe returns.

Coefficients live at the top of `lib/estimate.js`. Text density uses a provider-neutral heuristic (CJK ≈ 0.6 tokens/char, ASCII ≈ 0.3 tokens/char) because a shared tokenizer would be wrong for every provider except one.

### Ranking

```text
utility = quality − λ · (candidate tokens / max tokens among candidates)
```

## Known limitations

1. **The rubric is a proxy**, not a success rate. v0 exists to test whether plans differ enough to predict execution.
2. **Ranking is unstable run to run.** On repeated runs of the same task, the winner has changed every time: the rubric scores plan *shape*, and shape varies at least as much within one model as between models. Treat `/scout` as a way to compare how models reason, not as an automatic router.
3. **Unverified rows say so.** When the session cwd cannot be resolved, planned files are not checked; the NOTE cell reads `· unverified` and grounding stays neutral rather than awarding the bonus.
4. **Probing costs money**: one call per candidate. `topK=4` is roughly 4 × (input + 500 tokens).
5. **Tokenizers differ**: the estimate is a shared density heuristic, not a provider-exact count.
6. **No capability filter yet**: a model whose context window cannot hold the session is still probed.
7. **Switching costs cache**: crossing providers drops the prompt cache; v0 does not price that.
8. **Probe requests are not in the session log**: only the decision is durable.

## Roadmap

- **v0.1** — context-window/capability filtering, price table (USD), probe cache by task fingerprint.
- **v0.2** — auto pre-flight via `agent/pre-step`, budget guard, fallback chain.
- **v0.3** — outcome log (actual usage, test result, user re-ask) → per-model priors, skip probes when confident.
- **v1** — mid-run escalation on repeated tool errors / failing tests / loops; Web UI routing card.

## Development

Pure logic (estimation, plan parsing, scoring, ranking, rendering) has no DSH dependency and runs standalone:

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\deepsh\DeepSeek Harness.exe" test\run.mjs    # 19 assertions
& "D:\deepsh\DeepSeek Harness.exe" test\demo.mjs   # renders a report from fixtures
```

`lib/index.js` consumes only the host context (`ctx.commands`, `ctx.llm`) and carries **no imports from `@deepseek-ai/*`** — third-party plugins are resolved from the profile's own package scope, where the host packages are not visible. Requests are hand-built plain objects and the probe reads raw `text-delta` chunks instead of a host assembler.

## Publishing

Run `.\publish.ps1 -Owner <your-github-name>` from a normal PowerShell window (not inside a sandboxed agent, which has no network egress). With `gh` authenticated it creates the repo and pushes; without `gh` it commits locally and prints the two commands to finish in the browser.

## License

MIT