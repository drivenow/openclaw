import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMessageFeishu } from "./send.js";

function buildMediaFallbackText(mediaUrl: string, err: unknown): string {
  const errObj = err as {
    message?: string;
    response?: { data?: { msg?: string } };
  };
  const apiMsg = errObj.response?.data?.msg ?? "";
  const rawMsg = apiMsg || errObj.message || "unknown error";
  const needsResourceScope =
    rawMsg.includes("im:resource:upload") || rawMsg.includes("im:resource");
  const hint = needsResourceScope
    ? "附件发送失败：飞书应用缺少权限（im:resource:upload / im:resource）。"
    : `附件发送失败：${rawMsg}`;
  return `${hint}\n📎 ${mediaUrl}`;
}

export const feishuOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getFeishuRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId }) => {
    const result = await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    return { channel: "feishu", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
    // Send text first if provided
    if (text?.trim()) {
      await sendMessageFeishu({ cfg, to, text, accountId: accountId ?? undefined });
    }

    // Upload and send media if URL provided
    if (mediaUrl) {
      try {
        const result = await sendMediaFeishu({
          cfg,
          to,
          mediaUrl,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      } catch (err) {
        // Log the error for debugging
        console.error(`[feishu] sendMediaFeishu failed:`, err);
        // Fallback to URL link if upload fails
        const fallbackText = buildMediaFallbackText(mediaUrl, err);
        const result = await sendMessageFeishu({
          cfg,
          to,
          text: fallbackText,
          accountId: accountId ?? undefined,
        });
        return { channel: "feishu", ...result };
      }
    }

    // No media URL, just return text result
    const result = await sendMessageFeishu({
      cfg,
      to,
      text: text ?? "",
      accountId: accountId ?? undefined,
    });
    return { channel: "feishu", ...result };
  },
};
