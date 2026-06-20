# Hub Leader

> **Agent Hub 的 Leader 智能体** — 目标分解 → DAG 规划 → Worker 分派 → 上下文注入 → 结果回写

## 一句话

`opencode hub-leader "Add login to siruoning"` → 自动从 agent-hub 拉取上下文，LLM 规划 DAG，分派 opencode 子 agent 执行，结果回写 hub。

## 架构

```
User Goal
  │
  ├── HubClient ──→ agent-hub (hub.stifer.xyz)
  │     ├── 拉 Worker 列表 + 状态
  │     ├── 搜 Playbook 知识库
  │     └── 拉最近事件 (避免重复工作)
  │
  ├── Planner (LLM) ──→ 目标 → DAG (任务 + 依赖 + Worker 分配 + Skill 标注)
  │
  ├── Sync ──→ DAG 回写 hub (面板可见)
  │
  └── Dispatcher ──→ 拓扑排序 → Wave-by-Wave dispatch
        │
        ├── 注入 Playbook 上下文到 Worker system prompt
        ├── opencode subprocess 执行
        └── 结果回写 hub (DAG status + Event)
```

## 快速开始

```bash
# 安装依赖
bun install

# 干跑 (不执行 Worker，只看 DAG 计划)
bun run src/index.ts \
  --goal "为思若宁小程序添加用户反馈功能" \
  --business siruoning \
  --dry-run

# 正式执行
ANTHROPIC_API_KEY=sk-xxx \
bun run src/index.ts \
  --goal "为思若宁小程序的用药模块写单元测试" \
  --business siruoning
```

## CLI Flags

| Flag | 默认值 | 说明 |
|------|--------|------|
| `--goal` | **(必需)** | 目标描述 |
| `--business` | `ai-medbox` | 业务代号 |
| `--base-url` | `https://hub.stifer.xyz` | Hub 地址 |
| `--opencode-bin` | `opencode` | opencode 二进制路径 |
| `--cwd` | `pwd` | 子 agent 工作目录 |
| `--model` | `claude-sonnet-4-20250514` | LLM 模型 |
| `--dry-run` | `false` | 仅计划不分派 |
| `--api-key` | — | Hub API Key (跳过 OAuth) |

## 包结构

```
packages/hub-leader/
  src/
    index.ts              ── CLI 入口，编排全流程
    hub/
      types.ts            ── Hub 实体 Zod Schema
      client.ts           ── agent-hub REST API 客户端
    dag/
      types.ts            ── DAG 规划类型
      planner.ts          ── LLM DAG 规划器 (结构化输出)
    dispatch/
      dispatcher.ts       ── Worker 分派引擎 (拓扑排序 + 上下文注入)
```

## 关键设计决策

| 决策 | 理由 |
|------|------|
| **HTTP 直连而非 MCP** | Leader 需要完整 REST API，MCP 工具封装太薄 |
| **AI SDK 结构化输出** | 用 `generateObject` + Zod Schema 强制 LLM 输出规范 DAG |
| **Wave-by-Wave 调度** | 简单拓扑排序，每 wave 内并发，无依赖锁问题 |
| **不入侵 opencode core** | 独立包挂在 monorepo，零风险 |
| **Dry-run 模式** | 先看计划再执行，人工审核关 |

## 依赖

- `@ai-sdk/anthropic` — LLM 调用
- `ai` — `generateObject` 结构化输出
- `zod` — Schema 校验
- `effect` — (暂未使用，预留)
