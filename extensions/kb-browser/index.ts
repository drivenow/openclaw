import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, ReplyPayload } from "openclaw/plugin-sdk";
import {
  readJsonFileWithFallback,
  withFileLock,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk";

type EntryKind = "dir" | "file";

type KbView = {
  kind: "ls" | "find";
  cwdRel: string;
  query?: string;
  page: number;
};

type KbSessionItem = {
  kind: EntryKind;
  relPath: string;
};

type KbSession = {
  rootRealPath: string;
  cwdRel: string;
  lastView?: KbView;
  lastItems?: KbSessionItem[];
  updatedAt: string;
};

type KbStateFile = {
  version: 1;
  sessions: Record<string, KbSession>;
};

type KbRoot = {
  index: number;
  absPath: string;
  realPath: string;
  label: string;
  exists: boolean;
};

type KbResolvedConfig = {
  statePath: string;
  roots: KbRoot[];
  pageSize: number;
  searchMaxResults: number;
};

type KbEntry = {
  kind: EntryKind;
  name: string;
  absPath: string;
  relToRoot: string;
  relToCwd: string;
};

type Paginated<T> = {
  total: number;
  totalPages: number;
  page: number;
  items: T[];
};

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_SEARCH_MAX_RESULTS = 500;
const MAX_PAGE_SIZE = 100;
const MAX_SEARCH_MAX_RESULTS = 5000;
const STATE_REL_PATH = ["plugins", "kb-browser", "sessions.json"] as const;
const SORT_OPTS: Intl.CollatorOptions = {
  numeric: true,
  sensitivity: "base",
};
const LOCK_OPTIONS = {
  retries: {
    retries: 5,
    factor: 1.5,
    minTimeout: 25,
    maxTimeout: 250,
    randomize: true,
  },
  stale: 15_000,
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIntInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, n));
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function displayRelPath(rel: string): string {
  if (rel === "." || !rel.trim()) {
    return "/";
  }
  return `/${toPosix(rel)}`;
}

function normalizeRel(rel: string): string {
  const normalized = path.normalize(rel.trim() || ".");
  if (!normalized || normalized === path.sep) {
    return ".";
  }
  return normalized;
}

function isInsideRoot(rootRealPath: string, targetPath: string): boolean {
  const rel = path.relative(rootRealPath, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function byZhLocale(a: string, b: string): number {
  return a.localeCompare(b, "zh-CN", SORT_OPTS);
}

function entryComparator(a: KbEntry, b: KbEntry): number {
  if (a.kind !== b.kind) {
    return a.kind === "dir" ? -1 : 1;
  }
  const nameCmp = byZhLocale(a.name, b.name);
  if (nameCmp !== 0) {
    return nameCmp;
  }
  return byZhLocale(a.relToRoot, b.relToRoot);
}

function parseIndex(input: string | undefined): number | null {
  if (!input) {
    return null;
  }
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return null;
  }
  return n;
}

function emptyState(): KbStateFile {
  return {
    version: 1,
    sessions: {},
  };
}

function sanitizeSession(value: unknown): KbSession | null {
  if (!isRecord(value)) {
    return null;
  }
  const rootRealPath = typeof value.rootRealPath === "string" ? value.rootRealPath.trim() : "";
  const cwdRel = typeof value.cwdRel === "string" ? value.cwdRel.trim() : "";
  if (!rootRealPath || !cwdRel) {
    return null;
  }
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim() ? value.updatedAt : nowIso();
  const session: KbSession = {
    rootRealPath,
    cwdRel: normalizeRel(cwdRel),
    updatedAt,
  };

  if (Array.isArray(value.lastItems)) {
    session.lastItems = value.lastItems
      .map((item) => {
        if (!isRecord(item)) {
          return null;
        }
        const kind = item.kind === "dir" || item.kind === "file" ? item.kind : null;
        const relPath = typeof item.relPath === "string" ? item.relPath.trim() : "";
        if (!kind || !relPath) {
          return null;
        }
        return { kind, relPath: normalizeRel(relPath) };
      })
      .filter((item): item is KbSessionItem => item !== null);
  }

  if (isRecord(value.lastView)) {
    const kind =
      value.lastView.kind === "ls" || value.lastView.kind === "find" ? value.lastView.kind : null;
    const cwd = typeof value.lastView.cwdRel === "string" ? value.lastView.cwdRel.trim() : "";
    const page = parseIntInRange(value.lastView.page, 1, 1, 10_000);
    const query =
      typeof value.lastView.query === "string" ? value.lastView.query.trim() : undefined;
    if (kind && cwd) {
      session.lastView = {
        kind,
        cwdRel: normalizeRel(cwd),
        page,
        query: query || undefined,
      };
    }
  }

  return session;
}

function normalizeState(value: unknown): KbStateFile {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sessions)) {
    return emptyState();
  }
  const sessions: Record<string, KbSession> = {};
  for (const [key, sessionValue] of Object.entries(value.sessions)) {
    const session = sanitizeSession(sessionValue);
    if (!session) {
      continue;
    }
    sessions[key] = session;
  }
  return {
    version: 1,
    sessions,
  };
}

async function loadState(statePath: string): Promise<KbStateFile> {
  const { value } = await readJsonFileWithFallback<KbStateFile>(statePath, emptyState());
  return normalizeState(value);
}

async function withState<T>(statePath: string, fn: (state: KbStateFile) => Promise<T>): Promise<T> {
  return await withFileLock(statePath, LOCK_OPTIONS, async () => {
    const state = await loadState(statePath);
    const result = await fn(state);
    await writeJsonFileAtomically(statePath, state);
    return result;
  });
}

function buildSessionKey(ctx: {
  channel: string;
  accountId?: string;
  to?: string;
  from?: string;
  senderId?: string;
  messageThreadId?: number;
}): string {
  const account = (ctx.accountId ?? "").trim() || "default";
  const to = (ctx.to ?? "").trim() || "unknown-to";
  const from = (ctx.from ?? ctx.senderId ?? "").trim() || "unknown-from";
  const thread = typeof ctx.messageThreadId === "number" ? String(ctx.messageThreadId) : "-";
  return [ctx.channel.trim().toLowerCase(), account, to, from, thread].join("|");
}

async function resolveRootEntry(index: number, inputPath: string): Promise<KbRoot> {
  const absPath = path.resolve(inputPath);
  let realPath = absPath;
  let exists = false;
  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      exists = true;
      realPath = await fs.realpath(absPath);
    }
  } catch {
    exists = false;
  }
  const baseName = path.basename(absPath);
  return {
    index,
    absPath,
    realPath,
    label: baseName || absPath,
    exists,
  };
}

async function resolveConfig(api: OpenClawPluginApi): Promise<KbResolvedConfig> {
  const pluginCfg = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const configuredRoots = Array.isArray(pluginCfg.roots)
    ? pluginCfg.roots.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];

  const stateDir = api.runtime.state.resolveStateDir();
  const defaultRoot = path.join(stateDir, "workspace", "memory");
  const rawRoots = configuredRoots.length > 0 ? configuredRoots : [defaultRoot];
  const deduped = [
    ...new Set(rawRoots.map((root) => api.resolvePath(root).trim()).filter(Boolean)),
  ];
  const roots: KbRoot[] = [];
  for (let i = 0; i < deduped.length; i += 1) {
    roots.push(await resolveRootEntry(i + 1, deduped[i]));
  }

  return {
    statePath: path.join(stateDir, ...STATE_REL_PATH),
    roots,
    pageSize: parseIntInRange(pluginCfg.pageSize, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
    searchMaxResults: parseIntInRange(
      pluginCfg.searchMaxResults,
      DEFAULT_SEARCH_MAX_RESULTS,
      1,
      MAX_SEARCH_MAX_RESULTS,
    ),
  };
}

function resolveSession(state: KbStateFile, sessionKey: string, roots: KbRoot[]): KbSession {
  const current = state.sessions[sessionKey];
  const existingRoot = roots.find((root) => root.exists) ?? roots[0] ?? null;
  if (!existingRoot) {
    return {
      rootRealPath: "",
      cwdRel: ".",
      updatedAt: nowIso(),
    };
  }

  const next: KbSession = current
    ? { ...current, lastItems: current.lastItems ? [...current.lastItems] : undefined }
    : {
        rootRealPath: existingRoot.realPath,
        cwdRel: ".",
        updatedAt: nowIso(),
      };
  const rootStillValid = roots.some((root) => root.realPath === next.rootRealPath && root.exists);
  if (!rootStillValid) {
    next.rootRealPath = existingRoot.realPath;
    next.cwdRel = ".";
    next.lastItems = undefined;
    next.lastView = undefined;
  }
  return next;
}

function getActiveRoot(session: KbSession, roots: KbRoot[]): KbRoot | null {
  return roots.find((root) => root.realPath === session.rootRealPath) ?? null;
}

async function normalizeSessionCwd(session: KbSession, root: KbRoot): Promise<void> {
  const desired = normalizeRel(session.cwdRel);
  const candidate = path.resolve(root.realPath, desired);
  if (!isInsideRoot(root.realPath, candidate)) {
    session.cwdRel = ".";
    return;
  }
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      session.cwdRel = ".";
      return;
    }
  } catch {
    session.cwdRel = ".";
    return;
  }
  const real = await fs.realpath(candidate).catch(() => candidate);
  if (!isInsideRoot(root.realPath, real)) {
    session.cwdRel = ".";
    return;
  }
  session.cwdRel = normalizeRel(path.relative(root.realPath, real) || ".");
}

async function statInsideRoot(
  root: KbRoot,
  targetAbs: string,
): Promise<{ stat: Stats; realPath: string }> {
  const stat = await fs.stat(targetAbs);
  const realPath = await fs.realpath(targetAbs).catch(() => path.resolve(targetAbs));
  if (!isInsideRoot(root.realPath, realPath)) {
    throw new Error("目标路径超出允许目录范围。");
  }
  return { stat, realPath };
}

function resolveTargetAbsFromInput(params: {
  input: string;
  session: KbSession;
  root: KbRoot;
}): string {
  const raw = params.input.trim();
  if (!raw) {
    throw new Error("参数不能为空。");
  }
  if (raw.startsWith("/")) {
    const rel = normalizeRel(raw.slice(1));
    const targetAbs = path.resolve(params.root.realPath, rel);
    if (!isInsideRoot(params.root.realPath, targetAbs)) {
      throw new Error("目标路径超出允许目录范围。");
    }
    return targetAbs;
  }
  const cwdAbs = path.resolve(params.root.realPath, params.session.cwdRel);
  const targetAbs = path.resolve(cwdAbs, raw);
  if (!isInsideRoot(params.root.realPath, targetAbs)) {
    throw new Error("目标路径超出允许目录范围。");
  }
  return targetAbs;
}

function resolveSessionItemByIndex(session: KbSession, indexRaw: string): KbSessionItem {
  const idx = parseIndex(indexRaw);
  if (!idx) {
    throw new Error("序号必须是正整数。");
  }
  const items = session.lastItems ?? [];
  const item = items[idx - 1];
  if (!item) {
    throw new Error(`当前页没有第 ${idx} 项。`);
  }
  return item;
}

async function readDirectoryEntries(params: {
  dirAbs: string;
  rootRealPath: string;
  cwdAbs: string;
}): Promise<KbEntry[]> {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(params.dirAbs, { withFileTypes: true });
  } catch (err) {
    throw new Error(`读取目录失败：${String(err)}`);
  }

  const entries: KbEntry[] = [];
  for (const dirent of dirents) {
    const absPath = path.join(params.dirAbs, dirent.name);
    const relToRoot = normalizeRel(path.relative(params.rootRealPath, absPath) || ".");
    if (!isInsideRoot(params.rootRealPath, path.resolve(absPath))) {
      continue;
    }
    const relToCwd = normalizeRel(path.relative(params.cwdAbs, absPath) || ".");
    entries.push({
      kind: dirent.isDirectory() ? "dir" : "file",
      name: dirent.name,
      absPath,
      relToRoot,
      relToCwd,
    });
  }

  entries.sort(entryComparator);
  return entries;
}

async function searchEntries(params: {
  startAbs: string;
  rootRealPath: string;
  query: string;
  limit: number;
}): Promise<KbEntry[]> {
  const queryLower = params.query.toLocaleLowerCase("zh-CN");
  const matches: KbEntry[] = [];
  const stack = [params.startAbs];
  while (stack.length > 0 && matches.length < params.limit) {
    const currentDir = stack.pop() as string;
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    dirents.sort((a, b) => byZhLocale(a.name, b.name));
    for (const dirent of dirents) {
      if (matches.length >= params.limit) {
        break;
      }
      const absPath = path.join(currentDir, dirent.name);
      const relToRoot = normalizeRel(path.relative(params.rootRealPath, absPath) || ".");
      if (!isInsideRoot(params.rootRealPath, path.resolve(absPath))) {
        continue;
      }
      const relToStart = normalizeRel(path.relative(params.startAbs, absPath) || ".");
      const hitTarget = `${dirent.name} ${relToStart}`.toLocaleLowerCase("zh-CN");
      if (hitTarget.includes(queryLower)) {
        matches.push({
          kind: dirent.isDirectory() ? "dir" : "file",
          name: dirent.name,
          absPath,
          relToRoot,
          relToCwd: relToStart,
        });
      }
      if (dirent.isDirectory() && !dirent.isSymbolicLink()) {
        stack.push(absPath);
      }
    }
  }
  matches.sort(entryComparator);
  return matches;
}

function paginate<T>(items: T[], requestedPage: number, pageSize: number): Paginated<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Math.max(1, Math.floor(requestedPage)));
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return {
    total,
    totalPages,
    page,
    items: items.slice(start, end),
  };
}

function formatRoots(roots: KbRoot[], currentRoot: KbRoot | null): string {
  if (roots.length === 0) {
    return "未配置任何可访问目录。";
  }
  const lines = ["可用根目录："];
  for (const root of roots) {
    const marker = currentRoot && currentRoot.realPath === root.realPath ? "*" : " ";
    const status = root.exists ? "ready" : "missing";
    lines.push(`${marker} ${root.index}. ${root.label} (${status})`);
    lines.push(`   ${root.absPath}`);
  }
  lines.push("");
  lines.push("切换：/kb root <序号>");
  return lines.join("\n");
}

function renderLsResult(params: {
  root: KbRoot;
  session: KbSession;
  page: Paginated<KbEntry>;
}): string {
  const lines: string[] = [];
  lines.push(`根目录: ${params.root.label}`);
  lines.push(`当前位置: ${displayRelPath(params.session.cwdRel)}`);
  lines.push(`分页: ${params.page.page}/${params.page.totalPages} · 共 ${params.page.total} 项`);
  lines.push("");

  if (params.page.items.length === 0) {
    lines.push("(空目录)");
  } else {
    params.page.items.forEach((entry, i) => {
      const tag = entry.kind === "dir" ? "[DIR]" : "[FILE]";
      lines.push(`${i + 1}. ${tag} ${entry.name}`);
    });
  }

  lines.push("");
  lines.push(
    "命令: /kb cd <序号|目录> · /kb up · /kb find <关键词> · /kb next · /kb prev · /kb send <序号|文件>",
  );
  return lines.join("\n");
}

function renderFindResult(params: {
  root: KbRoot;
  cwdRel: string;
  query: string;
  page: Paginated<KbEntry>;
  maxResults: number;
}): string {
  const lines: string[] = [];
  lines.push(`根目录: ${params.root.label}`);
  lines.push(`搜索范围: ${displayRelPath(params.cwdRel)}`);
  lines.push(`关键词: ${params.query}`);
  lines.push(`分页: ${params.page.page}/${params.page.totalPages} · 命中 ${params.page.total} 项`);
  if (params.page.total >= params.maxResults) {
    lines.push(`提示: 结果已达到上限 ${params.maxResults} 条，可缩小范围后重试。`);
  }
  lines.push("");

  if (params.page.items.length === 0) {
    lines.push("(无匹配结果)");
  } else {
    params.page.items.forEach((entry, i) => {
      const tag = entry.kind === "dir" ? "[DIR]" : "[FILE]";
      lines.push(`${i + 1}. ${tag} ${toPosix(entry.relToCwd)}`);
    });
  }

  lines.push("");
  lines.push(
    "命令: /kb page <n> · /kb next · /kb prev · /kb cd <序号|目录> · /kb send <序号|文件>",
  );
  return lines.join("\n");
}

function helpText(): string {
  return [
    "KB 命令：",
    "/kb ls [目录]        列出当前目录（可分页）",
    "/kb find <关键词>    递归搜索",
    "/kb cd <序号|目录>   进入目录",
    "/kb up               返回上级目录",
    "/kb next | /kb prev  翻页",
    "/kb page <n>         跳到指定页",
    "/kb send <序号|文件> 把文件作为附件发回",
    "/kb root [序号]      查看/切换根目录",
    "/kb pwd              查看当前路径",
  ].join("\n");
}

export default function register(api: OpenClawPluginApi) {
  api.registerCommand({
    name: "kb",
    description: "Browse configured knowledge-base directories and send files back.",
    acceptsArgs: true,
    handler: async (ctx): Promise<ReplyPayload> => {
      try {
        if (!ctx.isAuthorizedSender) {
          return { text: "无权限执行 /kb 命令。" };
        }

        const cfg = await resolveConfig(api);
        const commandInput = (ctx.args ?? "").trim();
        const commandParts = commandInput.split(/\s+/).filter(Boolean);
        const sub = (commandParts[0] ?? "ls").toLowerCase();
        const rest = commandInput.slice((commandParts[0] ?? "").length).trim();

        return await withState(cfg.statePath, async (state) => {
          const sessionKey = buildSessionKey(ctx);
          const session = resolveSession(state, sessionKey, cfg.roots);
          const activeRoot = getActiveRoot(session, cfg.roots);

          if (sub === "help") {
            state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
            return { text: helpText() };
          }

          if (sub === "root" || sub === "roots") {
            if (!rest) {
              state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
              return { text: formatRoots(cfg.roots, activeRoot) };
            }
            const byIndex = parseIndex(rest);
            const nextRoot =
              (byIndex ? cfg.roots.find((root) => root.index === byIndex) : null) ??
              cfg.roots.find(
                (root) => root.label.toLocaleLowerCase("zh-CN") === rest.toLocaleLowerCase("zh-CN"),
              ) ??
              null;
            if (!nextRoot) {
              return { text: `找不到根目录: ${rest}` };
            }
            session.rootRealPath = nextRoot.realPath;
            session.cwdRel = ".";
            session.lastItems = undefined;
            session.lastView = undefined;
            if (!nextRoot.exists) {
              state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
              return {
                text: `已切换到根目录 ${nextRoot.label}，但目录当前不存在。\n${nextRoot.absPath}`,
              };
            }
          }

          const root = getActiveRoot(session, cfg.roots);
          if (!root) {
            return {
              text: "未配置任何可访问目录，请在 plugins.entries.kb-browser.config.roots 中设置。",
            };
          }
          if (!root.exists) {
            return {
              text: `当前根目录不可用: ${root.absPath}\n请先修复目录，或用 /kb root 切换到其他根目录。`,
            };
          }

          await normalizeSessionCwd(session, root);
          const cwdAbs = path.resolve(root.realPath, session.cwdRel);

          if (sub === "pwd") {
            state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
            return {
              text: [
                `根目录: ${root.label}`,
                `根路径: ${root.absPath}`,
                `当前位置: ${displayRelPath(session.cwdRel)}`,
              ].join("\n"),
            };
          }

          if (sub === "up") {
            const nextRel = normalizeRel(path.dirname(session.cwdRel));
            session.cwdRel = nextRel === "." || nextRel === path.sep ? "." : nextRel;
          }

          if (sub === "cd") {
            if (!rest) {
              return { text: "用法: /kb cd <序号|目录>" };
            }
            const indexItem = parseIndex(rest) ? resolveSessionItemByIndex(session, rest) : null;
            const targetAbs = indexItem
              ? path.resolve(root.realPath, indexItem.relPath)
              : resolveTargetAbsFromInput({ input: rest, session, root });
            const { stat, realPath } = await statInsideRoot(root, targetAbs);
            if (!stat.isDirectory()) {
              return { text: "目标不是目录，不能 cd。" };
            }
            session.cwdRel = normalizeRel(path.relative(root.realPath, realPath) || ".");
          }

          if (sub === "send") {
            if (!rest) {
              return { text: "用法: /kb send <序号|文件>" };
            }
            const indexItem = parseIndex(rest) ? resolveSessionItemByIndex(session, rest) : null;
            const targetAbs = indexItem
              ? path.resolve(root.realPath, indexItem.relPath)
              : resolveTargetAbsFromInput({ input: rest, session, root });
            const { stat, realPath } = await statInsideRoot(root, targetAbs);
            if (!stat.isFile()) {
              return { text: "目标不是文件，不能发送。" };
            }
            state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
            return {
              text: `已发送文件: ${toPosix(path.relative(root.realPath, realPath) || path.basename(realPath))}`,
              mediaUrl: realPath,
            };
          }

          if (sub === "open") {
            if (!rest) {
              return { text: "用法: /kb open <序号|路径>" };
            }
            const indexItem = parseIndex(rest) ? resolveSessionItemByIndex(session, rest) : null;
            const targetAbs = indexItem
              ? path.resolve(root.realPath, indexItem.relPath)
              : resolveTargetAbsFromInput({ input: rest, session, root });
            const { stat, realPath } = await statInsideRoot(root, targetAbs);
            if (stat.isDirectory()) {
              session.cwdRel = normalizeRel(path.relative(root.realPath, realPath) || ".");
            } else if (stat.isFile()) {
              state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
              return {
                text: `已发送文件: ${toPosix(path.relative(root.realPath, realPath) || path.basename(realPath))}`,
                mediaUrl: realPath,
              };
            } else {
              return { text: "目标既不是目录也不是普通文件。" };
            }
          }

          let listTargetRel = session.cwdRel;
          if (sub === "ls" && rest) {
            const indexItem = parseIndex(rest) ? resolveSessionItemByIndex(session, rest) : null;
            const targetAbs = indexItem
              ? path.resolve(root.realPath, indexItem.relPath)
              : resolveTargetAbsFromInput({ input: rest, session, root });
            const { stat, realPath } = await statInsideRoot(root, targetAbs);
            if (!stat.isDirectory()) {
              return { text: "ls 参数必须是目录。" };
            }
            listTargetRel = normalizeRel(path.relative(root.realPath, realPath) || ".");
            session.cwdRel = listTargetRel;
          }

          if (sub === "find") {
            if (!rest) {
              return { text: "用法: /kb find <关键词>" };
            }
            const entries = await searchEntries({
              startAbs: cwdAbs,
              rootRealPath: root.realPath,
              query: rest,
              limit: cfg.searchMaxResults,
            });
            const page = paginate(entries, 1, cfg.pageSize);
            session.lastItems = page.items.map((entry) => ({
              kind: entry.kind,
              relPath: entry.relToRoot,
            }));
            session.lastView = {
              kind: "find",
              cwdRel: session.cwdRel,
              query: rest,
              page: page.page,
            };
            state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
            return {
              text: renderFindResult({
                root,
                cwdRel: session.cwdRel,
                query: rest,
                page,
                maxResults: cfg.searchMaxResults,
              }),
            };
          }

          if (sub === "next" || sub === "prev" || sub === "page") {
            if (!session.lastView) {
              return { text: "当前没有可翻页结果，请先执行 /kb ls 或 /kb find。" };
            }
            const targetView = { ...session.lastView };
            if (sub === "next") {
              targetView.page += 1;
            } else if (sub === "prev") {
              targetView.page = Math.max(1, targetView.page - 1);
            } else {
              const targetPage = parseIntInRange(Number(rest), 1, 1, 10_000);
              targetView.page = targetPage;
            }
            session.cwdRel = targetView.cwdRel;
            await normalizeSessionCwd(session, root);
            const pagingCwdAbs = path.resolve(root.realPath, session.cwdRel);

            if (targetView.kind === "find") {
              const query = (targetView.query ?? "").trim();
              if (!query) {
                return { text: "分页状态异常：缺少查询关键词。" };
              }
              const entries = await searchEntries({
                startAbs: pagingCwdAbs,
                rootRealPath: root.realPath,
                query,
                limit: cfg.searchMaxResults,
              });
              const page = paginate(entries, targetView.page, cfg.pageSize);
              targetView.page = page.page;
              session.lastView = targetView;
              session.lastItems = page.items.map((entry) => ({
                kind: entry.kind,
                relPath: entry.relToRoot,
              }));
              state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
              return {
                text: renderFindResult({
                  root,
                  cwdRel: targetView.cwdRel,
                  query,
                  page,
                  maxResults: cfg.searchMaxResults,
                }),
              };
            }

            const entries = await readDirectoryEntries({
              dirAbs: pagingCwdAbs,
              rootRealPath: root.realPath,
              cwdAbs: pagingCwdAbs,
            });
            const page = paginate(entries, targetView.page, cfg.pageSize);
            targetView.page = page.page;
            session.lastView = targetView;
            session.lastItems = page.items.map((entry) => ({
              kind: entry.kind,
              relPath: entry.relToRoot,
            }));
            state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
            return { text: renderLsResult({ root, session, page }) };
          }

          if (sub !== "ls" && sub !== "cd" && sub !== "up" && sub !== "open" && sub !== "") {
            return { text: `未知子命令: ${sub}\n\n${helpText()}` };
          }

          const finalCwdAbs = path.resolve(root.realPath, listTargetRel);
          const entries = await readDirectoryEntries({
            dirAbs: finalCwdAbs,
            rootRealPath: root.realPath,
            cwdAbs: finalCwdAbs,
          });
          const page = paginate(entries, 1, cfg.pageSize);
          session.lastItems = page.items.map((entry) => ({
            kind: entry.kind,
            relPath: entry.relToRoot,
          }));
          session.lastView = {
            kind: "ls",
            cwdRel: session.cwdRel,
            page: page.page,
          };
          state.sessions[sessionKey] = { ...session, updatedAt: nowIso() };
          return { text: renderLsResult({ root, session, page }) };
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.warn(`kb-browser command failed: ${msg}`);
        return { text: `KB 命令执行失败: ${msg}` };
      }
    },
  });
}
