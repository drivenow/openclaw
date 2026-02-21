---
title: "Feishu MCP Memory 新手闭坑指南"
summary: "群聊路由 + MCP + memory + 视频提取的 10 分钟排障卡片"
read_when:
  - 你第一次接 OpenClaw + Feishu
  - 你刚完成群聊路由/MCP/memory 配置，但不知道哪里不通
  - 你需要一份可以照抄执行的排障步骤
---

# Feishu 群路由 + MCP + memory 新手闭坑指南

这份文档只做一件事：帮你在 10 分钟内定位问题层级。
写法是步骤卡片，每步只有四件事：`观察`、`命令`、`正常`、`异常下一步`。

**本文涉及的四个组件**（不熟悉的先看这里）：

| 组件                | 是什么                                               |
| ------------------- | ---------------------------------------------------- |
| **网关（Gateway）** | 接收飞书事件、做路由分发的核心进程                   |
| **Agent**           | 处理对话的 AI 实例，每个群可绑定不同 agent           |
| **memory**          | 让 agent 能跨会话记住信息的工具插件（`memory-core`） |
| **MCP / 插件**      | 扩展 agent 能力的工具集，视频提取是其中一种          |

---

## 概念速览：三个新手必懂的机制

> 排障之前先建立这三个认知，否则很容易在错误的层级找问题。

### 1. 不同群组为什么能路由到不同 agent？

消息进入网关后，路由引擎按以下优先级选出一个 agent：

1. `bindings` 里有没有精确匹配当前群的 `peer.id`？→ 命中则用该 agent
2. 没有精确匹配 → 看有没有匹配 `accountId` 或 `channel` 的规则
3. 都没有 → 用 `agents.list` 里标了 `default: true` 的 agent（或第一个）

所以"不同群走不同 agent"的本质是：在 `bindings` 里为每个群 ID 写一条规则，指向不同的 `agentId`。详见 [Channel Routing](/channels/channel-routing)。

### 2. 是哪份提示词决定了 agent 的"人格"？

每个 agent 有独立的 workspace 目录（`agents.list[].workspace`）。Session 开始时，网关会把 workspace 里的这几个文件注入到上下文：

| 文件          | 作用                                             |
| ------------- | ------------------------------------------------ |
| `SOUL.md`     | 人格、语气、边界（最核心的"性格文件"）           |
| `AGENTS.md`   | 操作指令、行为规范                               |
| `IDENTITY.md` | agent 名字、emoji、自我介绍                      |
| `USER.md`     | 用户画像、称呼偏好                               |
| `TOOLS.md`    | 工具使用约定（不控制工具开关，只是给模型的说明） |

**结论**：想改 agent 的"人格"，直接编辑对应 workspace 里的 `SOUL.md`。不同群绑定不同 agent，就是不同群用不同的这套文件。

### 3. Memory 是怎么管理短期和长期记忆的？

memory 分两层，都是 workspace 目录下的普通 Markdown 文件：

| 文件                   | 定位               | 加载时机                                              |
| ---------------------- | ------------------ | ----------------------------------------------------- |
| `memory/YYYY-MM-DD.md` | 短期记忆，每天追加 | 每次 session 开始时自动读取今天 + 昨天                |
| `MEMORY.md`            | 长期记忆，精选沉淀 | 仅在私聊（main session）加载，**群聊 session 不加载** |

几个关键行为：

- 模型只"记得"写到磁盘的内容，RAM 里的上下文在 session 结束后不保留
- 当 session 接近 context 上限时，网关会触发一次静默的"记忆刷新"，提示模型把重要内容写入 `memory/YYYY-MM-DD.md`，然后压缩上下文
- 想让某件事被长期记住，明确告诉 agent "记住这个"，它会写入 `MEMORY.md`
- **群聊里不会加载 `MEMORY.md`**，这是设计行为，避免私人信息泄漏到群组上下文

---

## 0. 一页结论

> 以下是排障时最容易误判的 8 个行为，先读一遍再开始排查。日志关键字的完整说明见第 3 节。

1. 看见 `received message` 就说明飞书消息已经进到网关，不是“收不到消息”问题。
2. 看见 `dispatching to agent` 说明路由已经命中某个会话，下一步查工具或回传。
3. 看见 `dispatch complete (queuedFinal=true` 说明主回复已排队，优先查发送权限或下游工具结果。
4. `skipping duplicate message` 是幂等保护，不是消息丢失。
5. `allowlist contains unknown entries` 多数是工具名写错或插件没启用，未必阻断消息主链路。
6. 视频提取是异步任务，`已受理` 不等于 `马上回传结果`。
7. 失败任务不会“自动补发成功结果”；要重新提交才能触发新任务。
8. memory 是“可用工具”，不是“每次都必调工具”；问题不涉及历史记忆时可能不会调用。

## 1. 先跑这 5 条命令

| 命令                               | 预期关键词                            | 如果不是这个结果                                 |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------ |
| `openclaw gateway status`          | `Runtime: running`、`RPC probe: ok`   | 先处理网关存活问题，再查飞书                     |
| `openclaw channels status --probe` | `Feishu default: enabled, configured` | 先修配置或连接模式                               |
| `openclaw logs --follow`           | `[ws] ws client ready`                | 先修飞书长连接/事件订阅                          |
| `openclaw pairing list feishu`     | 能正常返回列表（可为空）              | 若报 `pairing required`，先重新配对当前 CLI 设备 |
| `openclaw doctor`                  | 无阻断级错误                          | 按 doctor 建议先修服务/配置再回测                |

## 2. 五层故障分层卡片

### 卡片 A: 接入层（飞书事件是否进入网关）

- `观察`：群里发消息后日志没有任何 Feishu 入站记录。
- `命令`：`openclaw logs --follow`
- `正常`：出现 `received message from ... in oc_xxx (group)`。
- `异常下一步`：检查飞书“事件与回调”是否启用长连接、是否订阅 `im.message.receive_v1`、应用是否已发布。

### 卡片 B: 路由层（消息是否分配到正确会话）

- `观察`：有入站日志，但不确定有没有进入 agent。
- `命令`：继续看 `openclaw logs --follow`
- `正常`：出现 `dispatching to agent (session=agent:...:feishu:group:oc_xxx)`。
- `异常下一步`：检查 `channels.feishu.groupPolicy`、`groupAllowFrom`、`groups.<oc_xxx>.enabled`、`requireMention`、`bindings`。

### 卡片 C: 工具层（memory/MCP 是否可用）

- `观察`：能 dispatch，但 agent 回答像”没有工具”、”不记得历史”，或你明确问了历史问题但没有任何 memory 调用迹象。
- `命令`：`openclaw logs --follow`
- `正常`：无持续工具缺失告警；提问”上次我们讨论了什么”类问题时，日志中可见 `memory_search` 或 `memory_get` 执行记录。
- `异常下一步`：
  1. 检查 `tools.alsoAllow` 是否包含 `memory_search`、`memory_get`
  2. 检查 `plugins.slots.memory` 是否设为 `”memory-core”`
  3. 确认插件已启用（`openclaw doctor` 无 memory 相关阻断错误）
  4. **注意**：memory 是”可用工具”，不是”每次必调工具”。如果问题本身不涉及历史记忆（如”今天天气怎么样”），agent 不会调用 memory，这是正常行为，不是 bug。

### 卡片 D: 异步执行层（视频任务是否真的在跑）

- `观察`：机器人回复“已受理”，但长时间无完成消息。
- `命令`：`openclaw logs --follow`
- `正常`：出现 `[video-extractor][jobId] start worker`，随后 `completed successfully` 或明确失败原因。
- `异常下一步`：检查 `pythonBin`、worker 依赖、`workerScript` 路径、`timeoutMinutes`。

### 卡片 E: 回传层（结果是否送回飞书）

- `观察`：worker 成功，但群里看不到结果。
- `命令`：`openclaw logs --follow`
- `正常`：可见 completion notify 成功；或附件失败后正文降级发送。
- `异常下一步`：补齐飞书发送/媒体权限，检查 `resolveFeishuDelivery` 的目标会话是否正确。

## 3. 日志关键字判定表

| 关键字                               | 代表什么              | 是否阻断          | 你该做什么                               |
| ------------------------------------ | --------------------- | ----------------- | ---------------------------------------- |
| `received message from`              | 飞书消息已进入网关    | 否                | 继续看路由层                             |
| `dispatching to agent`               | 已进入 agent 会话     | 否                | 继续看工具层/回传层                      |
| `dispatch complete`                  | 回复已完成调度        | 否                | 若前端没看到，查发送权限/目标            |
| `skipping duplicate message`         | 命中消息去重          | 否                | 不要重复改配置，先确认是否重发同一条消息 |
| `allowlist contains unknown entries` | allowlist 有无效条目  | 视情况            | 先校正工具名/插件启用；不一定影响主回复  |
| `pairing required`                   | 当前 CLI 设备权限不足 | 是（对 CLI 调用） | 先完成本机设备配对，再继续排障           |

## 4. 三套可复制配置模板

### 4.1 群路由分流模板（按群 ID 走不同 agent）

```json5
{
  agents: {
    list: [{ id: "main", default: true }, { id: "video" }, { id: "knowledge" }],
  },
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
  channels: {
    feishu: {
      enabled: true,
      connectionMode: "websocket",
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_video_group_id", "oc_knowledge_group_id"],
      requireMention: true,
      groups: {
        oc_video_group_id: { enabled: true, requireMention: true },
        oc_knowledge_group_id: { enabled: true, requireMention: true },
      },
    },
  },
}
```

生效验证命令：

```bash
openclaw logs --follow
```

预期关键词：`dispatching to agent (session=agent:video:...oc_video_group_id)` 或 `agent:knowledge:...`

### 4.2 memory 模板（minimal 配置下增量开启）

> **什么时候 memory 会被调用？**
> agent 只在判断”需要查历史记忆”时才会主动调用 memory 工具。
> 典型触发场景：用户问”上次我们讨论了什么”、”你还记得我的偏好吗”。
> 普通问答不会触发，这是正常行为，不是配置问题。

```json5
{
  plugins: {
    slots: {
      memory: “memory-core”,  // 挂载 memory 插件
    },
  },
  tools: {
    profile: “minimal”,
    alsoAllow: [“memory_search”, “memory_get”],  // 显式允许 memory 工具
  },
}
```

生效验证命令：

```bash
openclaw logs --follow
```

预期关键词：无 `memory_*` 工具缺失错误；对 agent 提问”回忆上次讨论的决策”时，日志中出现 `memory_search` 或 `memory_get` 执行记录。

**常见误区**：配置完 memory 后问了一个普通问题（如”帮我写段代码”），没看到 memory 调用就以为没生效——这是正常的，memory 只在需要历史上下文时才触发。

### 4.3 视频提取模板（异步任务 + 回传）

```json5
{
  plugins: {
    load: {
      paths: ["/path/to/openclaw/extensions/video-extractor-mcp"],
    },
    entries: {
      "video-extractor": {
        enabled: true,
        config: {
          pythonBin: "/path/to/python3.11",
          workerScript: "/path/to/openclaw/extensions/video-extractor-mcp/video_extractor_mcp.py",
          rpaDir: "/path/to/RPA",
          outputDir: "~/.openclaw/workspace/memory/rag",
          timeoutMinutes: 30,
          notifyFeishu: true,
        },
      },
    },
  },
  tools: {
    profile: "minimal",
    alsoAllow: ["extract_video_text"],
  },
}
```

生效验证命令：

```bash
openclaw logs --follow
```

预期关键词：`[video-extractor][`、`start worker`、`completed successfully`。

## 5. 常见误判（先别急着改代码）

### 看起来异常但通常不阻断

| 现象                                 | 实际含义                             | 正确处理                                      |
| ------------------------------------ | ------------------------------------ | --------------------------------------------- |
| `skipping duplicate message`         | 飞书重投事件被去重，属于正常幂等保护 | 不用处理，确认不是自己重发同一条消息即可      |
| `allowlist contains unknown entries` | allowlist 有无效工具名               | 校正工具名/确认插件启用；不一定影响主回复链路 |
| 配置 memory 后没看到 memory 调用     | 问题不涉及历史记忆，agent 不会触发   | 换成"回忆上次讨论"类问题再验证                |
| `已受理任务` 后短时间无结果          | 异步任务正常排队中                   | 等待或查 worker 日志，不要重复提交            |

### 必须处理的阻断错误

| 错误                             | 原因                | 处理方式                   |
| -------------------------------- | ------------------- | -------------------------- |
| `pairing required`               | 当前 CLI 设备未配对 | 先完成本机设备配对再继续   |
| 长时间无 `received message from` | 消息未进入网关      | 查飞书事件订阅与长连接状态 |
| `worker spawn failed` 或持续超时 | 视频提取后台未启动  | 修 Python 路径/依赖后重试  |

## 6. 验收清单（10 条）

1. 网关状态为运行中，且 RPC 探针正常。
2. 飞书通道探针显示已配置。
3. 长连接日志出现 `ws client ready`。
4. 群里发消息后出现 `received message from ... (group)`。
5. 同一条群消息出现 `dispatching to agent`。
6. 回复链路出现 `dispatch complete`。
7. 重复投递同一消息时出现 `skipping duplicate message`（幂等生效）。
8. 视频工具调用后立刻返回 `queued/jobId`。
9. 视频任务日志出现 `completed successfully` 或明确失败原因。
10. 提问“需要历史记忆”的问题时，能给出 memory 路径或上下文引用结论。

## 7. 进阶阅读

- 配置速查：[OpenClaw 配置速查手册](/openclaw-config-quickref)
- 深度实现：[飞书接入开发文档](/feishu-integration-dev)
- 视频提取复盘：[视频提取 MCP Playbook](/feishu-video-extractor-mcp-playbook)
- 插件工具策略：[Agent Tools](/plugins/agent-tools)
- memory 概念：[Memory](/concepts/memory)
- 工作区说明：[Agent Workspace](/concepts/agent-workspace)
- 路由规则：[Channel Routing](/channels/channel-routing)
