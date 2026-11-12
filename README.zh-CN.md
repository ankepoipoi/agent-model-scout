# agent-model-scout

[English](README.md) | 简体中文

`/scout <任务>` — 用一次廉价的规划调用探测所有已配置的模型，按计划质量与预估 token 成本排名，并可选将当前 agent 切换到胜出模型。

Scout 是预检（pre-flight check），不是路由守护进程：它收集廉价的情报（一份计划）、在本地打分，然后把决定权交给你或命令本身。

## 功能特性

- **多模型探测**：一次规划调用，让所有已配置模型对同一任务各出一版计划
- **质量 × 成本评分**：效用 = 质量 − λ·归一化成本，λ 可调
- **交互式选择卡**：看完排名再选模型，或保持当前模型
- **推理强度切换**：模型暴露强度档位时，第二张卡选执行强度
- **复测机制**：前两名差距小于阈值时自动重测取均值，标注 volatile/stable
- **校准的 token 估计**：用真实计费数据校准的估算公式
- **自检工具**：内置稳定性与校准度验证（`test/selfcheck.mjs`）
- **Cordis 插件**：与 DeepSeek Harness 无缝集成

```text
scout · 3 candidates · λ=0.50
task: 把 config loader 改成支持 .toml，并补测试

  #  MODEL                              Q     EST.TOK  U      TIME   NOTE
  1  deepseek-official/deepseek-flash   0.74  58k      0.61   3.1s   4 steps, 2 files
  2  acme/big                           0.90  220k     0.40   5.7s   6 steps, 5 files
  3  acme/tiny                          0.11  18k      0.07   1.2s   1 step, 0 files

  top plan: 1) 读 src/config/loader.ts  2) 在 parseConfig() 里加 toml 分支 …
  files: src/config/loader.ts, test/loader.test.ts

  ▸ recommend: deepseek-official/deepseek-flash — quality 0.74, est. 58k tokens (7 turns)
  ▸ dry run — add --apply to switch this agent's model.
```

## 状态

v0，仅手动触发。它回答的是*"哪个模型能用更少的钱把这个任务规划得更好"*，而不是*"哪个模型能最终做完"*。学习先验、价格表、自动预检、运行中升级都刻意排除在范围外（见[路线图](#路线图)）。

## 为什么用探测，而不是让模型自评

让模型估算自己的 token 用量、或给自己的答案打分，都不可靠：各家 provider 的 tokenizer 不同、模型数不清 token、自评还带着已知的自我偏好偏差。Scout 把这件事拆开：

| 问题 | 谁来回答 |
|---|---|
| 你会怎么做？ | 候选模型（一份 JSON 计划） |
| 这份计划有多好？ | 固定的本地评分标准 |
| 大约要花多少 token？ | 本地成本模型 |

模型只负责给出计划。所有变成数字的部分都在本地计算，因此评分可检查、可调参、可重放。

## 安装

要求 DeepSeek Harness 的 profile 里配置了至少两个模型。示例以 `desktop` profile 为准，不同的话自行调整。以下命令都在 PowerShell 中运行。

### 1. 获取代码

```powershell
git clone https://github.com/ankepoipoi/agent-model-scout.git
cd agent-model-scout
```

### 2. 把包复制进 profile

先完全关闭 DeepSeek Harness，然后：

```powershell
$dest = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\agent-model-scout"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse -Force .\package.json, .\lib $dest
```

或直接运行 `.\install.ps1`，它会替你完成这一步（幂等；`-DryRun` 先展示将做的操作）。

### 3. 注册插件

把下面这个条目追加到 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 的**末尾**：

```yaml
- insert:
    - id: scout
      name: "agent-model-scout"
      config:
        candidates: []            # 显式 "provider/model" 路由；为空 = 自动发现
        lambda: 0.5               # 成本权重：0 只按质量排名，1 让成本主导
        topK: 4                   # 自动发现时最多探测的候选数
        maxProbeTokens: 500       # 单次探针的输出上限
        probeTimeoutMs: 60000     # 单次探针的墙钟预算
        reprobeGap: 0.15          # 前两名分差小于该值时自动复测；0 关闭
        fixedOverheadTokens: 30000 # 真实任务每轮的系统提示 + 工具 schema 开销
```

> `insert:` 不能省。直接写 `- id: scout` 是在给*已存在*的条目打补丁，id 找不到时会被静默跳过——插件根本不会加载。

### 4. 重启并验证

完全重启 DeepSeek Harness（从托盘退出，不是只关窗口），然后跑一个零成本检查：

```text
/scout 随便一个任务 --dry
```

`--dry` 只列出发现的候选、不发起任何探测——不花一分钱，还能证明插件已加载。去掉 `--dry` 就是真实运行。

插件不声明 `Config` schema：它从 patch 条目读取普通对象，因此不与 `schemastery` 的版本耦合。

## 配置

```yaml
- id: scout
  name: "agent-model-scout"
  config:
    candidates: []            # 显式 "provider/model" 路由；为空 = 自动发现
    lambda: 0.5               # 成本权重：0 只按质量排名，1 让成本主导
    topK: 4                   # 自动发现时最多探测的候选数
    maxProbeTokens: 500       # 单次探针的输出上限
    probeTimeoutMs: 60000     # 单次探针的墙钟预算
    probeTemperature: 0       # 固定采样参数，让两次运行可比较
    reprobeGap: 0.15          # 前两名分差小于该值时自动复测；0 关闭
    fixedOverheadTokens: 30000 # 真实任务每轮的系统提示 + 工具 schema 开销
```

候选解析顺序：`--models` 标志 → `candidates` 配置 → 自动发现（`ctx.llm.listProviders()` + `listModels()`）→ agent 当前模型。

## 用法

每次成功的探测都以一张选择卡收尾，选中的模型立即开始执行任务——闭环：探测 → 选择 → 执行。

```text
/scout
/scout 把 config loader 改成支持 .toml，并补测试
/scout 重构 session 存储层 --apply
/scout ... --models deepseek-official/deepseek-flash,acme/big --top 2
```

| 标志 | 效果 |
|---|---|
| *（无任务）* | 先询问任务，然后探测、选择、执行 |
| *（有任务）* | 直接探测，然后选择、执行 |
| `--apply` | 切到胜出模型并直接执行任务，不再询问 |
| `--dry` | 只列出将被探测的候选，不花一分钱 |
| `--models a/b,c/d` | 只探测这些路由 |
| `--top N` | 限制自动发现时探测的候选数量 |
| `--lambda X` | 本次运行的成本权重（0 = 只看质量，1 = 成本主导） |

选"保持当前模型"则不切换、直接用当前模型执行；关掉卡片则什么都不执行。任务通过 `agent.followup()` 以一条冻结的 user message 交接，作为普通一轮进入 session log，已记录的模型选择在该轮第一步生效。

选中的模型若暴露推理强度（reasoning efforts），会紧跟第二张卡：执行时想多深（该模型自己的强度档位，外加`默认`）。建议值跟随计划走——高风险或多步骤的任务给最深档，简单任务给最省档；`--apply` 不问直接采用建议值。强度按模型经 `ctx.llm.resolveModelInfo()` 动态发现；没有强度目录的模型静默跳过这张卡，"保持当前模型"路径则完全不碰强度。

选择卡通过 `ctx.userQuestions.ask()` 渲染——与 `ask_user_question` 工具同源的服务，因此呈现为普通问题卡。在没有问题 UI 的环境（无头部署），向导会拒绝执行，标志驱动的形式仍然可用。

`--apply` 调用原生 `agent.model.select()`，它在 session 投影中持久化，下一步生效。决策记录就是命令自身的日志条目加上 `command/done` 里的报告文本，因此重放的 session 仍能看出模型为何切换。

## 分数是怎么算的

### 质量评分标准（0–1）

| 项 | 权重 | 说明 |
|---|---|---|
| structure 结构 | 0.30 | 步骤数，6 步封顶 |
| scope 范围 | 0.15 | 点到的文件数，2 个封顶 |
| concreteness 具体度 | 0.25 | 提到路径、符号或代码片段的步骤占比 |
| coverage 覆盖 | 0.20 | 计划既改代码又做验证（edit + test/bash/grep/read） |
| risk 风险 | 0.05 | 低得满、中得半、高为零 |
| confidence 自信度 | 0.05 | 模型自报，刻意设为最小项 |
| blockers 阻碍 | −0.10 | 每个 −0.05，封顶 −0.10 |
| grounding 落地校验 | +0.10 / −0.20 | 计划中所有文件都在磁盘上存在（+0.10）；任一缺失（−0.20）；没列文件（0） |

落地校验的权重刻意压过所有形态项：点名了不存在文件的计划是在瞎猜。校验对 session 工作目录跑 `fs.existsSync`，绝对路径和相对路径都算数。

`scope` 在两个文件处封顶，因为多数任务合理地只动一两个文件；早期版本奖励多列文件，反而诱导模型编造额外目标。

### Token 估算

循环每轮都重发全部上下文，因此输入成本随轮数平方增长：

```text
total ≈ (fixed + task)·turns + 1200·turns(turns+1)/2 + 500·turns
```

`turns` 取计划自报的 `est_turns`，并用步数托底（`turns >= steps`）：对已派发任务的校准显示，计划里的每一步往往就是一次调用（5 步 → 5 次调用）。每轮固定开销（30,000）同样来自校准：前两个派发任务的实际计费是每次调用 36k–47k token——最初 3,000 的假设系统性低估了 7–9 倍。日志里有派发任务时，`test/selfcheck.mjs` 第 4 节会自动重算这个校准比（`actual/predicted`）。

系数都在 `lib/estimate.js` 顶部。文本密度用 provider 中立的启发式（CJK ≈ 0.6 token/字符，ASCII ≈ 0.3 token/字符），因为共用一个 tokenizer 对除一家之外的所有 provider 都是错的。

### 排名

```text
utility = quality − λ · (候选 tokens / 候选中的最大 tokens)
```

## 已知局限

1. **评分标准只是代理指标**，不是成功率。v0 的目的就是检验计划差异是否足以预测执行。
2. **排名在运行之间不稳定。** 同一任务反复跑，每次胜者都换过：标准打的是计划的*形态*，而形态在同一模型内的波动不小于模型之间。9 连测自检验（`test/selfcheck.mjs`）实测：同模型 Q 漂移均值 **0.45**，同轮模型间分差均值 **0.26**——在这个噪声水平下排名不携带信号。同一检验还发现 deepseek 系在 temperature 0 下完全钉死（跨轮 ±0.02），而 glm-5.3 漂了 0.54——即使请求里带了 `temperature: 0`，各家的确定性也不一样。把 `/scout` 当作比较模型思路的工具，而不是自动路由器。
3. **未校验的行会标出来。** session 工作目录解析不到时不检查计划文件；NOTE 栏显示 `· unverified`，落地项保持中性而非白给加分。
4. **探测要花钱**：每个候选一次调用。`topK=4` 大约是 4 ×（输入 + 500 token）。
5. **tokenizer 各家不同**：估算是通用密度启发式，不是 provider 精确计数。
6. **还没有能力过滤**：上下文窗口装不下 session 的模型照样被探测。
7. **切换有缓存代价**：跨 provider 会丢提示缓存；v0 没有为此计价。
8. **探针请求不进 session log**：只有决策被持久化。

## 路线图

- **v0.1** — 上下文窗口/能力过滤、价格表（USD）、按任务指纹缓存探针。
- **v0.2** — 通过 `agent/pre-step` 自动预检、预算护栏、回退链。
- **v0.3** — 结果日志（实际用量、测试结果、用户重问）→ 各模型先验，有把握时跳过探测。
- **v1** — 运行中升级（连续工具报错/测试失败/循环时换模型）；Web UI 路由卡。

## 开发

纯逻辑（估算、计划解析、打分、排名、渲染）不依赖 DSH，可独立运行：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
& "D:\deepsh\DeepSeek Harness.exe" test\run.mjs        # 19 条断言
& "D:\deepsh\DeepSeek Harness.exe" test\demo.mjs       # 用 fixtures 渲染一份报告
& "D:\deepsh\DeepSeek Harness.exe" test\selfcheck.mjs  # 挖 session 日志：分数稳定性、探针失败率、闭环派发
```

`lib/index.js` 只消费宿主上下文（`ctx.commands`、`ctx.llm`），**不携带任何 `@deepseek-ai/*` 导入**——第三方插件从 profile 自己的包作用域解析，那里看不见宿主包。请求是手工构造的普通对象，探针直接读原始 `text-delta` 分块而非宿主装配器。

## 发布

在普通 PowerShell 窗口（不要在没有网络出口的沙箱 agent 里）运行 `.\publish.ps1 -Owner <你的-github-用户名>`。有 `gh` 认证时它会建仓库并推送；没有 `gh` 时本地提交并打印两条在浏览器里完成的命令。

## 许可证

MIT
