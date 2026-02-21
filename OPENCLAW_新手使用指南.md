# OpenClaw 新手使用指南（macOS 本地版）

## 1. 当前状态

你的本机 OpenClaw 已可用（已通过实际命令验证）。

已验证命令：

```bash
openclaw agent --session-id main --message "请只回复: ok" --thinking off
```

返回：`ok`

## 2. 每天怎么用（最短路径）

### 打开控制台

```bash
openclaw dashboard
```

### 终端直接对话

```bash
openclaw agent --session-id main --message "今天帮我列一个工作计划" --thinking low
```

## 3. 关键检查命令

### 网关状态

```bash
openclaw gateway status
```

### 健康检查

```bash
TOKEN=$(jq -r '.gateway.auth.token' ~/.openclaw/openclaw.json)
openclaw gateway health --url ws://127.0.0.1:18789 --token "$TOKEN"
```

## 4. 常见操作

### 重启网关

```bash
openclaw gateway restart
```

### 查看日志

```bash
tail -n 120 ~/.openclaw/logs/gateway.log
```

### 切换/补录模型认证（Anthropic）

```bash
openclaw onboard --non-interactive --accept-risk --auth-choice apiKey --anthropic-api-key "$ANTHROPIC_API_KEY" --install-daemon --skip-channels --skip-skills --skip-ui --skip-health
```

## 5. 常见问题速查

### A. 报错：No API key found for provider "anthropic"

说明当前 agent 没拿到可用认证。重新执行上面的“补录模型认证”命令即可。

### B. 报错：gateway closed (1006)

通常出现在刚重启网关的短时间窗口。等待 1~3 秒后重试即可。

### C. 对话没返回内容

先执行：

1. `openclaw gateway status`
2. `openclaw gateway health ...`
3. `tail -n 120 ~/.openclaw/logs/gateway.log`

## 6. 下一步建议

1. 先固定用 `session-id main` 跑顺 3~5 轮对话。
2. 再按需接入你常用频道（Telegram/Slack 等）。
3. 如要继续排查你的自定义网关 403，按 `findings.md` 的 Gateway TODO 继续做请求级 diff。
