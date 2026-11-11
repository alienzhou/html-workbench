#!/usr/bin/env python3
"""Dependency-free local service for the HTML visual workbench."""

from __future__ import annotations

import argparse
import base64
import bisect
import hashlib
import html
import io
import json
import logging
import mimetypes
import os
import re
import secrets
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from logging.handlers import RotatingFileHandler
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


SERVICE_NAME = "html-workbench"
SERVICE_VERSION = "2.2.0"

DEFAULT_PORT = 4317
# Capability names advertised by /api/health. `command_open` refuses to reuse a
# service that lacks any of these: a long-lived process keeps running the code it
# was started with, while the HTML/JS assets are re-read from disk on every
# request. Reusing a stale process therefore serves a NEW frontend against an OLD
# API, and the missing route answers 501 with an HTML error page — which the
# frontend then fails to parse as JSON. Version-gating the reuse turns that
# confusing symptom into a silent, automatic restart.
SERVICE_CAPABILITIES = (
    "grapesjs-canvas",
    "autosave",
    "file-query",
    "file-watch",
    "stdlib-python",
    "visual-context",
)
MAX_REQUEST_BYTES = 8 * 1024 * 1024
SCRIPT_PATTERN = re.compile(r"^<script\b[\s\S]*</script\s*>$", re.IGNORECASE)

# ── Visual selection context ────────────────────────────────────────────────
# Anchors are resolved against the on-disk source, never against the GrapesJS
# canvas DOM: the agent edits the file, so every coordinate it receives must be
# a real offset in that file. Identity attributes are ordered by how durable
# they are across an agent rewrite. `data-wb-id` comes FIRST because we mint it
# ourselves and it is human-readable ("card", "pricing-pro"); a page's `id` may
# instead be a random token GrapesJS generated for its own style rules, which
# tells the agent nothing about what the user picked.
IDENTITY_ATTRIBUTES = ("data-wb-id", "id", "data-mode")
# Wrappers that carry no meaning on their own; a rectangle hit that lands on
# one of these is usually the user pointing at its parent.
TRANSPARENT_TAGS = {"span", "em", "strong", "b", "i", "u", "small", "svg", "path", "g", "circle", "rect", "use", "defs", "line", "polyline", "polygon", "tspan", "br"}
MAX_CONTEXT_SELECTIONS = 12
MAX_SNIPPET_CHARS = 1600
MAX_CONTEXT_BYTES = 24_000
WB_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

GRAPESJS_VERSION = "0.23.4"
VENDOR_ASSETS = {
    "grapes.min.js": {
        "route": "/vendor/grapesjs/grapes.min.js",
        "archive": "package/dist/grapes.min.js",
        "sha256": "66155421db3a640add8eaf77391b6a744d36af80833cd91d44f8d3220fb76231",
        "content_type": "text/javascript; charset=utf-8",
    },
    "grapes.min.css": {
        "route": "/vendor/grapesjs/css/grapes.min.css",
        "archive": "package/dist/css/grapes.min.css",
        "sha256": "fb55e939b3349c280d68c0617dc87e56baa3eab55ea56a1855db9f5efcc7268d",
        "content_type": "text/css; charset=utf-8",
    },
}
VENDOR_ARCHIVES = [
    ("npmmirror", f"https://registry.npmmirror.com/grapesjs/-/grapesjs-{GRAPESJS_VERSION}.tgz"),
]
VENDOR_CDNS = [
    ("cdnjs", f"https://cdnjs.cloudflare.com/ajax/libs/grapesjs/{GRAPESJS_VERSION}"),
    ("jsdelivr", f"https://cdn.jsdelivr.net/npm/grapesjs@{GRAPESJS_VERSION}/dist"),
    ("unpkg", f"https://unpkg.com/grapesjs@{GRAPESJS_VERSION}/dist"),
]


class WorkbenchError(Exception):
    def __init__(self, code: str, message: str, status: int = 500, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.extra = extra


def default_vendor_cache() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "html-workbench" / "vendor" / "grapesjs" / GRAPESJS_VERSION


LOG_MAX_BYTES = 1024 * 1024
LOG_BACKUP_COUNT = 5
LOG_RECORD_MAX_BYTES = 16 * 1024
BOOTSTRAP_MAX_BYTES = 256 * 1024


def default_log_dir() -> Path:
    """Fixed per-user log directory (stable across runs; survives tmp cleanup)."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "html-workbench" / "logs"


# Name of the runtime-state folder this process keeps beside its working
# directory. The DSH plugin resolves the same name host-side, so both halves
# agree on one location instead of scattering `.html-workbench` and
# `html-workbench-dsh` through the user's workspace.
RUNTIME_DIR_NAME = ".html-workbench"


def runtime_directory() -> Path:
    """Return this process's runtime-state root: `<cwd>/<RUNTIME_DIR_NAME>`.

    Under DSH the working directory is the session workspace, which is one of the
    only two trees the subprocess sandbox grants write access to — the other is a
    private temp directory it hands the child through TEMP/TMP. Everywhere else
    the working directory is simply a sensible, self-cleaning location. Logs and
    the GrapesJS cache are disposable, so either is acceptable; what is NOT
    acceptable is a path the sandbox refuses (see `pick_writable_dir`).
    """
    return Path.cwd() / RUNTIME_DIR_NAME


def make_temp_file(directory: Path, prefix: str, suffix: str = "") -> tuple[int, Path]:
    """Create a uniquely named temporary file in `directory`; return (fd, path).

    Deliberately NOT `tempfile.mkstemp`. On Windows CPython's `_mkstemp_inner`
    treats a `PermissionError` as "that name is already taken": it re-checks the
    directory with `os.access(dir, os.W_OK)` and then retries with a NEW random
    name, up to TMP_MAX (10 000) times. A real DACL always looks writable to
    `os.access`, which cannot see the restricted token DSH's sandbox runs the
    child under — so a directory the sandbox refuses makes `mkstemp` spin for
    minutes (one denied `os.open` per iteration, ~4 ms each) instead of failing
    in milliseconds. A single O_EXCL open turns that into an immediate error the
    caller can catch and recover from.
    """
    for attempt in range(64):
        candidate = Path(directory) / f"{prefix}{os.getpid()}-{attempt}-{os.urandom(6).hex()}{suffix}"
        try:
            descriptor = os.open(
                candidate,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
                0o600,
            )
        except FileExistsError:
            continue
        return descriptor, candidate
    raise FileExistsError(f"无法在 {directory} 创建临时文件：连续的文件名冲突")


def self_ignore(directory: Path) -> None:
    """Make a runtime directory invisible to git, best effort.

    The runtime root usually lands inside the session workspace, which for most
    users is a repository: without this, every start dirties `git status` with a
    folder holding nothing but logs and a re-downloadable cache, and the noise
    lands in the user's own project rather than ours. A `.gitignore` containing
    `*` excludes the tree including that file, so nothing has to be added to the
    repository's own ignore rules.

    Only the runtime root is marked — never an arbitrary directory the caller
    happened to pass, which may be the user's source tree (`--log-dir .`).
    """
    root = next((parent for parent in (directory, *directory.parents) if parent.name == RUNTIME_DIR_NAME), None)
    if root is None:
        return
    marker = root / ".gitignore"
    if marker.exists():
        return
    try:
        marker.write_text("# Created by html-workbench: disposable logs and cache.\n*\n", encoding="utf-8")
    except OSError:
        pass


def pick_writable_dir(*candidates: Path, failures: list[str] | None = None) -> Path:
    """Return the first candidate directory this process can really write into.

    Existence proves nothing: the sandbox DACL looks writable on paper while the
    restricted token is denied, and a folder the unconfined parent created may
    reject every file creation here with EACCES / WinError 5. The only reliable
    test is an actual create, which `make_temp_file` performs and fails fast.
    Falls back to the first candidate so a caller with nothing writable at all
    still gets a deterministic path (and a clear error at the real write).
    """
    fallback: Path | None = None
    for candidate in dict.fromkeys(candidates):
        if fallback is None:
            fallback = candidate
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            descriptor, probe = make_temp_file(candidate, prefix=".wb-write-probe.")
        except OSError as caught:
            if failures is not None:
                failures.append(f"{candidate}: {caught}")
            continue
        os.close(descriptor)
        try:
            probe.unlink()
        except OSError:
            pass
        self_ignore(candidate)
        return candidate
    return fallback if fallback is not None else Path.cwd()


def log_candidates(log_dir: Path | str) -> tuple[Path, ...]:
    """Log directories to try, best first: the caller's, then writable fallbacks."""
    return (
        Path(log_dir).expanduser(),
        runtime_directory() / "logs",
        temporary_runtime_directory() / "logs",
    )


def vendor_candidates(vendor_cache: Path | str, log_dir: Path) -> tuple[Path, ...]:
    """Vendor-cache directories to try, best first.

    The cache sits beside whichever directory accepted the log: both are
    re-creatable, and the log's parent already proved it is writable.
    """
    return (
        Path(vendor_cache).expanduser(),
        Path(log_dir).parent / "vendor",
        runtime_directory() / "vendor",
        temporary_runtime_directory() / "vendor",
    )

def temporary_runtime_directory() -> Path:
    try:
        return Path(tempfile.gettempdir()) / RUNTIME_DIR_NAME
    except OSError:
        # A denied TEMP must not prevent trying the explicitly supplied directory.
        return runtime_directory()


def bounded_utf8(text: str, limit: int) -> bytes:
    data = text.encode("utf-8", errors="backslashreplace")
    if len(data) <= limit:
        return data
    marker = b"\n...[truncated]...\n"
    remaining = limit - len(marker)
    head = data[:remaining // 3].decode("utf-8", errors="ignore").encode("utf-8")
    tail = data[-(remaining - remaining // 3):].decode("utf-8", errors="ignore").encode("utf-8")
    return head + marker + tail


class BoundedRotatingFileHandler(RotatingFileHandler):
    """Bound UTF-8 bytes, including exception stacks; back off on disk failures."""

    last_error: str | None = None
    dropped_records = 0
    retry_at = 0.0

    def emit(self, record: logging.LogRecord) -> None:
        if time.monotonic() < self.retry_at:
            self.dropped_records += 1
            return
        try:
            data = bounded_utf8(self.format(record), min(LOG_RECORD_MAX_BYTES, self.maxBytes) - 1) + b"\n"
            if self.stream is None:
                self.stream = self._open()
            if os.fstat(self.stream.fileno()).st_size + len(data) > self.maxBytes:
                self.doRollover()
            # Binary writes avoid Windows newline translation and count CJK bytes.
            self.stream.buffer.write(data)
            self.stream.flush()
            self.last_error = None
        except Exception as caught:
            self.last_error = str(caught)[:500]
            self.dropped_records += 1
            self.retry_at = time.monotonic() + 60
            try:
                print(json.dumps({"event": "log_write_failed", "message": self.last_error}), file=sys.stderr, flush=True)
            except OSError:
                pass


class BoundedOutput(io.TextIOBase):
    """Cap the detached child's combined stdout/stderr, including library output."""

    def __init__(self, output: Any) -> None:
        self.output = output
        self.lock = threading.Lock()
        self.full = False

    @property
    def encoding(self) -> str:
        return "utf-8"

    def write(self, text: str) -> int:
        with self.lock:
            if self.full:
                return len(text)
            try:
                remaining = BOOTSTRAP_MAX_BYTES - os.fstat(self.output.fileno()).st_size
                data = text.encode("utf-8", errors="backslashreplace")
                marker = b"\n[bootstrap output limit reached]\n"
                if len(data) + len(marker) > remaining:
                    self.full = True
                    data = data[:max(0, remaining - len(marker))].decode("utf-8", errors="ignore").encode("utf-8")
                    data += marker[:max(0, remaining - len(data))]
                self.output.write(data)
                self.output.flush()
            except OSError:
                self.full = True
        return len(text)

    def flush(self) -> None:
        try:
            self.output.flush()
        except (OSError, ValueError):
            pass


_logger: logging.Logger | None = None


def get_logger() -> logging.Logger:
    """Return the module logger, lazily initialised with a no-op handler.

    Library callers and tests that never run `command_serve` still get a safe
    logger; `setup_logging` attaches the rotating file handler when the service
    actually starts.
    """
    global _logger
    if _logger is None:
        _logger = logging.getLogger(SERVICE_NAME)
        _logger.setLevel(logging.INFO)
        _logger.addHandler(logging.NullHandler())
    return _logger


def setup_logging(log_dir: Path | str, port: int | None = None) -> tuple[logging.Logger, Path]:
    """Attach the rotating file handler; return the logger and the directory used.

    The requested `--log-dir` can be unusable even when it already exists — the
    sandbox denies writes to a folder whose DACL looks writable (see
    `pick_writable_dir`). The directory is therefore probed and handed back to
    the caller, so the host can report where the log really is instead of echoing
    the path it merely asked for. A missing service log is never worth failing
    the whole start: when EVERY candidate refuses writes, `pick_writable_dir`
    returns a deterministic path that the handler cannot open, so the failure is
    swallowed and the service runs without a file log rather than never binding
    its port.
    """
    failures: list[str] = []
    directory = pick_writable_dir(*log_candidates(log_dir), failures=failures)
    filename = f"workbench-{port}.log" if port is not None else "workbench.log"
    logger = get_logger()
    for existing in list(logger.handlers):
        if isinstance(existing, RotatingFileHandler):
            existing.close()
            logger.removeHandler(existing)
    logger.setLevel(logging.INFO)
    try:
        handler = BoundedRotatingFileHandler(
            directory / filename,
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
        )
    except OSError as caught:
        print(json.dumps({
            "level": "warning", "event": "log_file_unavailable",
            "message": str(caught), "attempts": failures,
        }, ensure_ascii=False), file=sys.stderr, flush=True)
        return logger, directory
    formatter = logging.Formatter("%(asctime)s.%(msecs)03dZ %(levelname)s pid=%(process)d %(message)s", "%Y-%m-%dT%H:%M:%S")
    formatter.converter = time.gmtime
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    for failure in failures:
        logger.warning("log_directory_rejected %s", failure)
    return logger, directory


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def verify_vendor_content(name: str, content: bytes) -> bytes:
    expected = str(VENDOR_ASSETS[name]["sha256"])
    actual = sha256_bytes(content)
    if actual != expected:
        raise ValueError(f"{name} 校验失败（预期 {expected}，实际 {actual}）")
    return content


def download_bytes(url: str, limit: int = 5_000_000, timeout: float = 20.0) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": f"html-workbench/{SERVICE_VERSION}"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content = response.read(limit + 1)
    if len(content) > limit:
        raise ValueError(f"下载内容超过 {limit} 字节")
    return content


def vendor_from_archive(url: str) -> dict[str, bytes]:
    archive = download_bytes(url)
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        members = {member.name: member for member in package.getmembers() if member.isfile()}
        for name, metadata in VENDOR_ASSETS.items():
            archive_name = str(metadata["archive"])
            member = members.get(archive_name)
            if member is None:
                raise ValueError(f"压缩包缺少 {archive_name}")
            source = package.extractfile(member)
            if source is None:
                raise ValueError(f"无法读取 {archive_name}")
            files[name] = verify_vendor_content(name, source.read())
    return files


def vendor_from_cdn(base_url: str) -> dict[str, bytes]:
    return {
        name: verify_vendor_content(
            name,
            download_bytes(f"{base_url}/{'css/' if name.endswith('.css') else ''}{name}"),
        )
        for name in VENDOR_ASSETS
    }


def write_vendor_cache(cache_dir: Path, files: dict[str, bytes]) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for name, content in files.items():
        descriptor, temporary_name = make_temp_file(cache_dir, prefix=f".{name}.")
        try:
            with os.fdopen(descriptor, "wb") as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_name, cache_dir / name)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)


def ensure_vendor_assets(cache_dir: Path) -> dict[str, Path]:
    logger = get_logger()
    paths = {name: cache_dir / name for name in VENDOR_ASSETS}
    try:
        for name, path in paths.items():
            verify_vendor_content(name, path.read_bytes())
        logger.info("vendor_cache_ready grapesjs=%s", GRAPESJS_VERSION)
        return paths
    except (OSError, ValueError) as caught:
        logger.info("vendor_cache_miss grapesjs=%s reason=%s", GRAPESJS_VERSION, caught)

    failures: list[str] = []
    sources = [
        *((name, url, vendor_from_archive) for name, url in VENDOR_ARCHIVES),
        *((name, url, vendor_from_cdn) for name, url in VENDOR_CDNS),
    ]
    for source_name, url, loader in sources:
        started = time.monotonic()
        try:
            logger.info("vendor_download_start source=%s", source_name)
            files = loader(url)
        except (OSError, ValueError, tarfile.TarError, urllib.error.URLError) as caught:
            failures.append(f"{source_name}: {caught}")
            logger.warning("vendor_download_failed source=%s elapsed_ms=%.0f reason=%s",
                           source_name, (time.monotonic() - started) * 1000, caught)
            continue
        try:
            write_vendor_cache(cache_dir, files)
        except (OSError, ValueError) as caught:
            failures.append(f"{source_name} cache write: {caught}")
            logger.warning("vendor_cache_write_failed source=%s reason=%s", source_name, caught)
            continue
        logger.info("vendor_download_ready source=%s elapsed_ms=%.0f", source_name, (time.monotonic() - started) * 1000)
        return paths
    raise WorkbenchError(
        "VENDOR_DOWNLOAD_FAILED",
        "首次启动需要下载约 1.2 MB 的 GrapesJS，但所有下载源均不可用。请检查网络后重试。",
        503,
        attempts=failures,
    )


@dataclass
class HtmlNode:
    tag: str
    attrs: dict[str, str]
    start: int
    start_end: int
    parent: "HtmlNode | None" = None
    end_start: int | None = None
    end_end: int | None = None
    children: list["HtmlNode"] = field(default_factory=list)

    def is_inside(self, ancestor: "HtmlNode") -> bool:
        current = self.parent
        while current is not None:
            if current is ancestor:
                return True
            current = current.parent
        return False


class SourceHtmlParser(HTMLParser):
    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=False)
        self.source = source
        self.line_offsets: list[int] = [0]
        for match in re.finditer(r"\n", source):
            self.line_offsets.append(match.end())
        self.nodes: list[HtmlNode] = []
        self.stack: list[HtmlNode] = []

    def source_offset(self) -> int:
        line, column = self.getpos()
        return self.line_offsets[line - 1] + column

    @staticmethod
    def normalize_attrs(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {name: value if value is not None else "" for name, value in attrs}

    def add_node(self, tag: str, attrs: list[tuple[str, str | None]], closed: bool) -> None:
        start = self.source_offset()
        raw = self.get_starttag_text() or ""
        parent = self.stack[-1] if self.stack else None
        node = HtmlNode(tag.lower(), self.normalize_attrs(attrs), start, start + len(raw), parent)
        if parent is not None:
            parent.children.append(node)
        self.nodes.append(node)
        if closed:
            node.end_start = node.start_end
            node.end_end = node.start_end
        else:
            self.stack.append(node)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.add_node(tag, attrs, tag.lower() in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"})

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.add_node(tag, attrs, True)

    def handle_endtag(self, tag: str) -> None:
        target = tag.lower()
        index = next((i for i in range(len(self.stack) - 1, -1, -1) if self.stack[i].tag == target), None)
        if index is None:
            return
        start = self.source_offset()
        match = re.match(r"</\s*[^>]+>", self.source[start:], re.IGNORECASE)
        end = start + (len(match.group(0)) if match else len(tag) + 3)
        node = self.stack[index]
        node.end_start = start
        node.end_end = end
        del self.stack[index:]


def parse_source(source: str) -> dict[str, Any]:
    parser = SourceHtmlParser(source)
    try:
        parser.feed(source)
        parser.close()
    except Exception as caught:
        raise WorkbenchError("INVALID_DOCUMENT", f"HTML 解析失败：{caught}", 400) from caught

    def first(tag: str) -> HtmlNode | None:
        return next((node for node in parser.nodes if node.tag == tag), None)

    html_node = first("html")
    head_node = first("head")
    body_node = first("body")
    if not html_node or not head_node or not body_node or body_node.end_start is None or head_node.end_start is None:
        raise WorkbenchError("INVALID_DOCUMENT", "目标必须是包含 html、head、body 的完整 HTML 文档。", 400)

    head_children = [node for node in parser.nodes if node.parent is head_node]
    override = next(
        (node for node in head_children if node.tag == "style" and "data-grapesjs-overrides" in node.attrs),
        None,
    )

    def inner(node: HtmlNode) -> str:
        if node.end_start is None:
            return ""
        return source[node.start_end : node.end_start]

    source_css = "\n".join(inner(node) for node in head_children if node.tag == "style" and node is not override)
    links = [
        node.attrs.get("href", "")
        for node in head_children
        if node.tag == "link" and node.attrs.get("rel", "").lower() == "stylesheet" and node.attrs.get("href")
    ]
    head_scripts = [
        {"attributes": node.attrs, "content": inner(node)}
        for node in head_children
        if node.tag == "script" and node.end_start is not None
    ]

    raw_body = source[body_node.start_end : body_node.end_start]
    body_script_nodes = [
        node
        for node in parser.nodes
        if node.tag == "script" and node.end_end is not None and node.is_inside(body_node)
    ]
    body_scripts = [source[node.start : node.end_end] for node in body_script_nodes]
    clean_body = raw_body
    for node in sorted(body_script_nodes, key=lambda item: item.start, reverse=True):
        relative_start = node.start - body_node.start_end
        relative_end = node.end_end - body_node.start_end
        clean_body = clean_body[:relative_start] + clean_body[relative_end:]

    return {
        "bodyHtml": clean_body,
        "bodyScripts": body_scripts,
        "sourceCss": source_css,
        "overrideCss": inner(override) if override else "",
        "links": links,
        "headScripts": head_scripts,
        "htmlAttributes": html_node.attrs,
        "bodyAttributes": body_node.attrs,
        "locations": {
            "bodyStart": body_node.start_end,
            "bodyEnd": body_node.end_start,
            "headEnd": head_node.end_start,
            "overrideStart": override.start if override else None,
            "overrideEnd": override.end_end if override else None,
        },
    }


def inline_event_attributes(source: str) -> list[tuple[str, tuple[str, str] | None, tuple[int, ...], dict[str, str]]]:
    """Extract body `on*` attributes with stable identity and structural fallback.

    GrapesJS intentionally strips inline event attributes from component models.
    The workbench keeps the original source as the behavioral authority, so these
    attributes must survive a visual-only save. Prefer id/data-wb-id/data-mode;
    the sibling-index path only applies when the element tree was not rearranged.
    """
    parser = SourceHtmlParser(f"<body>{source}</body>")
    parser.feed(parser.source)
    parser.close()
    body = next((node for node in parser.nodes if node.tag == "body"), None)
    if body is None:
        return []

    def path_for(node: HtmlNode) -> tuple[int, ...]:
        path: list[int] = []
        current = node
        while current.parent is not None and current.parent is not body:
            path.append(current.parent.children.index(current))
            current = current.parent
        path.append(body.children.index(current))
        return tuple(reversed(path))

    events: list[tuple[str, tuple[str, str] | None, tuple[int, ...], dict[str, str]]] = []
    for node in parser.nodes:
        if not node.is_inside(body):
            continue
        attrs = {name: value for name, value in node.attrs.items() if name.lower().startswith("on")}
        if not attrs:
            continue
        identity = next(
            ((name, node.attrs[name]) for name in ("id", "data-wb-id", "data-mode") if node.attrs.get(name)),
            None,
        )
        events.append((node.tag, identity, path_for(node), attrs))
    return events


def restore_inline_event_attributes(body_html: str, source_body_html: str) -> str:
    """Restore source inline handlers omitted by GrapesJS during serialization."""
    source_events = inline_event_attributes(source_body_html)
    if not source_events:
        return body_html

    parser = SourceHtmlParser(f"<body>{body_html}</body>")
    parser.feed(parser.source)
    parser.close()
    body = next((node for node in parser.nodes if node.tag == "body"), None)
    if body is None:
        return body_html

    def path_for(node: HtmlNode) -> tuple[int, ...]:
        path: list[int] = []
        current = node
        while current.parent is not None and current.parent is not body:
            path.append(current.parent.children.index(current))
            current = current.parent
        path.append(body.children.index(current))
        return tuple(reversed(path))

    by_identity: dict[tuple[str, str], list[HtmlNode]] = {}
    by_path: dict[tuple[int, ...], HtmlNode] = {}
    for node in parser.nodes:
        if not node.is_inside(body):
            continue
        for name in ("id", "data-wb-id", "data-mode"):
            if node.attrs.get(name):
                by_identity.setdefault((name, node.attrs[name]), []).append(node)
        by_path[path_for(node)] = node

    additions: list[tuple[int, str]] = []
    for tag, identity, path, attributes in source_events:
        candidates = by_identity.get(identity, []) if identity else []
        target = candidates[0] if len(candidates) == 1 else by_path.get(path)
        if target is None or target.tag != tag:
            continue
        missing = {
            name: value
            for name, value in attributes.items()
            if name.lower() not in {existing.lower() for existing in target.attrs}
        }
        if missing:
            serialized = "".join(f' {name}="{html.escape(value, quote=True)}"' for name, value in missing.items())
            additions.append((target.start_end - 1, serialized))

    restored = body_html
    # Offsets include the synthetic `<body>` prefix; apply from right to left.
    synthetic_prefix = len("<body>")
    for offset, serialized in sorted(additions, reverse=True):
        index = offset - synthetic_prefix
        restored = restored[:index] + serialized + restored[index:]
    return restored


def revision_of(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


# ── Visual selection anchors ────────────────────────────────────────────────
#
# The agent edits the file on disk, so a selection is only useful if it can be
# translated into *source* coordinates. The canvas DOM is a GrapesJS runtime
# model and must never be treated as the authority here: the browser reports
# WHICH node the user picked, and this module re-parses the on-disk source to
# decide WHERE that node lives.
#
# Resolution is deliberately conservative. An anchor is only accepted when it
# maps to exactly one source node; zero and multiple matches are both refused
# so an ambiguous anchor can never reach the agent.


def source_body(parser: SourceHtmlParser) -> HtmlNode | None:
    return next((node for node in parser.nodes if node.tag == "body"), None)


def parse_document_tree(source: str) -> tuple[SourceHtmlParser, HtmlNode]:
    parser = SourceHtmlParser(source)
    try:
        parser.feed(source)
        parser.close()
    except Exception as caught:
        raise WorkbenchError("INVALID_DOCUMENT", f"HTML 解析失败：{caught}", 400) from caught
    body = source_body(parser)
    if body is None:
        raise WorkbenchError("INVALID_DOCUMENT", "目标必须是包含 body 的完整 HTML 文档。", 400)
    return parser, body


def structural_children(node: HtmlNode) -> list[HtmlNode]:
    """Element children as the *editor* sees them.

    `parse_source` strips body `<script>` elements before handing the document
    to GrapesJS, so the canvas child indices skip them. The structural fallback
    path must use the same numbering or every index after an inline script
    would be off by one.
    """
    return [child for child in node.children if child.tag != "script"]


def node_path(node: HtmlNode, body: HtmlNode) -> list[int] | None:
    path: list[int] = []
    current = node
    while current is not body:
        parent = current.parent
        if parent is None:
            return None
        siblings = structural_children(parent)
        if current not in siblings:
            return None
        path.append(siblings.index(current))
        current = parent
    path.reverse()
    return path


def node_at_path(body: HtmlNode, path: list[int]) -> HtmlNode | None:
    current = body
    for index in path:
        siblings = structural_children(current)
        if not isinstance(index, int) or index < 0 or index >= len(siblings):
            return None
        current = siblings[index]
    return current if current is not body else None


def line_of(parser: SourceHtmlParser, offset: int) -> int:
    return bisect.bisect_right(parser.line_offsets, offset)


def node_text(source: str, node: HtmlNode) -> str:
    if node.end_start is None:
        return ""
    raw = source[node.start_end : node.end_start]
    raw = re.sub(r"<script\b[\s\S]*?</script\s*>", " ", raw, flags=re.IGNORECASE)
    raw = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", html.unescape(raw)).strip()


def identity_of(node: HtmlNode) -> dict[str, str] | None:
    # Ordering does the work: `data-wb-id` is checked before `id`, so a random
    # GrapesJS token only becomes the label when nothing better exists.
    for name in IDENTITY_ATTRIBUTES:
        value = node.attrs.get(name)
        if value:
            return {"name": name, "value": value}
    return None


def selector_of(node: HtmlNode) -> str:
    identity = identity_of(node)
    if identity is None:
        classes = [item for item in node.attrs.get("class", "").split() if item]
        return node.tag + "".join(f".{item}" for item in classes[:2])
    if identity["name"] == "id":
        return f"#{identity['value']}"
    return f'[{identity["name"]}="{identity["value"]}"]'


def normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def resolve_anchor(parser: SourceHtmlParser, body: HtmlNode, descriptor: dict[str, Any]) -> HtmlNode:
    """Map a browser-side selection descriptor onto exactly one source node."""
    if not isinstance(descriptor, dict):
        raise WorkbenchError("INVALID_ANCHOR", "选区描述必须是对象。", 400)

    expected_tag = str(descriptor.get("tag") or "").lower() or None
    raw_path = descriptor.get("path")
    path = [item for item in raw_path if isinstance(item, int)] if isinstance(raw_path, list) else None
    if isinstance(raw_path, list) and path is not None and len(path) != len(raw_path):
        path = None
    text_hint = normalized_text(str(descriptor.get("textHint") or ""))

    identity = descriptor.get("identity")
    candidates: list[HtmlNode] = []
    strategy = ""

    if isinstance(identity, dict) and identity.get("name") in IDENTITY_ATTRIBUTES and identity.get("value"):
        name = str(identity["name"])
        value = str(identity["value"])
        candidates = [
            node for node in parser.nodes
            if node.is_inside(body) and node.attrs.get(name) == value
        ]
        strategy = "identity"

    if len(candidates) != 1 and path is not None:
        # Either the identity was absent or it was ambiguous; the structural
        # path can both stand alone and disambiguate an identity collision.
        located = node_at_path(body, path)
        if located is not None:
            if len(candidates) > 1 and located in candidates:
                candidates = [located]
                strategy = "identity+path"
            elif not candidates:
                candidates = [located]
                strategy = "path"

    if not candidates:
        raise WorkbenchError(
            "ANCHOR_NOT_FOUND",
            "选中的元素在当前磁盘文件中已不存在，请重新选择。",
            409,
        )
    if len(candidates) > 1:
        raise WorkbenchError(
            "ANCHOR_AMBIGUOUS",
            f"选中的元素在源文件中匹配到 {len(candidates)} 个节点，无法唯一定位。",
            409,
        )

    node = candidates[0]
    if expected_tag and node.tag != expected_tag:
        raise WorkbenchError(
            "ANCHOR_NOT_FOUND",
            f"定位到的节点是 <{node.tag}>，与选中的 <{expected_tag}> 不一致，请重新选择。",
            409,
        )
    if text_hint and strategy in {"path", "identity+path"}:
        # A path is only as good as the tree it was computed against. When the
        # caller supplied visible text, require it to still overlap.
        #
        # Compare with whitespace REMOVED, not merely collapsed. `node_text`
        # replaces each tag with a space, so `<h3>专业版</h3><p>￥99</p>` becomes
        # "专业版 ￥99", while the browser's `textContent` yields "专业版￥99" — the
        # same content, differing only where markup used to be. Comparing those
        # literally rejects every correct anchor in tightly-written HTML.
        actual = collapse_for_comparison(node_text(parser.source, node))
        probe = collapse_for_comparison(text_hint)[:40]
        if probe and probe not in actual and actual[:40] not in probe:
            raise WorkbenchError(
                "ANCHOR_NOT_FOUND",
                "定位到的节点内容与选中的元素不一致，请重新选择。",
                409,
            )
    return node


def collapse_for_comparison(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def describe_anchor(parser: SourceHtmlParser, body: HtmlNode, node: HtmlNode) -> dict[str, Any]:
    source = parser.source
    end = node.end_end if node.end_end is not None else node.start_end
    snippet = source[node.start : end]
    truncated = len(snippet) > MAX_SNIPPET_CHARS
    if truncated:
        head = snippet[: MAX_SNIPPET_CHARS // 2].rstrip()
        tail = snippet[-(MAX_SNIPPET_CHARS // 4) :].lstrip()
        snippet = f"{head}\n<!-- … 省略 {len(source[node.start:end]) - len(head) - len(tail)} 字符 … -->\n{tail}"

    ancestors: list[str] = []
    current = node.parent
    while current is not None and current is not body:
        ancestors.append(selector_of(current))
        current = current.parent
    ancestors.reverse()

    behavior = {
        name: value for name, value in node.attrs.items()
        if name in {"data-action", "data-target"} or name.lower().startswith("on")
    }

    return {
        "tag": node.tag,
        "selector": selector_of(node),
        "identity": identity_of(node),
        "path": node_path(node, body),
        "lineStart": line_of(parser, node.start),
        "lineEnd": line_of(parser, max(node.start, end - 1)),
        "startOffset": node.start,
        "endOffset": end,
        "text": node_text(source, node)[:240],
        "classes": [item for item in node.attrs.get("class", "").split() if item],
        "attributes": {name: value for name, value in node.attrs.items() if name != "class"},
        "behavior": behavior,
        "ancestors": ancestors,
        "snippet": snippet,
        "snippetTruncated": truncated,
    }


# ── Related style and behaviour evidence ────────────────────────────────────
#
# "Make this purple" only needs the element and its CSS. "Improve this
# interaction" needs the JavaScript that drives it — and `parse_source` keeps
# body scripts out of the editable model, so that code has to be recovered from
# the raw source separately.

STYLE_BLOCK_PATTERN = re.compile(r"<style\b([^>]*)>([\s\S]*?)</style\s*>", re.IGNORECASE)
SCRIPT_BLOCK_PATTERN = re.compile(r"<script\b([^>]*)>([\s\S]*?)</script\s*>", re.IGNORECASE)
AT_RULE_PATTERN = re.compile(r"@[a-zA-Z-]+")


def split_css_rules(css: str, base_offset: int) -> list[dict[str, Any]]:
    """Split a stylesheet into top-level rules, keeping source offsets.

    A hand-rolled brace scanner rather than a regex: nested at-rules such as
    `@media` contain their own blocks, and a flat regex would cut them in half.
    """
    rules: list[dict[str, Any]] = []
    depth = 0
    start = 0
    index = 0
    length = len(css)
    while index < length:
        char = css[index]
        if char == "/" and css.startswith("/*", index):
            closing = css.find("*/", index + 2)
            index = length if closing == -1 else closing + 2
            continue
        if char in {'"', "'"}:
            quote = char
            index += 1
            while index < length and css[index] != quote:
                index += 2 if css[index] == "\\" else 1
            index += 1
            continue
        if char == "{":
            if depth == 0:
                prelude = css[start:index]
            depth += 1
        elif char == "}":
            depth -= 1
            if depth <= 0:
                depth = 0
                body = css[start : index + 1]
                selector = normalized_text(re.sub(r"/\*[\s\S]*?\*/", " ", prelude))
                if selector:
                    rules.append({
                        "selector": selector,
                        "text": body.strip(),
                        "start": base_offset + start,
                        "end": base_offset + index + 1,
                    })
                start = index + 1
        index += 1
    return rules


def document_css_rules(source: str) -> list[dict[str, Any]]:
    rules: list[dict[str, Any]] = []
    for match in STYLE_BLOCK_PATTERN.finditer(source):
        if "data-grapesjs-overrides" in match.group(1):
            continue
        rules.extend(split_css_rules(match.group(2), match.start(2)))
    return rules


def selector_tokens(node: HtmlNode) -> set[str]:
    tokens = {node.tag}
    for item in node.attrs.get("class", "").split():
        if item:
            tokens.add(f".{item}")
    identity = node.attrs.get("id")
    if identity:
        tokens.add(f"#{identity}")
    # Attribute selectors, i.e. every identity attribute except `id`, which is
    # already covered by the `#` form above.
    for name in IDENTITY_ATTRIBUTES:
        if name != "id" and node.attrs.get(name):
            tokens.add(f"[{name}")
    return tokens


def related_css(parser: SourceHtmlParser, source: str, nodes: list[HtmlNode], rules: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rules whose selector mentions a class/id/tag carried by the selection.

    Deliberately a *superset* heuristic. Missing a rule would make the agent
    invent CSS that already exists; including one extra rule only costs a few
    tokens. Bare tag names are ignored unless the element has no class or id,
    because `p { }` matches almost everything.
    """
    wanted: set[str] = set()
    tag_only: set[str] = set()
    for node in nodes:
        tokens = selector_tokens(node)
        specific = {token for token in tokens if token.startswith((".", "#", "["))}
        if specific:
            wanted |= specific
        else:
            tag_only.add(node.tag)

    matched: list[dict[str, Any]] = []
    for rule in rules:
        selector = rule["selector"]
        if AT_RULE_PATTERN.match(selector):
            # Keep at-rules only when their body mentions a wanted token, so a
            # responsive override for the selection still travels with it.
            if not any(token in rule["text"] for token in wanted):
                continue
        elif not any(token in selector for token in wanted):
            bare = {part.strip() for part in re.split(r"[\s,>+~]+", selector) if part.strip()}
            if not (tag_only & bare):
                continue
        matched.append({
            "selector": selector,
            "lineStart": line_of(parser, rule["start"]),
            "lineEnd": line_of(parser, max(rule["start"], rule["end"] - 1)),
            "text": rule["text"] if len(rule["text"]) <= 600 else rule["text"][:600] + "\n  /* … */\n}",
        })
    return matched[:14]


def related_scripts(parser: SourceHtmlParser, source: str, nodes: list[HtmlNode]) -> list[dict[str, Any]]:
    """Script blocks that reference an identifier carried by the selection."""
    needles: set[str] = set()
    for node in nodes:
        for name in IDENTITY_ATTRIBUTES:
            value = node.attrs.get(name)
            if value:
                needles.add(value)
        for name in ("data-action", "data-target"):
            value = node.attrs.get(name)
            if value:
                needles.add(value)
        for item in node.attrs.get("class", "").split():
            if item:
                needles.add(item)
    if not needles:
        return []

    blocks: list[dict[str, Any]] = []
    for match in SCRIPT_BLOCK_PATTERN.finditer(source):
        code = match.group(2)
        if not code.strip():
            continue
        hits = sorted({needle for needle in needles if needle in code})
        if not hits:
            continue
        blocks.append({
            "lineStart": line_of(parser, match.start()),
            "lineEnd": line_of(parser, max(match.start(), match.end() - 1)),
            "matches": hits,
            "text": code.strip() if len(code.strip()) <= 2400 else code.strip()[:2400] + "\n/* … */",
        })
    return blocks[:3]


# ── Stable identity promotion ───────────────────────────────────────────────
#
# Most elements carry neither `id` nor `data-wb-id`, so their only anchor is a
# structural path — which dies the moment the agent rewrites that subtree. On
# selection the workbench therefore writes a readable `data-wb-id` into the
# source. This is not pollution: `data-wb-id` is already the project's own
# contract for addressing elements (see the editable-HTML guidelines), so
# promoting a selection moves the page *towards* the spec rather than away.

STOPWORD_SLUGS = {"the", "and", "for", "with", "you", "your", "our", "this", "that", "from", "are", "was"}


def slugify(value: str, fallback: str) -> str:
    ascii_value = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    words = [word for word in ascii_value.split("-") if word and word not in STOPWORD_SLUGS]
    slug = "-".join(words[:4])[:40].strip("-")
    return slug or fallback


def suggest_wb_id(node: HtmlNode, taken: set[str]) -> str:
    classes = [item for item in node.attrs.get("class", "").split() if item]
    seeds = [
        slugify(classes[0], "") if classes else "",
        slugify(node_text_seed(node), ""),
        node.tag,
    ]
    base = next((seed for seed in seeds if seed), node.tag)
    if not base.startswith(node.tag) and base != node.tag:
        base = f"{base}"
    candidate = base
    counter = 2
    while candidate in taken:
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def node_text_seed(node: HtmlNode) -> str:
    for name in ("aria-label", "alt", "title", "name", "data-action"):
        value = node.attrs.get(name)
        if value:
            return value
    return ""


def existing_wb_ids(parser: SourceHtmlParser) -> set[str]:
    taken: set[str] = set()
    for node in parser.nodes:
        for name in ("id", "data-wb-id"):
            value = node.attrs.get(name)
            if value:
                taken.add(value)
    return taken


def promote_identities(target: Path, descriptors: list[dict[str, Any]], base_revision: str) -> dict[str, Any]:
    """Give every anchorless selection a durable `data-wb-id`, atomically."""
    current = read_document(target)
    if base_revision and current["revision"] != base_revision:
        raise WorkbenchError("REVISION_CONFLICT", "磁盘文件已被外部修改，请重新加载后再试。", 409, document=current)

    source = current["html"]
    parser, body = parse_document_tree(source)
    taken = existing_wb_ids(parser)
    insertions: list[tuple[int, str]] = []
    assigned: list[dict[str, Any]] = []

    for descriptor in descriptors:
        node = resolve_anchor(parser, body, descriptor)
        identity = identity_of(node)
        if identity is not None:
            assigned.append({"identity": identity, "created": False})
            continue
        value = suggest_wb_id(node, taken)
        taken.add(value)
        # Insert just before the '>' that closes the start tag. Self-closing
        # tags keep their slash, so target the last character of the raw tag.
        raw = source[node.start : node.start_end]
        offset = node.start + len(raw.rstrip()[:-1].rstrip("/").rstrip()) if raw.endswith(">") else node.start_end - 1
        insertions.append((offset, f' data-wb-id="{html.escape(value, quote=True)}"'))
        assigned.append({"identity": {"name": "data-wb-id", "value": value}, "created": True})

    if not insertions:
        return {"revision": current["revision"], "assigned": assigned, "changed": False}

    updated = source
    for offset, text in sorted(insertions, key=lambda item: item[0], reverse=True):
        updated = updated[:offset] + text + updated[offset:]

    latest = read_document(target)
    if latest["revision"] != current["revision"]:
        raise WorkbenchError("REVISION_CONFLICT", "写入期间文件发生外部修改，未覆盖最新版。", 409, document=latest)
    write_atomic(target, updated)
    return {"revision": revision_of(updated), "assigned": assigned, "changed": True}


def write_atomic(target: Path, content: str) -> None:
    temporary_name: Path | None = None
    try:
        descriptor, temporary_name = make_temp_file(target.parent, prefix=f".{target.name}.workbench-", suffix=".tmp")
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_name, target.stat().st_mode)
        os.replace(temporary_name, target)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)


# ── Context packet ──────────────────────────────────────────────────────────


def build_selection_context(target: Path, descriptors: list[dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(descriptors, list) or not descriptors:
        raise WorkbenchError("INVALID_ANCHOR", "请至少选择一个元素。", 400)
    if len(descriptors) > MAX_CONTEXT_SELECTIONS:
        raise WorkbenchError("INVALID_ANCHOR", f"一次最多添加 {MAX_CONTEXT_SELECTIONS} 个元素。", 400)

    document = read_document(target)
    source = document["html"]
    parser, body = parse_document_tree(source)

    nodes = [resolve_anchor(parser, body, descriptor) for descriptor in descriptors]
    # Drop selections already contained in another selection: sending both a
    # section and its heading duplicates the source and blurs the instruction.
    kept: list[HtmlNode] = []
    for node in nodes:
        if any(node is not other and node.is_inside(other) for other in nodes):
            continue
        if any(node is other for other in kept):
            continue
        kept.append(node)

    selections = [describe_anchor(parser, body, node) for node in kept]
    rules = document_css_rules(source)
    payload = {
        "filePath": document["filePath"],
        "fileName": document["fileName"],
        "revision": document["revision"],
        "selections": selections,
        "css": related_css(parser, source, kept, rules),
        "scripts": related_scripts(parser, source, kept),
        "collapsed": len(nodes) - len(kept),
    }
    payload["markdown"] = render_context_markdown(payload)
    return payload


def render_context_markdown(payload: dict[str, Any]) -> str:
    """Render the packet the agent actually reads.

    Optimised for an agent that cannot see the page: every selection leads with
    how to find it again (anchor + line range) and only then describes what it
    is. The literal source snippet is included so a string-replacing edit tool
    has an exact `old_string` to match.
    """
    lines: list[str] = []
    lines.append("## 视觉选区（HTML Workbench）")
    lines.append("")
    lines.append(f"- 文件：`{payload['filePath']}`")
    lines.append(f"- revision：`{payload['revision'][:12]}`")
    lines.append(f"- 选中元素：{len(payload['selections'])} 个（编辑态框选）")
    lines.append("")
    lines.append("用户在页面上直接选中了下列元素。后续指令中的「这个 / 这里 / 这块」均指这些元素。")
    lines.append("")

    for index, item in enumerate(payload["selections"], start=1):
        marker = f"### {index}. `{item['selector']}`"
        lines.append(marker)
        lines.append("")
        identity = item.get("identity")
        if identity:
            lines.append(f"- 稳定锚点：`[{identity['name']}=\"{identity['value']}\"]`")
        else:
            lines.append("- 稳定锚点：无（该元素没有 id / data-wb-id）")
        lines.append(f"- 源码位置：第 {item['lineStart']}–{item['lineEnd']} 行")
        if item["ancestors"]:
            lines.append(f"- 层级：`{' > '.join(item['ancestors'][-4:])} > {item['selector']}`")
        if item["text"]:
            lines.append(f"- 可见文本：{item['text']}")
        if item["behavior"]:
            behavior = " ".join(f'{name}="{value}"' for name, value in item["behavior"].items())
            lines.append(f"- 行为属性：`{behavior}`")
        lines.append("")
        lines.append("```html")
        lines.append(item["snippet"])
        lines.append("```")
        lines.append("")

    if payload["css"]:
        lines.append("### 关联样式规则")
        lines.append("")
        for rule in payload["css"]:
            lines.append(f"`{rule['selector']}` — 第 {rule['lineStart']}–{rule['lineEnd']} 行")
            lines.append("")
            lines.append("```css")
            lines.append(rule["text"])
            lines.append("```")
            lines.append("")

    if payload["scripts"]:
        lines.append("### 关联脚本")
        lines.append("")
        for block in payload["scripts"]:
            hits = "、".join(f"`{item}`" for item in block["matches"][:6])
            lines.append(f"第 {block['lineStart']}–{block['lineEnd']} 行，引用了 {hits}")
            lines.append("")
            lines.append("```js")
            lines.append(block["text"])
            lines.append("```")
            lines.append("")

    lines.append("### 修改约束")
    lines.append("")
    lines.append("- 只修改上述选区及其关联样式 / 脚本区间，页面其余部分保持不变。")
    lines.append("- 优先用稳定锚点定位；不要依赖 `nth-child`、兄弟顺序或行号硬编码。")
    lines.append("- 编辑前请重新读取该文件：用户可能在此期间继续做了可视化修改。")
    lines.append("")

    markdown = "\n".join(lines)
    if len(markdown.encode("utf-8")) > MAX_CONTEXT_BYTES:
        encoded = markdown.encode("utf-8")[:MAX_CONTEXT_BYTES]
        markdown = encoded.decode("utf-8", "ignore") + "\n\n<!-- 上下文过长，已截断 -->\n"
    return markdown





def normalize_file_reference(raw_file: str) -> str:
    """Turn a browser `file://` URL into the platform's local path string.

    The address bar accepts both a normal filesystem path and a URL copied from
    Finder/Explorer/browser. `Path('file:///…%E4…')` is not a URL parser: it
    keeps the scheme and percent escapes literally, which made a valid existing
    file look missing. Decode it here, at the service boundary shared by every
    API and CLI command.
    """
    value = raw_file.strip()
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme.lower() != "file":
        return value
    if parsed.query or parsed.fragment:
        raise WorkbenchError("INVALID_FILE_URL", "file:// 地址不能包含 query 或 hash。", 400)

    host = parsed.netloc.lower()
    path = urllib.parse.unquote(parsed.path)
    if host not in {"", "localhost"}:
        if os.name != "nt":
            raise WorkbenchError("INVALID_FILE_URL", "当前系统只支持本机 file:// 地址。", 400)
        # file://server/share/page.html → \\server\share\page.html on Windows.
        path = f"//{parsed.netloc}{path}"
    elif os.name == "nt" and re.match(r"^/[A-Za-z]:/", path):
        # URL syntax requires a leading slash before a Windows drive: file:///C:/…
        path = path[1:]

    if not path:
        raise WorkbenchError("INVALID_FILE_URL", "file:// 地址未包含文件路径。", 400)
    return path


def resolve_html_file(raw_file: str) -> Path:
    if not raw_file.strip():
        raise WorkbenchError("FILE_REQUIRED", "请通过 file 参数指定 HTML 文件。", 400)
    normalized = normalize_file_reference(raw_file)
    requested = Path(normalized).expanduser()
    try:
        target = requested.resolve(strict=True)
    except FileNotFoundError as caught:
        raise WorkbenchError("FILE_NOT_FOUND", f"找不到文件：{requested.resolve()}", 404) from caught
    if target.suffix.lower() != ".html":
        raise WorkbenchError("INVALID_DOCUMENT", "只支持本地 .html 文件。", 400)
    return target


def encode_asset_token(target: Path) -> str:
    return base64.urlsafe_b64encode(str(target).encode("utf-8")).decode("ascii").rstrip("=")


def decode_asset_token(token: str) -> str:
    padding = "=" * (-len(token) % 4)
    try:
        return base64.urlsafe_b64decode(token + padding).decode("utf-8")
    except (ValueError, UnicodeDecodeError) as caught:
        raise WorkbenchError("INVALID_ASSET", "资源地址无效。", 400) from caught


def read_document(target: Path) -> dict[str, Any]:
    try:
        source = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as caught:
        raise WorkbenchError("INVALID_DOCUMENT", "HTML 文件必须使用 UTF-8 编码。", 400) from caught
    parsed = parse_source(source)
    stat = target.stat()
    return {
        **parsed,
        "html": source,
        "revision": revision_of(source),
        "mtimeMs": stat.st_mtime * 1000,
        "filePath": str(target),
        "fileName": target.name,
        "assetBase": f"/assets/{encode_asset_token(target)}/",
    }


def save_document(target: Path, body: dict[str, Any]) -> dict[str, Any]:
    base_revision = body.get("baseRevision")
    body_html = body.get("bodyHtml")
    css = body.get("css")
    if not isinstance(base_revision, str) or not isinstance(body_html, str) or not isinstance(css, str):
        raise WorkbenchError("INVALID_SAVE", "保存请求必须包含 baseRevision、bodyHtml 和 css。", 400)
    if len(body_html) > 6_000_000 or len(css) > 1_000_000:
        raise WorkbenchError("INVALID_SAVE", "保存内容超过大小限制。", 400)
    if re.search(r"<(?:html|head|body)\b", body_html, re.IGNORECASE) or re.search(r"<script\b", body_html, re.IGNORECASE):
        raise WorkbenchError("INVALID_SAVE", "bodyHtml 不允许包含 html、head、body 或 script。", 400)

    current = read_document(target)
    if current["revision"] != base_revision:
        raise WorkbenchError("REVISION_CONFLICT", "磁盘文件已被外部修改，未覆盖最新版。", 409, document=current)

    source = current["html"]
    body_html = restore_inline_event_attributes(body_html, current["bodyHtml"])
    locations = current["locations"]
    override = f"<style data-grapesjs-overrides>\n{css}\n</style>\n"
    if locations["overrideStart"] is not None:
        source = source[: locations["overrideStart"]] + override + source[locations["overrideEnd"] :]
    else:
        source = source[: locations["headEnd"]] + override + source[locations["headEnd"] :]

    refreshed = parse_source(source)
    scripts = body.get("bodyScripts")
    if isinstance(scripts, list) and all(isinstance(item, str) and SCRIPT_PATTERN.match(item.strip()) for item in scripts):
        preserved_scripts = "\n".join(scripts)
    else:
        preserved_scripts = "\n".join(current["bodyScripts"])
    next_body = f"{body_html}\n{preserved_scripts}" if preserved_scripts else body_html
    body_start = refreshed["locations"]["bodyStart"]
    body_end = refreshed["locations"]["bodyEnd"]
    source = source[:body_start] + "\n" + next_body + "\n" + source[body_end:]

    latest = read_document(target)
    if latest["revision"] != base_revision:
        raise WorkbenchError("REVISION_CONFLICT", "保存期间文件发生外部修改，未覆盖最新版。", 409, document=latest)

    descriptor, temporary_name = make_temp_file(target.parent, prefix=f".{target.name}.workbench-", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as output:
            output.write(source)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary_name, target.stat().st_mode)
        os.replace(temporary_name, target)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    return read_document(target)


class WorkbenchServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        asset_file: Path,
        editor_root: Path,
        vendor_files: dict[str, Path],
        log_dir: Path | None = None,
        vendor_cache: Path | None = None,
        log_file: Path | None = None,
    ) -> None:
        self.asset_file = asset_file.resolve(strict=True)
        self.editor_root = editor_root.resolve(strict=True)
        self.vendor_files = {name: path.resolve(strict=True) for name, path in vendor_files.items()}
        self.vendor_routes = {str(metadata["route"]): name for name, metadata in VENDOR_ASSETS.items()}
        # Advertised by /api/health so the host can report the directories actually
        # in use — including when it REUSES a service it did not start and has no
        # startup output to read them from.
        self.log_dir = Path(log_dir) if log_dir is not None else None
        self.vendor_cache = Path(vendor_cache) if vendor_cache is not None else None
        self.log_file = log_file
        super().__init__(address, WorkbenchHandler)


class WorkbenchHandler(BaseHTTPRequestHandler):
    server: WorkbenchServer
    protocol_version = "HTTP/1.1"

    def handle_one_request(self) -> None:
        self.request_id = secrets.token_hex(6)
        self.request_started = time.monotonic()
        self.error_code = None
        self.file_ref = "-"
        super().handle_one_request()

    def parse_request(self) -> bool:
        # The connection may sit idle before its next request line arrives.
        self.request_started = time.monotonic()
        return super().parse_request()

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:
        route = getattr(self, "path", "").partition("?")[0]
        if route == "/api/health" and code == 200:
            return
        if route.startswith("/assets/"):
            route = "/assets/*"
        elif route not in {"/", "/api/health", "/api/document", "/api/events", "/api/context", "/api/anchor", "/api/shutdown"}:
            route = route if route in self.server.vendor_routes else "other"
        status = int(code) if str(code).isdigit() else 0
        level = logging.ERROR if status >= 500 else logging.WARNING if status >= 400 else logging.INFO
        method = self.command if self.command in {"GET", "PUT", "POST", "HEAD", "OPTIONS"} else "other"
        get_logger().log(level, "http_request id=%s method=%s route=%s status=%s elapsed_ms=%.1f code=%s file_ref=%s",
                         self.request_id, method, route, code,
                         (time.monotonic() - self.request_started) * 1000, self.error_code or "-", self.file_ref)

    def log_error(self, format_string: str, *args: Any) -> None:
        # Base HTTP errors also pass through log_request. Skip the raw message,
        # which can contain user-controlled request text.
        if format_string.startswith("Request timed out"):
            get_logger().warning("http_timeout id=%s", self.request_id)

    def end_headers(self) -> None:
        self.send_header("X-Workbench-Request-Id", self.request_id)
        super().end_headers()

    def send_bytes(self, status: int, content: bytes, content_type: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if cache == "no-store":
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        else:
            self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        if status >= 400:
            self.error_code = payload.get("error")
        content = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_bytes(status, content, "application/json; charset=utf-8")

    def send_error_payload(self, caught: Exception) -> None:
        if isinstance(caught, WorkbenchError):
            get_logger().warning("request_failed id=%s code=%s reason=%s", self.request_id, caught.code, caught)
            self.send_json(caught.status, {"error": caught.code, "message": str(caught), **caught.extra})
        else:
            get_logger().exception("request_failed id=%s code=SERVER_ERROR", self.request_id)
            self.send_json(500, {"error": "SERVER_ERROR", "message": str(caught)})

    def query_file(self, query: dict[str, list[str]]) -> Path:
        raw = query.get("file", [""])[0]
        self.file_ref = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]
        return resolve_html_file(raw)

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/health":
                payload: dict[str, Any] = {
                    "ok": True,
                    "service": SERVICE_NAME,
                    "version": SERVICE_VERSION,
                    "pythonVersion": ".".join(map(str, sys.version_info[:3])),
                    "pythonExecutable": sys.executable,
                    "platform": sys.platform,
                    "pid": os.getpid(),
                    "logging": logging_status(),
                    "port": self.server.server_port,
                    "editorRoot": str(self.server.editor_root),
                    "capabilities": list(SERVICE_CAPABILITIES),
                }
                # Report where this process really writes. The host shows these in
                # its diagnostics, so a REUSED service describes its own
                # directories instead of the ones the caller asked for — which may
                # be exactly what the sandbox refused.
                if self.server.log_dir is not None:
                    payload["logDir"] = str(self.server.log_dir)
                    payload["logFile"] = str(self.server.log_file) if self.server.log_file is not None else None
                if self.server.vendor_cache is not None:
                    payload["vendorCache"] = str(self.server.vendor_cache)
                self.send_json(200, payload)
                return
            if parsed.path == "/api/document":
                self.send_json(200, read_document(self.query_file(query)))
                return
            if parsed.path == "/api/events":
                self.stream_events(self.query_file(query))
                return
            if parsed.path.startswith("/assets/"):
                self.send_asset(parsed.path)
                return
            if parsed.path in self.server.vendor_routes:
                name = self.server.vendor_routes[parsed.path]
                metadata = VENDOR_ASSETS[name]
                self.send_bytes(200, self.server.vendor_files[name].read_bytes(), str(metadata["content_type"]), "public, max-age=31536000, immutable")
                return
            self.send_bytes(200, self.server.asset_file.read_bytes(), "text/html; charset=utf-8")
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as caught:
            self.send_error_payload(caught)

    def do_PUT(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path != "/api/document":
                self.send_json(404, {"error": "NOT_FOUND", "message": "接口不存在。"})
                return
            body = self.read_json_body()
            query = urllib.parse.parse_qs(parsed.query)
            self.send_json(200, save_document(self.query_file(query), body))
        except (BrokenPipeError, ConnectionResetError):
            return
        except json.JSONDecodeError as caught:
            self.send_error_payload(WorkbenchError("INVALID_SAVE", f"保存请求不是有效 JSON：{caught}", 400))
        except Exception as caught:
            self.send_error_payload(caught)

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path == "/api/shutdown":
                # Lets a newer `open` retire this process cleanly. The service
                # holds no state of its own, so exiting is always safe.
                self.send_json(200, {"ok": True, "stopping": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return
            if parsed.path not in {"/api/context", "/api/anchor"}:
                self.send_json(404, {"error": "NOT_FOUND", "message": "接口不存在。"})
                return
            body = self.read_json_body()
            target = self.query_file(query)
            selections = body.get("selections")
            if parsed.path == "/api/anchor":
                # Identity promotion mutates the file, so it is a separate,
                # explicitly revision-checked step ahead of context building.
                if not isinstance(selections, list) or not selections:
                    raise WorkbenchError("INVALID_ANCHOR", "请至少选择一个元素。", 400)
                if len(selections) > MAX_CONTEXT_SELECTIONS:
                    raise WorkbenchError("INVALID_ANCHOR", f"一次最多添加 {MAX_CONTEXT_SELECTIONS} 个元素。", 400)
                self.send_json(200, promote_identities(target, selections, str(body.get("baseRevision") or "")))
                return
            self.send_json(200, build_selection_context(target, selections))
        except (BrokenPipeError, ConnectionResetError):
            return
        except json.JSONDecodeError as caught:
            self.send_error_payload(WorkbenchError("INVALID_ANCHOR", f"请求不是有效 JSON：{caught}", 400))
        except Exception as caught:
            self.send_error_payload(caught)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_REQUEST_BYTES:
            raise WorkbenchError("INVALID_SAVE", "请求大小无效。", 400)
        payload = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise WorkbenchError("INVALID_SAVE", "请求体必须是 JSON 对象。", 400)
        return payload

    def send_asset(self, route: str) -> None:
        parts = route.split("/", 3)
        if len(parts) < 4:
            raise WorkbenchError("INVALID_ASSET", "资源地址无效。", 400)
        token = parts[2]
        source_file = resolve_html_file(decode_asset_token(token))
        relative = urllib.parse.unquote(parts[3])
        resource = (source_file.parent / relative).resolve(strict=True)
        content_type = mimetypes.guess_type(resource.name)[0] or "application/octet-stream"
        self.send_bytes(200, resource.read_bytes(), content_type, "private, max-age=60")

    def stream_events(self, target: Path) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_revision = ""
        missing = False
        while True:
            try:
                document = read_document(target)
                missing = False
                if document["revision"] != last_revision:
                    last_revision = document["revision"]
                    payload = json.dumps({"revision": last_revision, "mtimeMs": document["mtimeMs"]}, separators=(",", ":"))
                    self.wfile.write(f"data: {payload}\n\n".encode("utf-8"))
                    self.wfile.flush()
            except FileNotFoundError:
                if not missing:
                    get_logger().warning("file_watch_missing id=%s code=FILE_NOT_FOUND", self.request_id)
                    missing = True
                self.wfile.write(b'event: error\ndata: {"error":"FILE_NOT_FOUND"}\n\n')
                self.wfile.flush()
            time.sleep(0.5)


def default_asset_file(script_file: Path) -> Path:
    packaged = script_file.parent.parent / "assets" / "workbench.html"
    if packaged.is_file():
        return packaged
    raise WorkbenchError("ASSET_NOT_FOUND", f"找不到前端资源：{packaged}", 500)


def health(port: int, timeout: float = 0.5, failures: list[str] | None = None) -> dict[str, Any] | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as response:
            content = response.read(64 * 1024 + 1)
        if len(content) > 64 * 1024:
            raise ValueError("health response exceeds 64 KiB")
        payload = json.loads(content.decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("service") != SERVICE_NAME:
            raise ValueError("port responded with a different service identity")
        return payload
    except (OSError, ValueError, urllib.error.URLError) as caught:
        if failures is not None:
            failures.append(type(caught).__name__ + ": " + str(caught)[:1000])
        return None


def is_reusable(payload: dict[str, Any] | None) -> bool:
    """Whether a live service speaks the same API as this script.

    A process serves the code it was started with, but serves assets from disk.
    So an old process + new assets is the worst combination: the UI offers
    features whose routes answer 501. Require every capability this script
    advertises before reusing.
    """
    if not payload:
        return False
    advertised = payload.get("capabilities")
    if not isinstance(advertised, list):
        return False
    return set(SERVICE_CAPABILITIES).issubset({str(item) for item in advertised})


def stop_service(port: int, timeout: float = 6.0) -> bool:
    """Ask an outdated service to exit, then free its TCP listener.

    Before 2.1.0 there was no shutdown route. Also, a failed/foreign listener
    can hold the port without answering health: a health failure is *not* proof
    that binding will succeed. We therefore wait for the actual listener to go
    away, and use the native process terminator on each platform as a fallback.
    """
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown", method="POST")
        urllib.request.urlopen(request, timeout=timeout).close()
    except (OSError, ValueError, urllib.error.URLError):
        pass
    if wait_for_port_free(port, 2.0):
        return True
    for pid in listeners_on_port(port):
        terminate_process(pid)
    return wait_for_port_free(port, timeout)


def wait_for_port_free(port: int, timeout: float) -> bool:
    """Wait until no process is listening, including unhealthy listeners."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not listeners_on_port(port):
            return True
        time.sleep(0.1)
    return not listeners_on_port(port)


def listeners_on_port(port: int) -> list[int]:
    """Return PIDs listening on a local TCP port, best-effort on every OS.

    macOS/Linux use lsof. Windows ships `netstat` and exposes the PID in its
    final column, avoiding an optional Python dependency such as psutil.
    """
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True, text=True, timeout=5,
            )
            pids = []
            for line in result.stdout.splitlines():
                columns = line.split()
                # TCP  127.0.0.1:4317  0.0.0.0:0  LISTENING  1234
                if len(columns) < 5 or columns[0].upper() != "TCP" or columns[3].upper() != "LISTENING":
                    continue
                local = columns[1].rsplit(":", 1)
                if len(local) != 2 or local[1] != str(port):
                    continue
                try:
                    pid = int(columns[-1])
                except ValueError:
                    continue
                if pid != os.getpid():
                    pids.append(pid)
            return pids
        result = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pids = []
    for line in result.stdout.split():
        try:
            pid = int(line)
        except ValueError:
            continue
        if pid != os.getpid():
            pids.append(pid)
    return pids


def terminate_process(pid: int) -> None:
    """Best-effort process-tree termination on the current platform."""
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True, text=True, timeout=5,
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        pass


def start_detached(script_file: Path, port: int, editor_root: Path, asset_file: Path | None, vendor_cache: Path, log_dir: Path) -> tuple[int, Path | None]:
    """Spawn a detached `serve` and return (pid, path of its captured output).

    The path is None when no candidate directory accepted the file: a service
    whose console output cannot be captured must still start, so the output is
    discarded rather than the spawn abandoned (see `setup_logging`).
    """
    directory = pick_writable_dir(*log_candidates(log_dir))
    log_file: Path | None = directory / f"html-workbench-{port}.log"
    command = [sys.executable, str(script_file), "serve", "--bounded-output", "--port", str(port), "--editor-root", str(editor_root), "--vendor-cache", str(vendor_cache), "--log-dir", str(directory)]
    if asset_file is not None:
        command.extend(["--asset", str(asset_file)])
    flags = 0
    kwargs: dict[str, Any] = {"stdin": subprocess.DEVNULL, "start_new_session": os.name != "nt"}
    if os.name == "nt":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS  # type: ignore[attr-defined]
        kwargs["creationflags"] = flags
        kwargs.pop("start_new_session", None)
    try:
        if log_file.is_file():
            # Migrate historical unbounded output using a bounded tail read.
            with log_file.open("rb") as previous:
                previous.seek(max(0, os.fstat(previous.fileno()).st_size - BOOTSTRAP_MAX_BYTES))
                # A tail offset can bisect a multibyte character in old logs.
                tail = previous.read(BOOTSTRAP_MAX_BYTES).decode("utf-8", errors="replace")
                log_file.with_suffix(".log.1").write_bytes(bounded_utf8(tail, BOOTSTRAP_MAX_BYTES))
        log = log_file.open("wb")
    except OSError:
        log_file = None
        log = None
    try:
        process = subprocess.Popen(
            command,
            stdout=log if log is not None else subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            close_fds=True,
            **kwargs,
        )
    finally:
        if log is not None:
            log.close()
    return process.pid, log_file


def command_serve(args: argparse.Namespace, script_file: Path) -> int:
    logger, log_directory = setup_logging(args.log_dir, args.port)
    log_file = service_log_file(logger)
    logger.info("service_starting version=%s python=%s platform=%s port=%s executable=%s cwd=%s",
                SERVICE_VERSION, sys.version.split()[0], sys.platform, args.port, sys.executable, Path.cwd())
    asset_file = Path(args.asset).expanduser().resolve(strict=True) if args.asset else default_asset_file(script_file)
    editor_root = Path(args.editor_root).expanduser().resolve(strict=True)
    # Logs and cache are both disposable, so they follow the writable location the
    # sandbox really granted instead of the path the parent requested.
    failures: list[str] = []
    vendor_cache = pick_writable_dir(*vendor_candidates(args.vendor_cache, log_directory), failures=failures)
    for failure in failures:
        logger.warning("vendor_directory_rejected %s", failure)
    vendor_files = ensure_vendor_assets(vendor_cache)
    server = WorkbenchServer(("127.0.0.1", args.port), asset_file, editor_root, vendor_files, log_directory, vendor_cache, log_file)
    logger.info("service_ready port=%s editorRoot=%s logFile=%s vendorCache=%s", args.port, editor_root, log_file, vendor_cache)
    # The host surfaces these two paths in its diagnostics, so the panel shows the
    # directories actually in use rather than echoing the ones it asked for — the
    # requested ones may be exactly what the sandbox refused.
    print(json.dumps({
        "ok": True,
        "url": f"http://127.0.0.1:{args.port}",
        "editorRoot": str(editor_root),
        "logDir": str(log_directory),
        "logFile": str(log_file) if log_file is not None else None,
        "vendorCache": str(vendor_cache),
    }, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        logger.info("service_stopped port=%s", args.port)
    return 0


def command_open(args: argparse.Namespace, script_file: Path) -> int:
    target = Path(args.file).expanduser().resolve(strict=True)
    editor_root = Path(args.editor_root).expanduser().resolve(strict=True)
    resolve_html_file(str(target))
    existing = health(args.port)
    if existing is not None and not is_reusable(existing):
        # Same port, older code: retire it rather than serve a new UI against a
        # stale API. Nothing is lost — the service keeps no state of its own.
        stop_service(args.port)
        existing = health(args.port)
        if existing is not None:
            raise WorkbenchError(
                "SERVER_OUTDATED",
                f"端口 {args.port} 上有旧版服务且无法自动停止，请手动结束该进程后重试。",
                500,
            )
    reused = existing is not None
    pid: int | None = None
    log_file: Path | None = None
    if not reused:
        asset_file = Path(args.asset).expanduser().resolve(strict=True) if args.asset else None
        pid, log_file = start_detached(script_file, args.port, editor_root, asset_file, Path(args.vendor_cache).expanduser(), Path(args.log_dir).expanduser())
        deadline = time.monotonic() + args.wait
        while time.monotonic() < deadline:
            if health(args.port):
                break
            time.sleep(0.1)
        else:
            where = f"，请查看日志：{log_file}" if log_file is not None else "（没有可写的日志目录，输出已丢弃）"
            raise WorkbenchError("SERVER_UNAVAILABLE", f"服务启动失败{where}", 500)
    query = urllib.parse.urlencode({"file": str(target)})
    print(json.dumps({
        "ok": True,
        "url": f"http://127.0.0.1:{args.port}/?{query}",
        "reused": reused,
        **({"pid": pid} if pid else {}),
    }, ensure_ascii=False))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start and use the local HTML visual workbench.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    serve = subparsers.add_parser("serve", help="run the service in the foreground")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT)
    serve.add_argument("--editor-root", default=str(Path.home()))
    serve.add_argument("--asset", help="override the bundled workbench.html path")
    serve.add_argument("--vendor-cache", default=str(default_vendor_cache()), help="directory for verified GrapesJS files")
    serve.add_argument("--log-dir", default=str(default_log_dir()), help="directory for rotating service logs")
    serve.add_argument("--bounded-output", action="store_true", help=argparse.SUPPRESS)

    open_command = subparsers.add_parser("open", help="start or reuse the service and print an editor URL")
    open_command.add_argument("file")
    open_command.add_argument("--port", type=int, default=DEFAULT_PORT)
    open_command.add_argument("--editor-root", default=str(Path.home()))
    open_command.add_argument("--asset", help="override the bundled workbench.html path")
    open_command.add_argument("--vendor-cache", default=str(default_vendor_cache()), help="directory for verified GrapesJS files")
    open_command.add_argument("--log-dir", default=str(default_log_dir()), help="directory for rotating service logs")
    open_command.add_argument("--wait", type=float, default=8.0)

    health_command = subparsers.add_parser("health", help="check the local service")
    health_command.add_argument("--port", type=int, default=DEFAULT_PORT)

    stop_command = subparsers.add_parser("stop", help="retire whatever service holds the port")
    stop_command.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser


def command_stop(args: argparse.Namespace) -> int:
    """Free the port so a fresh service can bind it.

    Callers use this to recover from `PORT_IN_USE`, where the listener is a
    process they do not own (a leftover from an earlier run, or an outdated
    version). Succeeding when nothing is listening keeps it safe to call blindly.
    """
    if health(args.port) is None and not listeners_on_port(args.port):
        print(json.dumps({"ok": True, "port": args.port, "stopped": False, "reason": "NOTHING_LISTENING"}, ensure_ascii=False))
        return 0
    if stop_service(args.port):
        print(json.dumps({"ok": True, "port": args.port, "stopped": True}, ensure_ascii=False))
        return 0
    raise WorkbenchError("SERVER_OUTDATED", f"端口 {args.port} 上的进程无法停止，请手动结束后重试。", 500)


def service_log_file(logger: logging.Logger) -> Path | None:
    for handler in logger.handlers:
        if isinstance(handler, RotatingFileHandler):
            return Path(handler.baseFilename)
    return None


def logging_status() -> dict[str, Any]:
    for handler in get_logger().handlers:
        if isinstance(handler, BoundedRotatingFileHandler):
            return {
                "file": handler.baseFilename, "error": handler.last_error,
                "droppedRecords": handler.dropped_records,
                "maxBytes": LOG_MAX_BYTES, "backups": LOG_BACKUP_COUNT,
                "recordMaxBytes": LOG_RECORD_MAX_BYTES,
            }
    return {"file": None, "error": "file logging unavailable"}


def report_cli_error(command: str, code: str, caught: Exception, **details: Any) -> int:
    payload = {"ok": False, "error": code, "message": str(caught), **details}
    if command == "serve":
        logger = get_logger()
        log_file = service_log_file(logger)
        payload["logFile"] = str(log_file) if log_file is not None else None
        logger.exception("service_failed code=%s", code)
        if log_file is None or logging_status().get("error"):
            print(bounded_utf8(traceback.format_exc(), LOG_RECORD_MAX_BYTES).decode("utf-8"), file=sys.stderr)
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
    return 1


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    if sys.version_info < (3, 9):
        print(json.dumps({"ok": False, "error": "PYTHON_TOO_OLD", "message": "需要 Python 3.9 或更高版本。"}, ensure_ascii=False), file=sys.stderr)
        return 2
    args = build_parser().parse_args()
    if getattr(args, "bounded_output", False):
        sys.stdout = sys.stderr = BoundedOutput(sys.stdout.buffer)
    script_file = Path(__file__).resolve()
    try:
        if args.command == "serve":
            return command_serve(args, script_file)
        if args.command == "open":
            return command_open(args, script_file)
        if args.command == "stop":
            return command_stop(args)
        failures: list[str] = []
        payload = health(args.port, failures=failures)
        print(json.dumps(payload or {"ok": False, "error": "SERVER_UNAVAILABLE", "detail": failures}, ensure_ascii=False))
        return 0 if payload else 1
    except WorkbenchError as caught:
        return report_cli_error(args.command, caught.code, caught, **caught.extra)
    except FileNotFoundError as caught:
        return report_cli_error(args.command, "FILE_NOT_FOUND", caught)
    except OSError as caught:
        code = "PORT_IN_USE" if getattr(caught, "errno", None) in {48, 98, 10048} else "SERVER_UNAVAILABLE"
        return report_cli_error(args.command, code, caught)
    except Exception as caught:
        if args.command != "serve":
            raise
        return report_cli_error(args.command, "SERVER_ERROR", caught)


if __name__ == "__main__":
    raise SystemExit(main())
