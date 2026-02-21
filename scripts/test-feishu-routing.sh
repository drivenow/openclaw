#!/usr/bin/env bash
# 飞书群路由测试脚本
# 用法: ./scripts/test-feishu-routing.sh

set -e

APP_ID="cli_a91d60422cb8dbce"
APP_SECRET="IBDB8lkx5XPgmhS2hFfjkcStx0aPwHdj"

CHAT_TRAINING="oc_4d1f91b50cbd3fbcb17910d13a551c05"
CHAT_VIDEO="oc_19e6a86870f61d4508bffbf77fc718e6"
CHAT_KNOWLEDGE="oc_1e2e32a206c2d7efe80127e42283dfd1"

echo "获取 access_token..."
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\": \"$APP_ID\", \"app_secret\": \"$APP_SECRET\"}" | jq -r '.tenant_access_token')

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "❌ 获取 token 失败"
  exit 1
fi

send_msg() {
  local name=$1
  local chat_id=$2
  local text=$3
  local result
  result=$(curl -s -X POST 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"receive_id\": \"$chat_id\", \"msg_type\": \"text\", \"content\": \"{\\\"text\\\": \\\"$text\\\"}\"}")
  local code
  code=$(echo "$result" | jq -r '.code')
  if [ "$code" = "0" ]; then
    echo "✅ $name: 发送成功"
  else
    echo "❌ $name: 发送失败 - $(echo "$result" | jq -r '.msg')"
  fi
}

echo ""
send_msg "训练打卡群" "$CHAT_TRAINING" "[测试] 训练打卡群路由测试"
send_msg "视频提取群" "$CHAT_VIDEO"    "[测试] 视频提取群路由测试"
send_msg "知识查询群" "$CHAT_KNOWLEDGE" "[测试] 知识查询群路由测试"
echo ""
echo "完成，请在飞书各群确认消息已收到。"
