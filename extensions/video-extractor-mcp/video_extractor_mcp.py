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

DEFAULT_RPA_DIR = "/Users/fullmetal/Documents/codes/RPA"
DEFAULT_OUTPUT_DIR = os.path.expanduser("~/.openclaw/workspace/memory/rag")


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
        extract_text_from_video = load_extractor(rpa_dir)

        Path(resolved_output_dir).mkdir(parents=True, exist_ok=True)

        # Keep worker stdout JSON-clean; redirect noisy pipeline logs to stderr.
        with contextlib.redirect_stdout(sys.stderr):
            result = extract_text_from_video(url=url, title=job_title)

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

        md_filename = f"{sanitize_filename(job_title)}.md"
        md_path = os.path.join(resolved_output_dir, md_filename)

        with open(md_path, "w", encoding="utf-8") as f:
            f.write(render_markdown(job_title, url, str(content)))

        response["success"] = True
        response["message"] = response["message"] or "Success"
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
