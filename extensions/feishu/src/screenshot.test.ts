import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMediaFeishuMock = vi.hoisted(() => vi.fn());
const sendMessageFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./media.js", () => ({
  sendMediaFeishu: sendMediaFeishuMock,
}));

vi.mock("./send.js", () => ({
  sendMessageFeishu: sendMessageFeishuMock,
}));

import {
  createFeishuScreenshotSendTool,
  registerFeishuScreenshotTools,
  resolveFeishuScreenshotTarget,
} from "./screenshot.js";

describe("resolveFeishuScreenshotTarget", () => {
  it("resolves explicit chat/user targets", () => {
    expect(resolveFeishuScreenshotTarget({ target: "chat:oc_chat" })).toBe("chat:oc_chat");
    expect(resolveFeishuScreenshotTarget({ target: "oc_chat" })).toBe("chat:oc_chat");
    expect(resolveFeishuScreenshotTarget({ target: "ou_user" })).toBe("user:ou_user");
  });

  it("resolves from feishu session key", () => {
    expect(resolveFeishuScreenshotTarget({ sessionKey: "agent:main:feishu:dm:ou_123" })).toBe(
      "user:ou_123",
    );
    expect(
      resolveFeishuScreenshotTarget({
        sessionKey: "agent:main:feishu:group:oc_123:topic:om_456",
      }),
    ).toBe("chat:oc_123");
  });
});

describe("createFeishuScreenshotSendTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendMediaFeishuMock.mockResolvedValue({ messageId: "m1", chatId: "oc_chat" });
    sendMessageFeishuMock.mockResolvedValue({ messageId: "m0", chatId: "oc_chat" });
  });

  it("captures screenshot and sends to current feishu session target", async () => {
    const captureScreenshot = vi.fn(async () => "/tmp/shot-a.png");
    const tool = createFeishuScreenshotSendTool({
      cfg: {} as never,
      toolContext: {
        sessionKey: "agent:main:feishu:dm:ou_abc",
        agentAccountId: "main",
      },
      captureScreenshot,
    });

    const result = await tool.execute("call-1", {});

    expect(captureScreenshot).toHaveBeenCalledWith({ delayMs: 0 });
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:ou_abc",
        mediaUrl: "/tmp/shot-a.png",
        accountId: "main",
      }),
    );

    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(true);
    expect(details.to).toBe("user:ou_abc");
    expect(details.screenshotPath).toBeNull();
  });

  it("supports explicit target, caption, and keepLocalFile", async () => {
    const captureScreenshot = vi.fn(async () => "/tmp/shot-b.png");
    const tool = createFeishuScreenshotSendTool({
      cfg: {} as never,
      toolContext: { sessionKey: "agent:main:feishu:dm:ou_abc" },
      captureScreenshot,
    });

    const result = await tool.execute("call-2", {
      target: "chat:oc_target",
      caption: "截图来了",
      keepLocalFile: true,
      accountId: "ops",
      delayMs: 1200,
    });

    expect(captureScreenshot).toHaveBeenCalledWith({ delayMs: 1200 });
    expect(sendMessageFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "chat:oc_target", text: "截图来了", accountId: "ops" }),
    );
    expect(sendMediaFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_target",
        mediaUrl: "/tmp/shot-b.png",
        accountId: "ops",
      }),
    );

    const details = result.details as Record<string, unknown>;
    expect(details.ok).toBe(true);
    expect(details.screenshotPath).toBe("/tmp/shot-b.png");
  });

  it("returns an error payload when target cannot be resolved", async () => {
    const captureScreenshot = vi.fn(async () => "/tmp/shot-c.png");
    const tool = createFeishuScreenshotSendTool({
      cfg: {} as never,
      toolContext: {},
      captureScreenshot,
    });

    const result = await tool.execute("call-3", {});
    const details = result.details as Record<string, unknown>;

    expect(details.ok).toBe(false);
    expect(String(details.error)).toContain("No Feishu target resolved");
    expect(sendMediaFeishuMock).not.toHaveBeenCalled();
  });
});

describe("registerFeishuScreenshotTools", () => {
  it("registers a feishu-only tool factory", () => {
    const registerTool = vi.fn();
    const api = {
      config: {} as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool,
    } as unknown as OpenClawPluginApi;

    registerFeishuScreenshotTools(api);

    const toolFactory = registerTool.mock.calls[0]?.[0] as
      | ((ctx: { messageChannel?: string }) => unknown)
      | undefined;
    expect(toolFactory).toBeTypeOf("function");
    expect(toolFactory?.({ messageChannel: "telegram" })).toBeNull();

    const feishuTool = toolFactory?.({
      messageChannel: "feishu",
      sessionKey: "agent:main:feishu:dm:ou_123",
    }) as { name?: string } | null;
    expect(feishuTool?.name).toBe("feishu_screenshot_send");
  });
});
