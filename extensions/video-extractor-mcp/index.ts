import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk";
import { extractDeliveryInfo } from "../../src/config/sessions/delivery-info.js";
import { sendMessage } from "../../src/infra/outbound/message.js";

type VideoExtractorPluginConfig = {
  pythonBin?: string;
  workerScript?: string;
  rpaDir?: string;
  outputDir?: string;
  timeoutMinutes?: number;
  notifyFeishu?: boolean;
};

type ResolvedPluginConfig = {
  pythonBin: string;
  workerScript: string;
  rpaDir: string;
  outputDir: string;
  timeoutMinutes: number;
  notifyFeishu: boolean;
};

type WorkerResult = {
  success?: boolean;
  skipped?: boolean;
  message?: string;
  title?: string;
  url?: string;
  md_path?: string;
  text_file_path?: string;
};

type JobSummary = {
  jobId: string;
  status: "running" | "completed" | "failed";
  urlKey: string;
  url: string;
  title: string;
  startedAt: number;
  finishedAt?: number;
  message?: string;
  mdPath?: string;
};

const activeJobsByUrl = new Map<string, JobSummary>();
const latestJobsByUrl = new Map<string, JobSummary>();
const COMPLETION_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const RUNNING_JOB_STALE_GRACE_MS = 5 * 60 * 1000;

const EXTRACT_VIDEO_TEXT_SCHEMA = Type.Object({
  url: Type.String({ description: "Video URL (Bilibili/YouTube)." }),
  title: Type.Optional(Type.String({ description: "Optional video title." })),
});

function resolveDefaultOutputDir(api: OpenClawPluginApi): string {
  const workspace = api.config?.agents?.defaults?.workspace;
  if (typeof workspace === "string" && workspace.trim()) {
    return path.resolve(workspace.trim(), "memory", "rag");
  }
  return path.join(os.homedir(), ".openclaw", "workspace", "memory", "rag");
}

function resolvePluginConfig(api: OpenClawPluginApi): ResolvedPluginConfig {
  const raw = (api.pluginConfig ?? {}) as VideoExtractorPluginConfig;
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  return {
    pythonBin:
      typeof raw.pythonBin === "string" && raw.pythonBin.trim() ? raw.pythonBin.trim() : "python3",
    workerScript:
      typeof raw.workerScript === "string" && raw.workerScript.trim()
        ? path.resolve(raw.workerScript.trim())
        : path.resolve(thisDir, "video_extractor_mcp.py"),
    rpaDir:
      typeof raw.rpaDir === "string" && raw.rpaDir.trim()
        ? path.resolve(raw.rpaDir.trim())
        : "/Users/fullmetal/Documents/codes/RPA",
    outputDir:
      typeof raw.outputDir === "string" && raw.outputDir.trim()
        ? path.resolve(raw.outputDir.trim())
        : resolveDefaultOutputDir(api),
    timeoutMinutes:
      typeof raw.timeoutMinutes === "number" && Number.isFinite(raw.timeoutMinutes)
        ? Math.max(1, Math.min(180, Math.floor(raw.timeoutMinutes)))
        : 30,
    notifyFeishu: raw.notifyFeishu !== false,
  };
}

function sanitizeTitle(raw: string): string {
  const title = raw.trim();
  if (!title) {
    return "视频文本提取";
  }
  return title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\/:*?"<>|`']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function inferTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const lastSegment = parsed.pathname.split("/").filter(Boolean).pop();
    if (lastSegment) {
      return sanitizeTitle(`视频_${lastSegment}`);
    }
  } catch {
    // ignore and fallback
  }
  return sanitizeTitle(`视频_${Date.now()}`);
}

function parseWorkerResult(stdout: string): WorkerResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i] ?? "") as unknown;
      if (parsed && typeof parsed === "object") {
        return parsed as WorkerResult;
      }
    } catch {
      // ignore non-json lines
    }
  }
  return null;
}

function normalizeUrlKey(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    const sanitizedParams = new URLSearchParams();
    for (const [k, v] of parsed.searchParams.entries()) {
      const lk = k.toLowerCase();
      if (lk.startsWith("utm_") || lk === "spm_id_from" || lk === "vd_source") {
        continue;
      }
      sanitizedParams.append(k, v);
    }
    const query = sanitizedParams.toString();
    const base = `${parsed.origin.toLowerCase()}${parsed.pathname}`;
    return query ? `${base}?${query}` : base;
  } catch {
    return trimmed;
  }
}

function readRecentCompletedJob(urlKey: string): JobSummary | null {
  const found = latestJobsByUrl.get(urlKey);
  if (!found || found.status !== "completed" || !found.finishedAt) {
    return null;
  }
  if (Date.now() - found.finishedAt > COMPLETION_CACHE_TTL_MS) {
    latestJobsByUrl.delete(urlKey);
    return null;
  }
  return found;
}

function isRunningJobStale(job: JobSummary, timeoutMinutes: number): boolean {
  if (job.status !== "running") {
    return false;
  }
  const maxAgeMs = timeoutMinutes * 60 * 1000 + RUNNING_JOB_STALE_GRACE_MS;
  return Date.now() - job.startedAt > maxAgeMs;
}

function resolveFeishuDelivery(sessionKey?: string): { to: string; accountId?: string } | null {
  if (!sessionKey) {
    return null;
  }
  const { deliveryContext } = extractDeliveryInfo(sessionKey);
  if (deliveryContext) {
    if ((deliveryContext.channel ?? "").trim().toLowerCase() !== "feishu") {
      return null;
    }
    const to = deliveryContext.to?.trim();
    if (!to) {
      return null;
    }
    const accountId = deliveryContext.accountId?.trim() || undefined;
    return { to, accountId };
  }

  // Fallback: derive target directly from canonical channel session key.
  // Example: agent:main:feishu:group:oc_xxx / agent:main:feishu:dm:ou_xxx
  const parts = sessionKey.split(":");
  const feishuIndex = parts.indexOf("feishu");
  if (feishuIndex === -1) {
    return null;
  }
  const scope = (parts[feishuIndex + 1] ?? "").trim().toLowerCase();
  const rawTarget = (parts[feishuIndex + 2] ?? "").trim();
  if (!rawTarget) {
    return null;
  }
  if (scope === "group") {
    return { to: `chat:${rawTarget}` };
  }
  if (scope === "dm" || scope === "direct") {
    return { to: `user:${rawTarget}` };
  }
  return null;
}

async function notifyFeishuCompletion(params: {
  api: OpenClawPluginApi;
  target: { to: string; accountId?: string };
  title: string;
  url: string;
  result: WorkerResult;
}) {
  const message = `✅ 视频《${params.title}》文本提取完成。\n来源：${params.url}`;
  const mdPath = params.result.md_path?.trim();

  if (mdPath) {
    try {
      await sendMessage({
        cfg: params.api.config ?? {},
        channel: "feishu",
        to: params.target.to,
        accountId: params.target.accountId,
        content: message,
        mediaUrl: mdPath,
      });
      return;
    } catch (err) {
      params.api.logger.warn(
        `[video-extractor] completion attachment send failed, fallback to text: ${String(err)}`,
      );
      try {
        const rawMd = await readFile(mdPath, "utf-8");
        const trimmedMd = rawMd.trim();
        if (trimmedMd) {
          const maxChars = 12000;
          const body =
            trimmedMd.length > maxChars
              ? `${trimmedMd.slice(0, maxChars)}\n\n(内容较长，已截断；完整文件路径：${mdPath})`
              : trimmedMd;
          await sendMessage({
            cfg: params.api.config ?? {},
            channel: "feishu",
            to: params.target.to,
            accountId: params.target.accountId,
            content: `${message}\n⚠️ 附件上传不可用，已改为正文发送：\n\n${body}`,
          });
          return;
        }
      } catch (readErr) {
        params.api.logger.warn(`[video-extractor] md read fallback failed: ${String(readErr)}`);
      }
    }
  }

  const fallbackMessage = mdPath ? `${message}\n文档路径：${mdPath}` : message;
  await sendMessage({
    cfg: params.api.config ?? {},
    channel: "feishu",
    to: params.target.to,
    accountId: params.target.accountId,
    content: fallbackMessage,
  });
}

async function notifyFeishuFailure(params: {
  api: OpenClawPluginApi;
  target: { to: string; accountId?: string };
  title: string;
  url: string;
  reason: string;
}) {
  const message = `❌ 视频《${params.title}》文本提取失败。\n来源：${params.url}\n原因：${params.reason}\n可稍后重试，或更换链接后再试。`;
  await sendMessage({
    cfg: params.api.config ?? {},
    channel: "feishu",
    to: params.target.to,
    accountId: params.target.accountId,
    content: message,
  });
}

function runBackgroundJob(params: {
  api: OpenClawPluginApi;
  pluginConfig: ResolvedPluginConfig;
  jobId: string;
  urlKey: string;
  url: string;
  title: string;
  startedAt: number;
  sessionKey?: string;
}) {
  const { api, pluginConfig, jobId, urlKey, url, title, startedAt, sessionKey } = params;
  const prefix = `[video-extractor][${jobId}]`;
  const feishuTarget = pluginConfig.notifyFeishu ? resolveFeishuDelivery(sessionKey) : null;
  if (pluginConfig.notifyFeishu && !feishuTarget) {
    api.logger.warn(
      `${prefix} Feishu notify skipped: no delivery target (session=${sessionKey ?? "n/a"})`,
    );
  }

  api.logger.info(`${prefix} start worker url=${url} title=${title}`);

  const args = [
    pluginConfig.workerScript,
    "--mode",
    "run-job",
    "--url",
    url,
    "--title",
    title,
    "--output-dir",
    pluginConfig.outputDir,
    "--rpa-dir",
    pluginConfig.rpaDir,
  ];

  const child = spawn(pluginConfig.pythonBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
    },
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeoutMs = pluginConfig.timeoutMinutes * 60 * 1000;
  const timeout = setTimeout(() => {
    timedOut = true;
    api.logger.warn(`${prefix} timeout reached (${pluginConfig.timeoutMinutes}m), killing worker`);
    child.kill("SIGKILL");
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString();
    stderr += text;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        api.logger.info(`${prefix} worker: ${trimmed}`);
      }
    }
  });

  child.on("error", async (err) => {
    clearTimeout(timeout);
    activeJobsByUrl.delete(urlKey);
    latestJobsByUrl.set(urlKey, {
      jobId,
      status: "failed",
      urlKey,
      url,
      title,
      startedAt,
      finishedAt: Date.now(),
      message: String(err),
    });
    api.logger.error(`${prefix} worker spawn failed: ${String(err)}`);
    if (!feishuTarget) {
      return;
    }
    try {
      await notifyFeishuFailure({
        api,
        target: feishuTarget,
        title,
        url,
        reason: `启动失败：${String(err)}`,
      });
    } catch (notifyErr) {
      api.logger.error(`${prefix} failure notify failed: ${String(notifyErr)}`);
    }
  });

  child.on("close", async (code, signal) => {
    clearTimeout(timeout);

    const parsed = parseWorkerResult(stdout);
    const success = Boolean(parsed?.success);
    const reason =
      parsed?.message?.trim() ||
      (timedOut
        ? `worker timeout after ${pluginConfig.timeoutMinutes} minutes`
        : `worker exited with code=${String(code)} signal=${String(signal)}`);

    if (success) {
      activeJobsByUrl.delete(urlKey);
      latestJobsByUrl.set(urlKey, {
        jobId,
        status: "completed",
        urlKey,
        url,
        title,
        startedAt,
        finishedAt: Date.now(),
        message: parsed?.message,
        mdPath: parsed?.md_path?.trim() || undefined,
      });
      api.logger.info(`${prefix} completed successfully`);
      if (feishuTarget) {
        try {
          await notifyFeishuCompletion({
            api,
            target: feishuTarget,
            title,
            url,
            result: parsed ?? {},
          });
        } catch (notifyErr) {
          api.logger.error(`${prefix} completion notify failed: ${String(notifyErr)}`);
        }
      }
      return;
    }

    activeJobsByUrl.delete(urlKey);
    latestJobsByUrl.set(urlKey, {
      jobId,
      status: "failed",
      urlKey,
      url,
      title,
      startedAt,
      finishedAt: Date.now(),
      message: reason,
    });
    api.logger.warn(`${prefix} failed: ${reason}`);
    if (stderr.trim()) {
      api.logger.warn(`${prefix} stderr: ${stderr.trim().slice(-2000)}`);
    }
    if (!feishuTarget) {
      return;
    }
    try {
      await notifyFeishuFailure({
        api,
        target: feishuTarget,
        title,
        url,
        reason,
      });
    } catch (notifyErr) {
      api.logger.error(`${prefix} failure notify failed: ${String(notifyErr)}`);
    }
  });
}

function createExtractVideoTextTool(params: {
  api: OpenClawPluginApi;
  pluginConfig: ResolvedPluginConfig;
  toolContext: OpenClawPluginToolContext;
}) {
  const { api, pluginConfig, toolContext } = params;

  return {
    name: "extract_video_text",
    label: "Extract Video Text",
    description:
      "Extract spoken text/subtitles from a video URL asynchronously and save a Markdown file, then notify Feishu with attachment when done.",
    parameters: EXTRACT_VIDEO_TEXT_SCHEMA,
    async execute(_id: string, rawParams: Record<string, unknown>) {
      const url = typeof rawParams.url === "string" ? rawParams.url.trim() : "";
      if (!url) {
        throw new Error("url required");
      }

      const userTitle = typeof rawParams.title === "string" ? rawParams.title.trim() : "";
      const title = sanitizeTitle(userTitle || inferTitleFromUrl(url));
      const urlKey = normalizeUrlKey(url);

      const running = activeJobsByUrl.get(urlKey);
      if (running) {
        if (isRunningJobStale(running, pluginConfig.timeoutMinutes)) {
          activeJobsByUrl.delete(urlKey);
          api.logger.warn(
            `[video-extractor][${running.jobId}] stale running job evicted (ageMs=${Date.now() - running.startedAt})`,
          );
        } else {
          return {
            content: [
              {
                type: "text",
                text: `⏳ 这个视频正在处理中（jobId=${running.jobId}），无需重复提交。完成后会自动回传。`,
              },
            ],
            details: {
              queued: true,
              reused: true,
              jobId: running.jobId,
              status: "in_progress",
              title: running.title,
            },
          };
        }
      }

      const recentDone = readRecentCompletedJob(urlKey);
      if (recentDone && recentDone.mdPath) {
        const feishuTarget = pluginConfig.notifyFeishu
          ? resolveFeishuDelivery(toolContext.sessionKey)
          : null;
        if (feishuTarget) {
          try {
            await notifyFeishuCompletion({
              api,
              target: feishuTarget,
              title: recentDone.title,
              url: recentDone.url,
              result: { md_path: recentDone.mdPath },
            });
          } catch (err) {
            api.logger.warn(
              `[video-extractor][${recentDone.jobId}] resend completion failed: ${String(err)}`,
            );
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `✅ 这个视频已提取完成（jobId=${recentDone.jobId}），已尝试重新回传结果。文档路径：${recentDone.mdPath}`,
            },
          ],
          details: {
            queued: false,
            reused: true,
            jobId: recentDone.jobId,
            status: "completed",
            title: recentDone.title,
            mdPath: recentDone.mdPath,
          },
        };
      }

      const jobId = randomUUID();
      const startedAt = Date.now();
      activeJobsByUrl.set(urlKey, {
        jobId,
        status: "running",
        urlKey,
        url,
        title,
        startedAt,
      });

      runBackgroundJob({
        api,
        pluginConfig,
        jobId,
        urlKey,
        url,
        title,
        startedAt,
        sessionKey: toolContext.sessionKey,
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ 已受理视频文本提取任务（jobId=${jobId}）。任务正在后台运行，完成后会自动回传。`,
          },
        ],
        details: {
          queued: true,
          jobId,
          status: "accepted",
          title,
          outputDir: pluginConfig.outputDir,
        },
      };
    },
  };
}

export default function register(api: OpenClawPluginApi) {
  const pluginConfig = resolvePluginConfig(api);

  api.registerTool(
    (toolContext) =>
      createExtractVideoTextTool({
        api,
        pluginConfig,
        toolContext,
      }),
    { name: "extract_video_text" },
  );
}
