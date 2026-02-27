import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type ClawdbotConfig,
  type ReplyPayload,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendMediaFeishu } from "./media.js";
import type { MentionTarget } from "./mention.js";
import { buildMentionedCardContent } from "./mention.js";
import { getFeishuRuntime } from "./runtime.js";
import { sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { FeishuStreamingSession } from "./streaming-card.js";
import { resolveReceiveIdType } from "./targets.js";
import { addTypingIndicator, removeTypingIndicator, type TypingIndicatorState } from "./typing.js";

/** Detect if text contains markdown elements that benefit from card rendering */
function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
const BACKTICK_TEXT_RE = /`([^`\n]+)`/g;
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(([^)\n]+)\)/g;
const TMP_IMAGE_PATH_RE =
  /\/(?:tmp|private\/tmp|var\/folders)\/[^\s`"'<>()[\]{}]+\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?)/gi;
const MEDIA_MARKER_RE = /^MEDIA\s*:\s*(.+)$/i;

function stripSurroundingQuotes(value: string): string {
  return value
    .trim()
    .replace(/^[<"'`[\]({]+/, "")
    .replace(/[>"'`\])}]+$/, "");
}

function resolveLocalPathFromText(value: string): string | undefined {
  const trimmed = stripSurroundingQuotes(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return path.resolve(fileURLToPath(trimmed));
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(path.join(os.homedir(), trimmed.slice(2)));
  }
  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }
  return undefined;
}

function isExistingLocalImageFile(localPath: string): boolean {
  if (!IMAGE_EXT_RE.test(localPath)) {
    return false;
  }
  try {
    const stat = fs.statSync(localPath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function extractLocalImageMediaFromText(text: string): string[] {
  if (!text) {
    return [];
  }

  const mediaUrls = new Set<string>();
  const addLocalCandidate = (candidate: string) => {
    const localPath = resolveLocalPathFromText(candidate);
    if (!localPath || !isExistingLocalImageFile(localPath)) {
      return;
    }
    mediaUrls.add(localPath);
  };

  for (const match of text.matchAll(BACKTICK_TEXT_RE)) {
    addLocalCandidate(match[1] ?? "");
  }

  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const raw = stripSurroundingQuotes(match[1] ?? "");
    if (!raw) {
      continue;
    }
    const [firstToken] = raw.split(/\s+/, 1);
    addLocalCandidate(firstToken ?? raw);
  }

  for (const match of text.matchAll(TMP_IMAGE_PATH_RE)) {
    addLocalCandidate(match[0] ?? "");
  }

  return [...mediaUrls];
}

function extractMediaMarkersFromText(text: string): { cleanedText: string; mediaUrls: string[] } {
  if (!text) {
    return { cleanedText: "", mediaUrls: [] };
  }

  const mediaUrls = new Set<string>();
  const keptLines: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = MEDIA_MARKER_RE.exec(rawLine.trim());
    if (!match) {
      keptLines.push(rawLine);
      continue;
    }
    const candidate = stripSurroundingQuotes(match[1] ?? "");
    if (candidate) {
      mediaUrls.add(candidate);
    }
  }

  const cleanedText = keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, mediaUrls: [...mediaUrls] };
}

export type CreateFeishuReplyDispatcherParams = {
  cfg: ClawdbotConfig;
  agentId: string;
  runtime: RuntimeEnv;
  chatId: string;
  replyToMessageId?: string;
  mentionTargets?: MentionTarget[];
  accountId?: string;
};

export function createFeishuReplyDispatcher(params: CreateFeishuReplyDispatcherParams) {
  const core = getFeishuRuntime();
  const { cfg, agentId, chatId, replyToMessageId, mentionTargets, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  let typingState: TypingIndicatorState | null = null;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      if (!replyToMessageId) {
        return;
      }
      typingState = await addTypingIndicator({ cfg, messageId: replyToMessageId, accountId });
    },
    stop: async () => {
      if (!typingState) {
        return;
      }
      await removeTypingIndicator({ cfg, state: typingState, accountId });
      typingState = null;
    },
    onStartError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "start",
        error: err,
      }),
    onStopError: (err) =>
      logTypingFailure({
        log: (message) => params.runtime.log?.(message),
        channel: "feishu",
        action: "stop",
        error: err,
      }),
  });

  const textChunkLimit = core.channel.text.resolveTextChunkLimit(cfg, "feishu", accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "feishu");
  const tableMode = core.channel.text.resolveMarkdownTableMode({ cfg, channel: "feishu" });
  const renderMode = account.config?.renderMode ?? "auto";
  const streamingEnabled = account.config?.streaming !== false && renderMode !== "raw";

  let streaming: FeishuStreamingSession | null = null;
  let streamText = "";
  let lastPartial = "";
  let partialUpdateQueue: Promise<void> = Promise.resolve();
  let streamingStartPromise: Promise<void> | null = null;

  const startStreaming = () => {
    if (!streamingEnabled || streamingStartPromise || streaming) {
      return;
    }
    streamingStartPromise = (async () => {
      const creds =
        account.appId && account.appSecret
          ? { appId: account.appId, appSecret: account.appSecret, domain: account.domain }
          : null;
      if (!creds) {
        return;
      }

      streaming = new FeishuStreamingSession(createFeishuClient(account), creds, (message) =>
        params.runtime.log?.(`feishu[${account.accountId}] ${message}`),
      );
      try {
        await streaming.start(chatId, resolveReceiveIdType(chatId));
      } catch (error) {
        params.runtime.error?.(`feishu: streaming start failed: ${String(error)}`);
        streaming = null;
      }
    })();
  };

  const closeStreaming = async () => {
    if (streamingStartPromise) {
      await streamingStartPromise;
    }
    await partialUpdateQueue;
    if (streaming?.isActive()) {
      let text = streamText;
      if (mentionTargets?.length) {
        text = buildMentionedCardContent(mentionTargets, text);
      }
      await streaming.close(text);
    }
    streaming = null;
    streamingStartPromise = null;
    streamText = "";
    lastPartial = "";
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
      onReplyStart: () => {
        if (streamingEnabled && renderMode === "card") {
          startStreaming();
        }
        void typingCallbacks.onReplyStart?.();
      },
      deliver: async (payload: ReplyPayload, info) => {
        if (info?.kind && info.kind !== "final") {
          return;
        }

        const parsed = extractMediaMarkersFromText(payload.text ?? "");
        const text = parsed.cleanedText;
        const markerMediaUrls = parsed.mediaUrls;
        const payloadMediaUrls = payload.mediaUrls?.length
          ? payload.mediaUrls
          : payload.mediaUrl
            ? [payload.mediaUrl]
            : [];
        const explicitMediaUrls = markerMediaUrls.length > 0 ? markerMediaUrls : payloadMediaUrls;
        const inferredLocalMediaUrls =
          explicitMediaUrls.length > 0 ? [] : extractLocalImageMediaFromText(text);
        const mediaUrls = explicitMediaUrls.length > 0 ? explicitMediaUrls : inferredLocalMediaUrls;
        const hasMedia = mediaUrls.length > 0;

        if (!text.trim() && !hasMedia) {
          return;
        }

        if (markerMediaUrls.length > 0) {
          params.runtime.log?.(
            `feishu[${account.accountId}] detected ${markerMediaUrls.length} MEDIA marker(s)`,
          );
        }

        if (inferredLocalMediaUrls.length > 0) {
          params.runtime.log?.(
            `feishu[${account.accountId}] inferred ${inferredLocalMediaUrls.length} local image media path(s) from text`,
          );
        }

        // Handle text delivery
        if (text.trim()) {
          const useCard = renderMode === "card" || (renderMode === "auto" && shouldUseCard(text));

          if (streamingEnabled && useCard) {
            startStreaming();
            if (streamingStartPromise) {
              await streamingStartPromise;
            }
          }

          if (streaming?.isActive()) {
            if (info?.kind === "final") {
              streamText = text;
              await closeStreaming();
            }
            // Still send media even when streaming handles text
            if (hasMedia) {
              for (const mediaUrl of mediaUrls) {
                try {
                  await sendMediaFeishu({ cfg, to: chatId, mediaUrl, replyToMessageId, accountId });
                } catch (err) {
                  params.runtime.error?.(
                    `feishu[${account.accountId}] media send failed: ${String(err)}`,
                  );
                  // Fallback: send the URL as text
                  await sendMessageFeishu({ cfg, to: chatId, text: `📎 ${mediaUrl}`, accountId });
                }
              }
            }
            return;
          }

          let first = true;
          if (useCard) {
            for (const chunk of core.channel.text.chunkTextWithMode(
              text,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMarkdownCardFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
          } else {
            const converted = core.channel.text.convertMarkdownTables(text, tableMode);
            for (const chunk of core.channel.text.chunkTextWithMode(
              converted,
              textChunkLimit,
              chunkMode,
            )) {
              await sendMessageFeishu({
                cfg,
                to: chatId,
                text: chunk,
                replyToMessageId,
                mentions: first ? mentionTargets : undefined,
                accountId,
              });
              first = false;
            }
          }
        }

        // Handle media delivery (images, files, etc.)
        if (hasMedia) {
          for (const mediaUrl of mediaUrls) {
            try {
              await sendMediaFeishu({ cfg, to: chatId, mediaUrl, replyToMessageId, accountId });
            } catch (err) {
              params.runtime.error?.(
                `feishu[${account.accountId}] media send failed: ${String(err)}`,
              );
              // Fallback: send the URL as text
              await sendMessageFeishu({ cfg, to: chatId, text: `📎 ${mediaUrl}`, accountId });
            }
          }
        }
      },
      onError: async (error, info) => {
        params.runtime.error?.(
          `feishu[${account.accountId}] ${info.kind} reply failed: ${String(error)}`,
        );
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onIdle: async () => {
        await closeStreaming();
        typingCallbacks.onIdle?.();
      },
      onCleanup: () => {
        typingCallbacks.onCleanup?.();
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
      onPartialReply: streamingEnabled
        ? (payload: ReplyPayload) => {
            if (!payload.text || payload.text === lastPartial) {
              return;
            }
            lastPartial = payload.text;
            streamText = payload.text;
            partialUpdateQueue = partialUpdateQueue.then(async () => {
              if (streamingStartPromise) {
                await streamingStartPromise;
              }
              if (streaming?.isActive()) {
                await streaming.update(streamText);
              }
            });
          }
        : undefined,
    },
    markDispatchIdle,
  };
}
