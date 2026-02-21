---
title: "OpenClaw 配置速查手册"
summary: "~/.openclaw 目录结构 + openclaw.json 常见配置项速查"
read_when:
  - 你第一次配置 OpenClaw
  - 你不确定某个配置项写在哪里、叫什么
  - 你想快速了解 ~/.openclaw 下各文件/目录的用途
---

# OpenClaw 配置速查手册

## 1. 目录结构总览

`~/.openclaw/` 是 OpenClaw 的状态目录，存放配置、凭证、会话和索引。工作区（agent 的"大脑"）默认也在这里，但逻辑上是独立的。

```
~/.openclaw/
├── openclaw.json              # 主配置文件（你最常编辑的文件）
├── workspace/                 # 默认 agent 工作区（见下方"工作区"节）
│   ├── SOUL.md                #   人格、语气、边界
│   ├── AGENTS.md              #   操作指令、行为规范
│   ├── IDENTITY.md            #   agent 名字、emoji
│   ├── USER.md                #   用户画像
│   ├── TOOLS.md               #   工具使用约定
│   ├── MEMORY.md              #   长期记忆（精选）
│   └── memory/                #   短期记忆（按天）
│       └── YYYY-MM-DD.md
├── agents/
│   └── <agentId>/
│       ├── agent/
│       │   ├── auth-profiles.json   # 认证配置（OAuth + API 密钥）
│       │   └── auth.json            # 运行时认证缓存
│       └── sessions/
│           └── sessions.json        # 会话元数据和历史
├── credentials/               # 渠道凭证（如 WhatsApp）
├── extensions/                # 插件目录
├── logs/                      # 日志
└── sandboxes/                 # 沙箱工作区（启用沙箱时）
```

> 如果设置了 `OPENCLAW_PROFILE`（非 `"default"`），工作区默认变为 `~/.openclaw/workspace-<profile>`。

## 2. 主配置文件：openclaw.json

路径：`~/.openclaw/openclaw.json`
格式：JSON5（支持注释、尾部逗号）

所有字段都是可选的，OpenClaw 对每项都有安全默认值。下面按"你最可能需要改的顺序"列出常见配置项。

---

### 2.1 模型配置（最先要改的）

```json5
{
  agents: {
    defaults: {
      // 主模型
      model: "anthropic/claude-sonnet-4-6",
      // 或带 fallback
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-4o"],
      },
    },
  },
  // 模型提供商密钥
  models: {
    providers: {
      anthropic: { apiKey: "sk-ant-..." },
      openai: { apiKey: "sk-..." },
    },
  },
}
```

模型 ID 格式：`provider/model-name`。如果模型 ID 本身含 `/`（如 OpenRouter），需要带 provider 前缀：`openrouter/moonshotai/kimi-k2`。

详见 [Model Providers](/concepts/model-providers)、[Model Failover](/concepts/model-failover)。

---

### 2.2 Agent 列表与路由绑定

```json5
{
  agents: {
    list: [
      { id: "main", default: true }, // 默认 agent
      { id: "video", workspace: "~/.openclaw/workspace-video" }, // 独立工作区
      { id: "knowledge", workspace: "~/.openclaw/workspace-knowledge" },
    ],
  },
  // 把不同群/渠道绑定到不同 agent
  bindings: [
    {
      agentId: "video",
      match: { channel: "feishu", peer: { kind: "group", id: "oc_video_group_id" } },
    },
    {
      agentId: "knowledge",
      match: { channel: "feishu", peer: { kind: "group", id: "oc_knowledge_group_id" } },
    },
  ],
}
```

路由优先级：精确 peer 匹配 → guild/team 匹配 → account 匹配 → channel 匹配 → default agent。

详见 [Channel Routing](/channels/channel-routing)。

---

### 2.3 渠道配置（以飞书为例）

```json5
{
  channels: {
    feishu: {
      enabled: true,
      connectionMode: "websocket", // "websocket" 或 "webhook"
      groupPolicy: "allowlist", // "allowlist" | "denylist" | "all"
      groupAllowFrom: ["oc_xxx", "oc_yyy"], // 允许的群 ID 列表
      requireMention: true, // 群聊中是否需要 @机器人 才响应
      groups: {
        oc_xxx: { enabled: true, requireMention: true },
        oc_yyy: { enabled: true, requireMention: false },
      },
    },
  },
}
```

其他渠道（WhatsApp、Telegram、Slack 等）结构类似，各有特定字段。详见 [Channels](/channels/index)。

---

### 2.4 工具策略

```json5
{
  tools: {
    // 预设策略："minimal" | "standard" | "full"
    profile: "minimal",
    // 在预设基础上额外允许的工具
    alsoAllow: ["memory_search", "memory_get", "extract_video_text"],
    // 执行相关
    exec: {
      applyPatch: false, // 是否启用 apply_patch 工具
    },
  },
}
```

`profile` 决定了基础工具集，`alsoAllow` 在此基础上追加。工具名写错会触发 `allowlist contains unknown entries` 告警。

详见 [Agent Tools](/plugins/agent-tools)。

---

### 2.5 插件配置

```json5
{
  plugins: {
    // 内置插件槽位
    slots: {
      memory: "memory-core", // memory 插件，设为 "none" 可禁用
    },
    // 外部插件加载路径
    load: {
      paths: ["/path/to/openclaw/extensions/video-extractor-mcp"],
    },
    // 插件实例配置
    entries: {
      "video-extractor": {
        enabled: true,
        config: {
          pythonBin: "/path/to/python3.11",
          workerScript: "/path/to/video_extractor_mcp.py",
          timeoutMinutes: 30,
        },
      },
    },
  },
}
```

详见 [Plugins](/plugins)。

---

### 2.6 Memory 配置

```json5
{
  agents: {
    defaults: {
      // 压缩前自动刷新记忆
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
        },
      },
      // 向量搜索（语义检索 memory 文件）
      memorySearch: {
        provider: "openai", // "openai" | "gemini" | "voyage" | "local"
        model: "text-embedding-3-small",
      },
    },
  },
  // 可选：QMD 后端（实验性）
  memory: {
    backend: "qmd", // 默认不启用
  },
}
```

memory 文件本身在工作区目录（`MEMORY.md` + `memory/*.md`），不在 `openclaw.json` 里。配置只控制刷新策略和搜索后端。

详见 [Memory](/concepts/memory)。

---

### 2.7 网关配置

```json5
{
  gateway: {
    port: 18789, // RPC 端口，通常不需要改
    host: "127.0.0.1", // 监听地址
  },
}
```

详见 [Gateway Configuration](/gateway/configuration)。

---

### 2.8 身份配置

```json5
{
  identity: {
    name: "Clawd",
    theme: "helpful assistant",
    emoji: "🦞",
  },
}
```

这是全局身份，会被 agent 工作区里的 `IDENTITY.md` 覆盖。

---

### 2.9 配置拆分（$include）

配置文件大了可以拆分：

```json5
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  channels: { $include: "./channels.json5" },
}
```

- 路径相对于当前配置文件解析
- 数组形式 `$include: ["a.json5", "b.json5"]` 会按顺序深度合并
- 最多 10 层嵌套

---

## 3. 环境变量

配置中可以用 `${VAR_NAME}` 引用环境变量：

```json5
{
  models: {
    providers: {
      anthropic: { apiKey: "${ANTHROPIC_API_KEY}" },
    },
  },
}
```

常用环境变量：

| 变量                 | 作用                                      |
| -------------------- | ----------------------------------------- |
| `ANTHROPIC_API_KEY`  | Anthropic API 密钥                        |
| `OPENAI_API_KEY`     | OpenAI API 密钥（也用于 memory 向量搜索） |
| `GEMINI_API_KEY`     | Gemini API 密钥                           |
| `OPENCLAW_PROFILE`   | 多配置切换（影响工作区路径）              |
| `OPENCLAW_STATE_DIR` | 覆盖 `~/.openclaw` 状态目录               |

---

## 4. 新手常见操作对照表

| 我想...              | 改哪里                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| 换模型               | `agents.defaults.model`                                                   |
| 改 agent 人格        | 工作区里的 `SOUL.md`                                                      |
| 让不同群用不同 agent | `agents.list` + `bindings`                                                |
| 开启/关闭某个群      | `channels.feishu.groups.<id>.enabled`                                     |
| 群聊是否需要 @机器人 | `channels.feishu.requireMention` 或 per-group                             |
| 启用 memory          | `plugins.slots.memory = "memory-core"` + `tools.alsoAllow` 加 memory 工具 |
| 禁用 memory          | `plugins.slots.memory = "none"`                                           |
| 加一个 MCP 插件      | `plugins.load.paths` + `plugins.entries` + `tools.alsoAllow`              |
| 配置向量搜索         | `agents.defaults.memorySearch`                                            |
| 拆分配置文件         | 用 `$include`                                                             |

---

## 5. 进阶阅读

- 完整配置参考：[Configuration Reference](/gateway/configuration-reference)
- 配置示例集：[Configuration Examples](/gateway/configuration-examples)
- 工作区说明：[Agent Workspace](/concepts/agent-workspace)
- Memory 系统：[Memory](/concepts/memory)
- 渠道总览：[Channels](/channels/index)
- 常见问题：[FAQ](/help/faq)
