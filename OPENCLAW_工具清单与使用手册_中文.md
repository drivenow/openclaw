# OpenClaw 工具清单与使用手册（中文）

## 1. 这份手册解决什么问题

你关心两件事：

1. OpenClaw 现在到底支持哪些工具。
2. 这些工具是怎么“接入并生效”的。

这份手册基于当前仓库代码（`2026.2.17`）梳理，不是泛化说明。

---

## 2. 工具体系总览

OpenClaw 的工具能力分为 4 层：

1. 基础编码工具（文件/执行类，来自 coding tools 装配链）。
2. OpenClaw 内置业务工具（cron/message/sessions/gateway 等）。
3. 渠道注入工具（由 channel dock 动态注入，例如登录/配对类）。
4. 插件工具（插件 `registerTool` 注册，支持 optional/allowlist）。

最终是否能被模型调用，不是“注册了就一定可用”，而是要经过工具策略管线过滤。

---

## 3. 详细工具清单

## 3.1 基础编码工具（Coding 基座）

在系统提示和工具顺序中可见这些核心名称（用于模型侧工具描述/排序）：

- `read`
- `write`
- `edit`
- `apply_patch`
- `grep`
- `find`
- `ls`
- `exec`
- `process`
- `web_search`
- `web_fetch`
- `image`

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/system-prompt.ts`
- `/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.ts`

说明：

- `exec/process` 是 OpenClaw 自己接管的执行会话体系。
- `apply_patch` 受模型与配置双重门控（默认并非总可用）。

---

## 3.2 OpenClaw 内置业务工具（平台能力）

由 `createOpenClawTools` 装配的工具：

- `browser`
- `canvas`
- `nodes`
- `cron`
- `message`
- `tts`
- `gateway`
- `agents_list`
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`
- `subagents`
- `session_status`
- `web_search`
- `web_fetch`
- `image`（满足条件时）

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/openclaw-tools.ts`

---

## 3.3 渠道注入工具（Channel Dock）

渠道插件可额外注入 agent tools（例如某些登录/配对辅助工具）：

- 注入入口：`listChannelAgentTools(...)`
- 装配位置：`createOpenClawCodingTools(...)` 中合并

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/channel-tools.ts`
- `/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.ts`

---

## 3.4 插件工具（Plugin Agent Tools）

插件通过 `api.registerTool(...)` 接入：

- 支持 required/optional 两类工具。
- optional 工具必须进入 allowlist 才会启用。
- 插件工具名和 core 工具名冲突会被跳过。

代码/文档位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/plugins/tools.ts`
- `/Users/fullmetal/Documents/codes/openclaw/docs/plugins/agent-tools.md`

---

## 3.5 策略层可识别的工具组（Group Shorthand）

工具策略支持以下 `group:*`：

- `group:memory` -> `memory_search`, `memory_get`
- `group:web` -> `web_search`, `web_fetch`
- `group:fs` -> `read`, `write`, `edit`, `apply_patch`
- `group:runtime` -> `exec`, `process`
- `group:sessions` -> `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `subagents`, `session_status`
- `group:ui` -> `browser`, `canvas`
- `group:automation` -> `cron`, `gateway`
- `group:messaging` -> `message`
- `group:nodes` -> `nodes`
- `group:openclaw` -> OpenClaw 内建工具全集（不含插件）

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/tool-policy.ts`

---

## 4. “工具怎么支持”的实现原理

## 4.1 装配阶段

`createOpenClawCodingTools(...)` 会组装：

1. 基础 coding tools（并替换/增强 read/write/edit 等）。
2. `exec/process/apply_patch`。
3. 渠道工具（channel dock）。
4. OpenClaw 内置工具（cron/message/sessions/gateway...）。
5. 插件工具（`resolvePluginTools`）。

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.ts`

## 4.2 过滤阶段（真正决定“可用集合”）

工具会按顺序进入策略管线：

1. `tools.profile`
2. `tools.byProvider.profile`
3. 全局 `tools.allow/deny`
4. 全局 `tools.byProvider.allow/deny`
5. agent 级 `agents.<id>.tools.allow/deny`
6. agent 级 `agents.<id>.tools.byProvider.allow/deny`
7. group policy
8. sandbox policy
9. subagent policy

代码位置：

- `/Users/fullmetal/Documents/codes/openclaw/src/agents/tool-policy-pipeline.ts`
- `/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.policy.ts`

---

## 5. 你当前机器的实际生效状态（重点）

你当前配置文件：

- `/Users/fullmetal/.openclaw/openclaw.json`

当前值是：

- `"tools": { "profile": "minimal" }`

按策略定义，`minimal` 只放开：

- `session_status`

这意味着：

1. 平台支持很多工具，但默认不会全给模型。
2. 你要用自动化编排（比如 cron + sessions + 文件读写），建议切到 `coding` 或 `full`，并按需再收紧。

---

## 6. 常用配置模板（可直接改）

## 6.1 只保留最小工具（当前状态）

```json5
{
  tools: {
    profile: "minimal",
  },
}
```

## 6.2 开发/自动化常用（推荐起点）

```json5
{
  tools: {
    profile: "coding",
    allow: ["group:automation", "group:web", "message"],
  },
}
```

## 6.3 全开再按风险收敛

```json5
{
  tools: {
    profile: "full",
    deny: ["group:runtime"],
  },
}
```

## 6.4 provider 级收敛（示例）

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": {
        profile: "minimal",
      },
    },
  },
}
```

---

## 7. 命令行修改配置（示例）

查看当前 profile：

```bash
openclaw config get tools.profile
```

切换到 coding：

```bash
openclaw config set tools.profile coding
```

设置数组（JSON5）：

```bash
openclaw config set --json tools.allow '["group:automation","group:web","message"]'
```

移除某项配置：

```bash
openclaw config unset tools.allow
```

---

## 8. 可视化观察工具调用与编排

虽然当前不是 DAG 图形工作流，但可视化入口已经够用：

1. Control UI：会话流 + 工具调用卡 + cron 运行历史  
   文档：`/Users/fullmetal/Documents/codes/openclaw/docs/web/control-ui.md`
2. CLI：`openclaw cron runs`、`openclaw sessions`、`/subagents ...`

---

## 9. 最佳实践（给你这个场景）

1. 先用 `coding` profile 起步，不要直接 `full`。
2. 对定时任务场景至少保留：`cron` + `sessions_*` + `read/write/edit` + `web_fetch`（按需）。
3. 生产环境收紧 `exec/process`，避免无约束命令执行。
4. 对外发消息时用 `message`，并配合 channel allowlist 控制边界。

---

## 10. 关键源码索引（便于你继续深挖）

1. 工具总装配：`/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.ts`
2. OpenClaw 内置工具：`/Users/fullmetal/Documents/codes/openclaw/src/agents/openclaw-tools.ts`
3. 工具说明与顺序：`/Users/fullmetal/Documents/codes/openclaw/src/agents/system-prompt.ts`
4. 策略与组定义：`/Users/fullmetal/Documents/codes/openclaw/src/agents/tool-policy.ts`
5. 策略管线：`/Users/fullmetal/Documents/codes/openclaw/src/agents/tool-policy-pipeline.ts`
6. 子代理策略：`/Users/fullmetal/Documents/codes/openclaw/src/agents/pi-tools.policy.ts`
7. 插件工具加载：`/Users/fullmetal/Documents/codes/openclaw/src/plugins/tools.ts`
8. 渠道工具注入：`/Users/fullmetal/Documents/codes/openclaw/src/agents/channel-tools.ts`
9. 官方工具文档：`/Users/fullmetal/Documents/codes/openclaw/docs/tools/index.md`
10. 插件工具文档：`/Users/fullmetal/Documents/codes/openclaw/docs/plugins/agent-tools.md`
