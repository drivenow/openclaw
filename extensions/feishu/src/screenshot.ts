import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk";
import { sendMediaFeishu } from "./media.js";
import { sendMessageFeishu } from "./send.js";
import { normalizeFeishuTarget } from "./targets.js";

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_DELAY_MS = 15_000;

const FeishuScreenshotSendSchema = Type.Object({
  target: Type.Optional(
    Type.String({
      description:
        "Optional Feishu target. Use user:open_id or chat:chat_id. If omitted, current Feishu conversation is used.",
    }),
  ),
  accountId: Type.Optional(Type.String({ description: "Optional Feishu account id override." })),
  delayMs: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: MAX_SCREENSHOT_DELAY_MS,
      description: "Optional delay before capture (milliseconds, max 15000).",
    }),
  ),
  caption: Type.Optional(Type.String({ description: "Optional text sent before the screenshot." })),
  keepLocalFile: Type.Optional(
    Type.Boolean({
      description: "If true, keep the temporary screenshot file on disk after sending.",
    }),
  ),
});

type FeishuScreenshotSendArgs = {
  target?: string;
  accountId?: string;
  delayMs?: number;
  caption?: string;
  keepLocalFile?: boolean;
};

type CaptureScreenshotFn = (params: { delayMs: number }) => Promise<string>;

function json(details: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveDelayMs(rawDelayMs: number | undefined): number {
  if (typeof rawDelayMs !== "number" || !Number.isFinite(rawDelayMs)) {
    return 0;
  }
  const rounded = Math.round(rawDelayMs);
  if (rounded <= 0) {
    return 0;
  }
  return Math.min(rounded, MAX_SCREENSHOT_DELAY_MS);
}

function buildScreenshotPath(): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return path.join(os.tmpdir(), `openclaw-feishu-shot-${suffix}.png`);
}

async function captureScreenshotOnLinux(outputPath: string): Promise<void> {
  const commands: Array<{ command: string; args: string[] }> = [
    { command: "grim", args: [outputPath] },
    { command: "gnome-screenshot", args: ["-f", outputPath] },
    { command: "import", args: ["-window", "root", outputPath] },
  ];
  const failures: string[] = [];

  for (const attempt of commands) {
    try {
      await execFileAsync(attempt.command, attempt.args);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${attempt.command}: ${message}`);
    }
  }

  throw new Error(`No supported Linux screenshot command succeeded (${failures.join(" | ")})`);
}

export async function captureDesktopScreenshot(params: { delayMs: number }): Promise<string> {
  const delayMs = resolveDelayMs(params.delayMs);
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  const outputPath = buildScreenshotPath();

  if (process.platform === "darwin") {
    await execFileAsync("screencapture", ["-x", "-t", "png", outputPath]);
  } else if (process.platform === "linux") {
    await captureScreenshotOnLinux(outputPath);
  } else {
    throw new Error(`Desktop screenshot is not supported on platform: ${process.platform}`);
  }

  const stat = await fs.stat(outputPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error("Screenshot capture failed: output file is empty");
  }

  return outputPath;
}

function parseTargetFromSessionKey(sessionKey: string | undefined): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }

  const parts = raw.split(":").map((part) => part.trim());
  const feishuIndex = parts.findIndex((part) => part.toLowerCase() === "feishu");
  if (feishuIndex === -1) {
    return undefined;
  }

  const scope = (parts[feishuIndex + 1] ?? "").toLowerCase();
  const peer = parts[feishuIndex + 2]?.trim();
  if (!peer) {
    return undefined;
  }

  if (scope === "group" || scope === "channel") {
    return `chat:${peer}`;
  }
  if (scope === "dm" || scope === "direct") {
    return `user:${peer}`;
  }

  return undefined;
}

export function resolveFeishuScreenshotTarget(params: {
  target?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitTarget = params.target?.trim();
  if (explicitTarget) {
    const normalized = normalizeFeishuTarget(explicitTarget);
    if (!normalized) {
      return undefined;
    }
    if (/^(user|chat|open_id):/i.test(explicitTarget)) {
      return explicitTarget;
    }
    if (normalized.startsWith("oc_")) {
      return `chat:${normalized}`;
    }
    if (normalized.startsWith("ou_")) {
      return `user:${normalized}`;
    }
    return normalized;
  }

  return parseTargetFromSessionKey(params.sessionKey);
}

export function createFeishuScreenshotSendTool(params: {
  cfg: OpenClawConfig;
  toolContext: OpenClawPluginToolContext;
  captureScreenshot?: CaptureScreenshotFn;
}): AnyAgentTool {
  const captureScreenshot = params.captureScreenshot ?? captureDesktopScreenshot;

  return {
    name: "feishu_screenshot_send",
    label: "Feishu Screenshot Send",
    description:
      "Capture a desktop screenshot and send it to Feishu directly. If target is omitted, sends to the current Feishu conversation.",
    parameters: FeishuScreenshotSendSchema,
    async execute(_toolCallId, args) {
      const parsed = args as FeishuScreenshotSendArgs;
      const resolvedTarget = resolveFeishuScreenshotTarget({
        target: parsed.target,
        sessionKey: params.toolContext.sessionKey,
      });

      if (!resolvedTarget) {
        return json({
          ok: false,
          error:
            "No Feishu target resolved. Provide target, or use this tool from an active Feishu conversation.",
        });
      }

      const accountId =
        (typeof parsed.accountId === "string" && parsed.accountId.trim()) ||
        params.toolContext.agentAccountId?.trim() ||
        undefined;
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
      const keepLocalFile = parsed.keepLocalFile === true;
      const delayMs = resolveDelayMs(parsed.delayMs);

      let screenshotPath: string | undefined;
      try {
        screenshotPath = await captureScreenshot({ delayMs });

        if (caption) {
          await sendMessageFeishu({
            cfg: params.cfg,
            to: resolvedTarget,
            text: caption,
            accountId,
          });
        }

        const sent = await sendMediaFeishu({
          cfg: params.cfg,
          to: resolvedTarget,
          mediaUrl: screenshotPath,
          accountId,
        });

        return json({
          ok: true,
          to: resolvedTarget,
          accountId: accountId ?? null,
          messageId: sent.messageId,
          chatId: sent.chatId,
          screenshotPath: keepLocalFile ? screenshotPath : null,
        });
      } catch (error) {
        return json({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!keepLocalFile && screenshotPath) {
          await fs.unlink(screenshotPath).catch(() => undefined);
        }
      }
    },
  };
}

export function registerFeishuScreenshotTools(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      if ((ctx.messageChannel ?? "").trim().toLowerCase() !== "feishu") {
        return null;
      }
      return createFeishuScreenshotSendTool({
        cfg: api.config,
        toolContext: ctx,
      });
    },
    { name: "feishu_screenshot_send", optional: true },
  );

  api.logger.info?.("feishu_screenshot: Registered feishu_screenshot_send tool");
}
