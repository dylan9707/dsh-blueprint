<p align="right">简体中文</p>

<h1 align="center">dsh-blueprint</h1>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

> Blueprint —— 在 DeepSeek Harness 右侧栏把「代码现状」画成只读 As-Is，你编辑可写的 To-Be，Update Agent 回传设计意图，agent 对照真实代码产出分阶段改动计划。

## 它是什么

一个 DSH 插件，提供可交互的双画布设计面板：

- **As-Is（左）**：agent 从当前代码生成的语义图，只读；block 位置 / 尺寸 / 颜色 / trace / 端点可调整。
- **To-Be（右）**：可编辑目标设计；支持 block、嵌套 sub-block、连线、描述与 code binding。
- **三种视图 profile**（每次 session 选一个）：`execution-flow`（纵向执行 / 信号流）、`component-architecture`（宽幅 containment 架构）、`state-workflow`（分层状态与迁移）。
- **编辑器**：block 支持 `rect` / `rounded` / `ellipse` / `diamond` / `hexagon` 五种形状（inspector 切换），可自定义颜色；8px 网格 + 拖动/缩放吸附；Fit 全图、单侧展开、端点四边拖动、trace 手动路由。
- **空白画布**：`blueprint_blank` 建一个没有 As-Is 的空 session，当 block diagram / logic flow 自由画。

点 **Update Agent** 写 pending handoff；下一轮 agent 读 handoff + diff + 现码，产出 semantic changes、任务清单与待确认问题。

## 命令

```
/blueprint <scope>
```

| scope | 生成 |
|---|---|
| 整个系统（如 `/blueprint FSM`） | 三张独立 session：architecture、execution/data flow、state/lifecycle |
| 聚焦请求（函数 / 流水线） | 只生成指定视图 |

## 工具

| 工具 | 作用 |
|---|---|
| `blueprint_new` | 从 As-Is 语义图 + viewProfile 建 session |
| `blueprint_blank` | 建一个空的 To-Be 画布（自由画 block diagram / logic flow） |
| `blueprint_status` | 读当前 session（As-Is/To-Be/layout/handoff/diff） |
| `blueprint_diff` | 语义 diff（不含 layout） |
| `blueprint_consume` | 读完后把 handoff 置为 consumed |

## 数据存储

- `<workspace>/.blueprint/sessions/<id>/`：`session.json`、`as-is.json`、`to-be.json`、`layout.json`、`handoff.json`
- `<workspace>/.blueprint/current.json`：当前 active session

layout（位置 / 尺寸 / 颜色 / trace / 端点）只属于显示态，不进入语义 diff。

## 安装

```sh
dsh plugin --profile web add <path-to-dsh-blueprint>
```

## 开发

```sh
node --check lib/index.js
node --check lib/core.js
node --check assets/app.js
```

## 边界

- 图是「你的设计输入」，不是权威事实源；agent 出计划仍以真实代码为准。
- 面板只编辑画布，不改代码。
- 数据存工作区 `.blueprint/`，跨进程不协调并发写。

## License

MIT
