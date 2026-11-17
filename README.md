# Codex threads

驱动本机已安装的 Codex CLI，围绕**已有 Codex 会话**继续协作：读取会话历史、判断它此刻在不在跑、向同一个会话下发新指令、跟进结果。会话不会被 fork。

宿主插件（Host-only bundle），只注册模型工具，没有界面、没有独立登录、不搬运 Codex 数据。

## 工具

| 工具 | 作用 |
|---|---|
| `codex_thread_new` | **开一个全新的 Codex 会话**并下达第一条指令，返回新会话 id；`cwd` 决定工作目录，`model` 指定模型 |
| `codex_thread_list` | 列出最近的 Codex 会话（名字、时间、是否正被 Codex 应用占用） |
| `codex_thread_read` | 读一个会话：工作目录、模型、当前轮次状态、最近消息、工具活动，并返回 `nextOffset` |
| `codex_thread_send` | 向会话下发指令并继续它；返回交付方式 `turn` 或 `queued` 与 `fromOffset`；`model` 等仅 `turn` 路径生效 |
| `codex_thread_review` | 把合并后的结果交回 Codex 做**独立审查**，立即返回，DSH 继续干活 |
| `codex_thread_wait` | 短窗收集进度：默认 12s、上限 120s，`until` 三档，超时会给下一步 |
| `codex_thread_cancel` | 取消**本进程**发起的那一轮；Codex 应用自己跑的轮次需在 Codex 里中断 |

新会话建好后就是普通会话：`codex_thread_read` / `send` / `wait` / `cancel` 都认这个 id，所以「开新会话 → 派活 → 跟进 → 继续追问」是同一条闭环。

新会话的工作目录按三级解析，返回结果里的 `from:` 会写明用了哪一级：

| 顺序 | 来源 | 说明 |
|---|---|---|
| 1 | `cwd` 参数 | 显式指定，最强 |
| 2 | 调用方 DSH 会话的当前工作目录 | 即该会话此刻的 cwd（可能已被 `/cd` 或 worktree 改过），不是某个固定「工作区」 |
| 3 | DSH 宿主进程目录 | 兜底，出现时结果里会明确标成 `from: the DSH host process directory` |

选定的目录会同时作为 `codex exec -C <dir>` 参数和子进程 cwd，并写进 Codex 的 `session_meta.cwd`——与在 Codex Desktop 里「选一个目录新建会话」等价。新会话属于 Codex 自己的会话库，**不会**出现在 DSH 的会话列表里。

`thread` 参数接受三种写法，会自动归一：

```text
01a1df1e-d23a-74d2-8d98-7e01ec301e2a
codex://threads/01a1df1e-d23a-74d2-8d98-7e01ec301e2a
C:\Users\<you>\.codex\sessions\2026\11\15\rollout-2026-11-15T20-11-41-01a1df1e-d23a-74d2-8d98-7e01ec301e2a.jsonl
```

## 三条写入路径

Codex 的会话存储是单写者：同一个会话同一时刻只能有一个进程持有写锁。所以往 Codex 里推指令有三条路。

| 目标 | 命令 |
|---|---|
| **新建会话** | `codex exec - --json --skip-git-repo-check`（指令走 stdin，会话落盘后可继续用） |
| 已有会话、空闲 | `codex exec resume <id> - --json --skip-git-repo-check --all` |
| 已有会话、Codex 应用正开着 | `codex queue --thread <id> --message <text>` |

`codex_thread_send` 的 `mode` 默认 `auto`：先起一轮，若 Codex 报 `already has an active writer`（约 1 秒内出现），自动改投队列并如实说明。`mode: "turn"` / `"queue"` 可强制其中一条。

三条路都会把内容追加进**同一个 rollout 文件**（新会话则是新建一个），所以读取侧只有一套解析器。

## 模型与思考强度

Codex 选模型不止 `-m` 一个口子，工具把四层都暴露出来：

| 参数 | 传什么 | 实际命令 |
|---|---|---|
| `model` | 模型 id | `-m <model>` |
| `effort` | 思考强度 | `-c model_reasoning_effort=<level>` |
| `profile` | profile 名 | `-p <profile>`（叠 `$CODEX_HOME/<name>.config.toml`） |
| `config` | 任意配置键值 | 逐条 `-c key=value` |

思考强度**没有专门的 CLI 开关**（`codex exec` 的 `--help` 里 grep 不到 `effort`），它本来就是配置项 `model_reasoning_effort`。所以 `effort` 参数最终拼成 `-c`，并且排在你自己的 `config` 之后——同名键以 `effort` 为准。

合法取值来自本机 `config.toml` 的 `enabled-reasoning-efforts`：

```
low → medium → high → xhigh → max → ultra
```

不是每个模型都给到 `ultra`：`gpt-reserve`、`gpt-6-luna`、`gpt-5.6-luna`、`codex-auto-review` 只到 `max`，其余到 `ultra`。默认值也各不相同（`gpt-6.1-sol` 是 `low`，`gpt-6-astra` 是 `medium`）。

注意 CLI **不校验**这个值：写个 `bogus` 也能启动到读 prompt 那一步。所以传错不会立刻报错，**要以下面这条为准**。

| 路径 | 能否生效 |
|---|---|
| 新建会话 | ✅ 四个都能用 |
| 已有会话・turn 路径 | ✅ 四个都能用 |
| 已有会话・queue 路径 | ❌ Codex 规定「Queued messages use the thread's model」，结果里会写明 `NOT applied` |

**一个坑（已修）**：`-p` 在 `codex exec resume` 上不被接受，必须放在 `resume` 子命令**之前**。所以 turn 路径拼出来是 `codex exec -p … -m … -c … resume <id> - …`。这条是拿真 CLI 打出来的，不是看文档猜的。

**另一个坑**：不传任何模型参数时，`resume` **不会**沿用会话当初记录的模型——实测把一条记为 `gpt-6-astra` 的会话续接，实际跑的是 `gpt-6.1-sol`，Codex 还为此打了 warning。想保住某个模型就得显式传。

`~/.codex/models_cache.json` 里的 id（0.169.0 上是 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6.1-terra`、`gpt-6-sol`、`gpt-reserve`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`、`codex-auto-review`）只是 CLI 自带目录的候选，**不是上限**：`config` 参数能把任意 provider / model / effort 塞进去，自定义 provider 也走这条路。

每次真实调用用了哪个模型，以 `codex_thread_read` 输出里的 `model:` 行为准——那行来自 rollout 的 `turn_context`，是 Codex 自己记的。

## 编排：让 Codex 干活，同时 DSH 不干等

`codex_thread_send` 在 Codex 还在跑时就返回。正确用法是把它当"交给同事"，而不是"必须守着等它办完"。

| 阶段 | 谁做 | 做什么 |
|---|---|---|
| 1 拆分 | DSH | 定哪部分交给 Codex（需要它的上下文/模型/工具），哪部分自己干 |
| 2 并行 | DSH | 读代码、跑构建/测试拿基线、写 fixture 与测试骨架、拆剩余子任务、准备 Codex 需要的上下文 |
| 3 收编 | DSH | 需要结果时才 `codex_thread_wait`，短窗、不轮询；合并两份产出并跑验证 |
| 4 回审 | Codex | `codex_thread_review` 交回独立审查，DSH 在它审的时候继续补测试/写文档 |
| 5 落地 | DSH | 按审查结论修，再交付 |

**唯一该等的情况**：手上确实没有可并行的工作。这时也要用短窗 + `until:"turn-complete"`，而不是一次 300 秒。

一个真实反例（本插件优化前的实测）：某个 78 小时的会话里 `codex_thread_wait` 占掉全部工具时间的 **96.9%**，192 次调用有 159 次显式传了 `timeoutMs: 300000`，中位数 300.3 秒；其中一次下发后连续 29 次 wait、耗掉 2.3 小时。根因不在工具，而在"发完就去等"的默认习惯——现在返回值里会明确写"先去干自己的活"。

## 读取侧

- 索引：`$CODEX_HOME/session_index.jsonl`（默认 `~/.codex`），取 id、标题、更新时间。
- 正文：按**字节区间**读 rollout `jsonl`，默认只读末尾 256 KiB；`wait` 只从 `fromOffset` 往后读，最多 2 MiB。不整文件重扫，也不会和正在写的 Codex 抢锁。
- 解析：`session_meta`（cwd、CLI 版本、来源）、`turn_context`（cwd、模型、effort）、`response_item/message`（user/assistant，跳过注入的上下文块）、`function_call`/`custom_tool_call`、`event_msg` 的 `task_started`/`task_complete`（判断当前是否在跑）。

## 安装

在 DSH 里 **Plugins → Add plugin**，选择本目录；或在有 `plugin_manager` 的会话里安装这个绝对路径的 bundle，然后确认 Plugins 页出现 **Codex threads** 一行。

需要本机有 Codex CLI。定位顺序：`CODEX_BIN` → PATH 上的 `codex.exe` → npm 全局 shim 旁的原生 payload → `node <bin>/codex.js`。全部用精确 argv 启动，不经 shell，指令文本不会被二次转义。

## 已知限制

- 只能读到本机 `$CODEX_HOME` 里的会话；Codex Cloud 任务不在范围内。
- 不能中断 Codex 应用自己发起的轮次（没有对外接口）。
- `codex queue` 投递后由 Codex 应用决定何时执行；对方没在运行时消息会一直排队。
- 用不同版本的 CLI 续接旧会话时，Codex 会给出模型/指令迁移提示，插件把它当作诊断原文回显。
- 会话的模型与权限沿用 Codex 自己的设置；本插件不覆盖。

## 自检

`test/harness.mjs` 在真实会话库上跑一遍：注册形状、列表、按链接读、按路径读、各类拒绝、空轮次等待。

```bash
node test/harness.mjs
```
