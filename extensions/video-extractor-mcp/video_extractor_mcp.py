#!/usr/bin/env python3
import argparse
import contextlib
import importlib
import json
import os
import re
import sys
import threading
from glob import glob
from pathlib import Path
from urllib.request import Request, urlopen

DEFAULT_RPA_DIR = "/Users/fullmetal/Documents/codes/RPA"
DEFAULT_OUTPUT_DIR = os.path.expanduser("~/.openclaw/workspace/memory/video")

# ---------------------------------------------------------------------------
# Douyin share-text / short-link resolver
# ---------------------------------------------------------------------------

# Matches short links like https://v.douyin.com/xxxxx or http://v.douyin.com/xxxxx
_DOUYIN_SHORT_LINK_RE = re.compile(r"https?://v\.douyin\.com/[A-Za-z0-9]+/?")

# Matches full douyin video URLs
_DOUYIN_FULL_URL_RE = re.compile(
    r"https?://www\.douyin\.com/video/\d+"
    r"|https?://www\.iesdouyin\.com/share/video/\d+"
)


def extract_douyin_url(text: str) -> str | None:
    """Extract a Douyin video URL from share text / clipboard content.

    Handles three cases:
    1. Full douyin.com/video/xxx URL already present → return as-is
    2. Short link (v.douyin.com/xxx) → resolve 302 to get real URL
    3. No recognisable Douyin link → return None
    """
    # Case 1: already a full URL
    m = _DOUYIN_FULL_URL_RE.search(text)
    if m:
        return m.group(0)

    # Case 2: short link
    m = _DOUYIN_SHORT_LINK_RE.search(text)
    if m:
        return _resolve_douyin_short_link(m.group(0))

    return None


def _resolve_douyin_short_link(short_url: str) -> str | None:
    """Follow 302 redirects on a Douyin short link to get the real video URL."""
    try:
        req = Request(short_url, method="GET")
        req.add_header(
            "User-Agent",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        )
        with urlopen(req, timeout=10) as resp:
            final_url = resp.url
        # The redirect target should contain the video ID
        m = _DOUYIN_FULL_URL_RE.search(final_url)
        if m:
            return m.group(0)
        # Sometimes the redirect lands on a page with query params; return cleaned URL
        if "douyin.com" in final_url:
            return final_url.split("?")[0]
    except Exception as exc:
        print(f"[douyin] failed to resolve short link {short_url}: {exc}", file=sys.stderr)
    return None


def is_douyin_url(url: str) -> bool:
    """Check if a URL is a Douyin video link."""
    return bool(
        "douyin.com/" in url
        or "iesdouyin.com/" in url
    )


def sanitize_filename(title: str) -> str:
    """Sanitize title into a safe filename component."""
    sanitized = re.sub(r'[\\/:*?"<>|]', "", title)
    sanitized = re.sub(r"\s+", "_", sanitized)
    sanitized = sanitized.strip("._ ")
    return sanitized[:120] if sanitized else "video_text"


def sanitize_title(title: str) -> str:
    compact = re.sub(r"[\r\n\t]+", " ", title).strip()
    return compact[:120] if compact else "视频文本提取"


def load_extractor(rpa_dir: str):
    """Load demo_mcp.extract_text_from_video from user RPA project."""
    resolved_rpa_dir = os.path.abspath(os.path.expanduser(rpa_dir))
    if resolved_rpa_dir not in sys.path:
        sys.path.insert(0, resolved_rpa_dir)

    demo_mcp = importlib.import_module("demo_mcp")
    extract_fn = getattr(demo_mcp, "extract_text_from_video", None)
    if not callable(extract_fn):
        raise RuntimeError("demo_mcp.extract_text_from_video is not callable")
    return extract_fn


def _wrap_long_line(line: str, max_chars: int = 88) -> list[str]:
    """Wrap long lines for better markdown readability."""
    compact = line.strip()
    if len(compact) <= max_chars:
        return [compact]

    chunks: list[str] = []
    cursor = compact
    while len(cursor) > max_chars:
        window = cursor[: max_chars + 20]
        split_at = -1

        # Prefer breaking on punctuation near the right edge.
        for mark in ("。", "！", "？", "；", ",", "，", ";", "!", "?"):
            idx = window.rfind(mark)
            if idx > split_at:
                split_at = idx

        if split_at < int(max_chars * 0.55):
            split_at = max_chars
        else:
            split_at += 1

        chunks.append(cursor[:split_at].strip())
        cursor = cursor[split_at:].lstrip()

    if cursor:
        chunks.append(cursor.strip())
    return [chunk for chunk in chunks if chunk]


def format_transcript_text(content: str) -> str:
    """Normalize transcript text into readable markdown paragraphs."""
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return ""

    raw_blocks = re.split(r"\n{2,}", normalized)
    formatted_blocks: list[str] = []

    for raw_block in raw_blocks:
        if not raw_block.strip():
            continue

        source_lines = [line.strip() for line in raw_block.split("\n") if line.strip()]
        merged = re.sub(r"\s+", " ", " ".join(source_lines)).strip()
        if not merged:
            continue

        # Sentence-level new lines first, then hard-wrap long segments.
        segments = re.split(r"(?<=[。！？!?；;])\s*", merged)
        lines: list[str] = []
        for seg in segments:
            text = seg.strip()
            if not text:
                continue
            lines.extend(_wrap_long_line(text))

        if not lines:
            lines = _wrap_long_line(merged)
        # Use Markdown hard-breaks so rendered viewers keep sentence-level line breaks.
        formatted_blocks.append("  \n".join(lines))

    return "\n\n".join(formatted_blocks).strip()


# ---------------------------------------------------------------------------
# LLM-based transcript polishing (fix typos, keep original meaning)
# ---------------------------------------------------------------------------

_POLISH_PROMPT = (
    "你是一个文本校对助手。下面是从视频语音识别得到的文本片段，"
    "请修正其中的错别字、语病和标点符号问题，但不要改变原意、不要删减内容、不要添加内容。"
    "直接输出修正后的文本，不要加任何解释或前缀。"
)

# Max chars per chunk sent to LLM (leave room for prompt + response)
_POLISH_CHUNK_MAX = 3000


def _call_claude_api(text: str, base_url: str, api_key: str, model: str) -> str:
    """Call Anthropic-compatible messages API using only stdlib."""
    url = f"{base_url.rstrip('/')}/v1/messages"
    payload = json.dumps({
        "model": model,
        "max_tokens": 4096,
        "messages": [
            {"role": "user", "content": f"{_POLISH_PROMPT}\n\n{text}"}
        ],
    }).encode("utf-8")

    req = Request(url, data=payload, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", api_key)
    req.add_header("anthropic-version", "2023-06-01")

    with urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    # Extract text from Anthropic response format
    for block in body.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    return text  # fallback: return original if parsing fails


def _split_into_chunks(text: str, max_chars: int = _POLISH_CHUNK_MAX) -> list[str]:
    """Split text into chunks at paragraph boundaries."""
    paragraphs = text.split("\n")
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in paragraphs:
        para_len = len(para) + 1  # +1 for newline
        if current and current_len + para_len > max_chars:
            chunks.append("\n".join(current))
            current = [para]
            current_len = para_len
        else:
            current.append(para)
            current_len += para_len

    if current:
        chunks.append("\n".join(current))
    return chunks


def polish_transcript(content: str) -> tuple[str, dict]:
    """Polish transcript text using Claude via anthropic-proxy.

    Reads LLM config from standard environment variables:
      - ANTHROPIC_BASE_URL  (e.g. http://ai.tachira.cn/api)
      - ANTHROPIC_AUTH_TOKEN (API key / token)
      - ANTHROPIC_MODEL      (optional, default: claude-sonnet-4-6)
    If base_url or auth_token is missing, polishing is skipped.
    """
    base_url = os.environ.get("ANTHROPIC_BASE_URL", "").strip()
    api_key = os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip()
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6").strip()

    if not base_url or not api_key:
        err = "LLM config not set (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN)"
        print(f"[polish] skipped: {err}", file=sys.stderr)
        return content, {
            "status": "skipped",
            "error": err,
            "failed_chunks": 0,
            "total_chunks": 0,
        }

    chunks = _split_into_chunks(content)
    print(f"[polish] polishing {len(chunks)} chunk(s) with {model}", file=sys.stderr)

    polished: list[str] = []
    errors: list[str] = []
    for i, chunk in enumerate(chunks):
        try:
            result = _call_claude_api(chunk, base_url, api_key, model)
            polished.append(result)
            print(f"[polish] chunk {i + 1}/{len(chunks)} done", file=sys.stderr)
        except Exception as exc:
            detail = f"chunk {i + 1}/{len(chunks)} failed: {exc}"
            print(f"[polish] {detail}, using original", file=sys.stderr)
            errors.append(detail)
            polished.append(chunk)

    if not errors:
        return "\n\n".join(polished), {
            "status": "ok",
            "failed_chunks": 0,
            "total_chunks": len(chunks),
        }

    if len(errors) == len(chunks):
        err = "LLM polish failed for all chunks; kept original transcript"
        status = "error"
    else:
        err = f"LLM polish partially failed ({len(errors)}/{len(chunks)} chunks); kept original for failed chunks"
        status = "partial_error"

    return "\n\n".join(polished), {
        "status": status,
        "error": err,
        "failed_chunks": len(errors),
        "total_chunks": len(chunks),
    }


def render_markdown(title: str, url: str, content: str) -> str:
    formatted_content = format_transcript_text(content)
    if not formatted_content:
        formatted_content = content.rstrip()
    return f"# {title}\n\n**Source URL:** {url}\n\n---\n\n## Transcript\n\n{formatted_content}\n"


def _candidate_text_paths(title: str, reported_path: str | None, rpa_dir: str) -> list[str]:
    candidates: list[str] = []

    if reported_path:
        reported = os.path.abspath(os.path.expanduser(str(reported_path)))
        candidates.append(reported)
        # demo_mcp currently points to audio/* in skip path; remap to rag_data/*
        candidates.append(reported.replace(f"{os.sep}audio{os.sep}", f"{os.sep}rag_data{os.sep}"))

    resolved_rpa_dir = os.path.abspath(os.path.expanduser(rpa_dir))
    candidates.append(
        os.path.join(resolved_rpa_dir, "video_output", "rag_data", "mcp_service", f"{title}.txt")
    )

    # Fuzzy fallback for slightly different title sanitization in upstream pipeline.
    rag_dir = os.path.join(resolved_rpa_dir, "video_output", "rag_data", "mcp_service")
    title_prefix = sanitize_filename(title)[:32].replace("_", "")
    for txt_path in glob(os.path.join(rag_dir, "*.txt")):
        base = os.path.splitext(os.path.basename(txt_path))[0]
        if title_prefix and title_prefix in sanitize_filename(base).replace("_", ""):
            candidates.append(txt_path)

    deduped: list[str] = []
    seen = set()
    for item in candidates:
        norm = os.path.abspath(os.path.expanduser(item))
        if norm in seen:
            continue
        seen.add(norm)
        deduped.append(norm)
    return deduped


def _load_text_content(candidates: list[str]) -> tuple[str | None, str | None]:
    for txt_path in candidates:
        if not os.path.isfile(txt_path):
            continue
        try:
            with open(txt_path, "r", encoding="utf-8") as f:
                return f.read(), txt_path
        except Exception:
            continue
    return None, None


def _resolve_output_title(
    fallback_title: str,
    result: dict,
    text_file_path: str | None,
) -> str:
    """Resolve best-effort video title for output naming.

    Priority:
    1) extractor-returned title fields
    2) extracted text filename stem
    3) fallback title from input
    """
    for key in ("title", "video_title", "videoTitle", "name"):
        raw = result.get(key)
        if isinstance(raw, str) and raw.strip():
            return sanitize_title(raw)

    if text_file_path:
        stem = Path(str(text_file_path)).stem.strip()
        if stem:
            # Upstream pipelines often replace spaces with underscores.
            guessed = re.sub(r"\s+", " ", stem.replace("_", " ")).strip()
            if guessed:
                return sanitize_title(guessed)

    return sanitize_title(fallback_title)


def run_job(url: str, title: str, output_dir: str, rpa_dir: str) -> dict:
    """Execute one extraction job and persist markdown output."""
    job_title = sanitize_title(title)
    resolved_output_dir = os.path.abspath(os.path.expanduser(output_dir))

    response = {
        "success": False,
        "skipped": False,
        "message": "",
        "title": job_title,
        "url": url,
    }

    try:
        # --- Douyin share-text / short-link pre-processing ---
        resolved_url = url
        if is_douyin_url(url):
            pass  # already a usable douyin URL
        else:
            douyin_real = extract_douyin_url(url)
            if douyin_real:
                print(f"[douyin] resolved share text → {douyin_real}", file=sys.stderr)
                resolved_url = douyin_real
                response["url"] = resolved_url

        extract_text_from_video = load_extractor(rpa_dir)

        Path(resolved_output_dir).mkdir(parents=True, exist_ok=True)

        # Determine media_type hint for douyin
        media_type_kwarg = {}
        if is_douyin_url(resolved_url):
            media_type_kwarg["media_type"] = "douyin"

        # Keep worker stdout JSON-clean; redirect noisy pipeline logs to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            result = extract_text_from_video(url=resolved_url, title=job_title, **media_type_kwarg)

        succeeded = bool(result.get("success") or result.get("skipped"))
        response["success"] = bool(result.get("success"))
        response["skipped"] = bool(result.get("skipped"))
        response["message"] = str(result.get("message") or "Success")
        response["text_file_path"] = result.get("text_file_path")

        content = result.get("content")
        if not content:
            text_candidates = _candidate_text_paths(
                title=job_title,
                reported_path=result.get("text_file_path"),
                rpa_dir=rpa_dir,
            )
            loaded_content, loaded_path = _load_text_content(text_candidates)
            if loaded_content:
                content = loaded_content
                response["text_file_path"] = loaded_path

        if not succeeded:
            response["message"] = response["message"] or "Extraction failed"
            return response

        if not content:
            response["message"] = "Extraction succeeded but no text content was produced"
            return response

        output_title = _resolve_output_title(
            fallback_title=job_title,
            result=result,
            text_file_path=response.get("text_file_path"),
        )
        response["title"] = output_title

        # --- LLM polish: fix typos while preserving meaning ---
        content, polish_meta = polish_transcript(str(content))
        response["polish_status"] = polish_meta.get("status")
        response["polish_failed_chunks"] = polish_meta.get("failed_chunks")
        if polish_meta.get("error"):
            response["polish_warning"] = str(polish_meta.get("error"))
            response["message"] = f"{response['message']} (polish warning: {response['polish_warning']})"

        txt_filename = f"{sanitize_filename(output_title)}.txt"
        txt_path = os.path.join(resolved_output_dir, txt_filename)
        with open(txt_path, "w", encoding="utf-8") as f:
            f.write(f"{str(content).rstrip()}\n")

        md_filename = f"{sanitize_filename(output_title)}.md"
        md_path = os.path.join(resolved_output_dir, md_filename)

        with open(md_path, "w", encoding="utf-8") as f:
            f.write(render_markdown(output_title, url, str(content)))

        response["success"] = True
        response["message"] = response["message"] or "Success"
        response["txt_path"] = txt_path
        response["md_path"] = md_path
        response["content_chars"] = len(str(content))
        return response

    except Exception as err:  # pylint: disable=broad-except
        response["success"] = False
        response["message"] = f"{type(err).__name__}: {err}"
        return response


def run_mcp_server(output_dir: str, rpa_dir: str):
    """Optional MCP mode kept for compatibility."""
    try:
        from mcp.server.fastmcp import FastMCP  # Lazy import: optional dependency
    except Exception as err:  # pylint: disable=broad-except
        print(f"Failed to import FastMCP: {err}", file=sys.stderr)
        sys.exit(2)

    mcp = FastMCP("Video Text Extractor")

    @mcp.tool()
    def extract_video_text(url: str, title: str) -> str:
        safe_title = sanitize_title(title)

        def _worker():
            res = run_job(url=url, title=safe_title, output_dir=output_dir, rpa_dir=rpa_dir)
            print(f"[video-extractor] MCP background job finished: {json.dumps(res, ensure_ascii=False)}", file=sys.stderr)

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        return f"✅ Video extraction queued for '{safe_title}'. Running in background."

    mcp.run()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Video extractor worker/MCP server")
    parser.add_argument("--mode", choices=["run-job", "mcp"], default="run-job")
    parser.add_argument("--url", help="Video URL")
    parser.add_argument("--title", default="视频文本提取", help="Video title")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR, help="Markdown output directory")
    parser.add_argument("--rpa-dir", default=DEFAULT_RPA_DIR, help="RPA project directory")
    return parser.parse_args()


def main():
    args = parse_args()

    if args.mode == "mcp":
        run_mcp_server(output_dir=args.output_dir, rpa_dir=args.rpa_dir)
        return

    if not args.url:
        print(json.dumps({"success": False, "message": "url required"}, ensure_ascii=False), flush=True)
        sys.exit(1)

    result = run_job(
        url=args.url,
        title=args.title,
        output_dir=args.output_dir,
        rpa_dir=args.rpa_dir,
    )
    print(json.dumps(result, ensure_ascii=False), flush=True)

    if result.get("success") or result.get("skipped"):
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
