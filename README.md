<p align="right">简体中文</p>

<h1 align="center">dsh-blueprint</h1>

<p align="center">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-plugin-202724" alt="DeepSeek Harness plugin">
</p>

> Blueprint —— 把系统架构 / 工作流画成**可交互的图**，你改完，agent 按你的设计出改动方案。

一个 DeepSeek Harness 插件，提供两块画布：

- **全景（panorama）**：白板手绘风全景图——彩色分区容器（胶囊标题）+ 白色卡片（含 `code chip`）+ 中心节点 + 曲线中文箭头。画 FSM 架构、SSOT 流水线、任意 workflow 都行。
- **信号流（signalFlow）**：信号处理环节 + 流动的信号（safety：`check → addError → errLevelOf → 动作 → 主循环 → MCU`）。

面板可交互：拖块、连线（贴边曲线）、改名、删除、缩放平移。改完点 **`Update Agent`**，agent 读你的设计 → 对照真实代码 → 出「改动确认 + 详细设计」方案，走两道 Gate 等你点头。

## 命令

在对话里直接说（自然语言）：

```
sys-view <scope>
```

| scope | diagramType | 内容 |
| --- | --- | --- |
| `fsm` / `system` / `architecture` | `panorama` | 整个系统白板全景：中心节点 + 分区卡片 + 曲线箭头 |
| `safety` / `signal flow` / `signalflow` | `signalFlow` | 安全信号流 |
| `panorama` / `whiteboard` / `workflow` | `panorama` | 任意 workflow 全景（从 spec / 你的设计生成） |

## 为什么用 System View

| 能力 | 解决什么 |
| --- | --- |
| **可视化架构 / 工作流** | 系统结构一眼看全，不用在代码里翻 |
| **交互式编辑** | 你直接改图，表达「我要的设计」 |
| **设计 → 方案闭环** | 改完点 Update Agent，agent 把你的图当目标设计 diff 真实代码出方案 |
| **防跑题 / 对齐** | 图和代码双向对齐，动手改代码前先对齐设计 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `system_overview_save` | 把图落盘（`diagramType` = `signalFlow` / `panorama`） |
| `system_overview_load` | 读当前图（agent 检查 / 对你改的图做 diff） |

## 交互闭环

1. 你在面板里编辑图（全景 / 信号流）。
2. 点 `Update Agent` → 写 `ai_notes/agent_briefs/system-view-update-pending.json`（编辑后的图 + 时间戳）。
3. 下一轮 agent 读标记 + `system_overview_load`，把你的编辑当**目标设计**，对照真实代码出 `改动确认 + 详细设计`。
4. 走仓库两道 Gate，等你点头才动代码。

## 数据存储

- 图：`ai_notes/diagrams/system_graph.json`（`{ version, signalFlow, panorama }`）
- Update Agent 标记：`ai_notes/agent_briefs/system-view-update-pending.json`

## 安装

```sh
dsh plugin --profile web add <path-to-dsh-blueprint>
```

## 配置

```yaml
- id: blueprint
  config:
    graphPath: ai_notes/diagrams/system_graph.json
```

## 边界

- 图是「你的设计输入」，不是权威事实源——agent 出方案仍以真实代码为准（grep + read `.h`/`.cpp`）。
- 面板只编辑画布，不改代码；代码改动永远走两道 Gate。
- 数据存工作区文件，跨 DSH 进程不协调并发写。

## 开发

改完验证 host 面：

```sh
node --input-type=module -e "import('./lib/index.js').then(m => console.log('OK: ' + Object.keys(m).join(', ')))"
```

| 文件 | 作用 | 改完生效 |
| --- | --- | --- |
| `lib/index.js` | host：工具 + system prompt + 路由 | 重启 `dsh web` |
| `assets/editor.html` | 编辑器 UI（全景 / 信号流画布） | 刷新面板即见 |
| `lib/client.js` | 悬浮窗外壳 + iframe | 一般不动 |

## License

MIT
