#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""JSON wrapper around the WizTree analysis scripts used by the dsh-wiztree plugin.

Why this exists
---------------
`wiztree_snapshot_diff.py`, `wiztree_query.py` and `wiztree_verify_delete.py`
are human-facing command-line tools: they print prose and tables. A Harness tool
needs a machine-readable result, so this wrapper runs the *unmodified* script
through its own `main(argv)`, capturing stdout, and prints one JSON object as
the last line of stdout.

Nothing here re-implements the analysis: the three scripts stay the single
source of truth and are synced from the skill directory by
`tools/sync-scripts.mjs`.

Usage (the plugin passes exactly these)
---------------------------------------
    python wiztree_tool.py diff --json [--report FILE] [--min-mb N] OLD NEW
    python wiztree_tool.py query --json --csv FILE --path DIR [--recursive] ...
    python wiztree_tool.py verify --json [--top N] DIR [DIR ...]

Every mode answers on stdout:

    {"ok": true, "mode": "diff", "console": "...", ...}

and reports failure as `{"ok": false, "error": "..."}` with a non-zero exit
code, so the caller never has to parse a traceback.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _configure_stdio() -> None:
    """Force UTF-8 on our own streams (Windows consoles default to a legacy codepage)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


@contextlib.contextmanager
def _captured():
    """Capture the wrapped script's stdout so it never corrupts our JSON line."""
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        yield buffer


def _last_json(text: str):
    """Return the last complete JSON object printed into `text`, or None."""
    start = text.rfind("{")
    while start >= 0:
        try:
            return json.loads(text[start:])
        except ValueError:
            start = text.rfind("{", 0, start)
    return None


def _console_before_json(text: str) -> str:
    """Everything the wrapped script printed before its trailing JSON line."""
    start = text.rfind("{")
    while start >= 0:
        try:
            json.loads(text[start:])
            return text[:start].rstrip()
        except ValueError:
            start = text.rfind("{", 0, start)
    return text.rstrip()


def _emit(payload: dict, code: int = 0) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()
    return code


def _read_report(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def run_diff(args: argparse.Namespace) -> int:
    import wiztree_snapshot_diff as script

    report_path = args.report
    temporary = None
    if report_path is None:
        handle = tempfile.NamedTemporaryFile(prefix="wiztree-diff-", suffix=".md", delete=False)
        handle.close()
        report_path = temporary = handle.name

    argv = [args.old, args.new, "-o", report_path]
    if args.min_mb is not None:
        argv += ["--min-mb", str(args.min_mb)]
    if args.top is not None:
        argv += ["--top", str(args.top)]
    if args.depth is not None:
        argv += ["--depth", str(args.depth)]
    if args.root:
        argv += ["--root", args.root]
    if args.subtree:
        argv += ["--subtree", args.subtree]
    if args.dump_csv:
        argv += ["--dump-csv", args.dump_csv]

    with _captured() as out:
        code = script.main(argv)
    console = out.getvalue().rstrip()
    report = _read_report(report_path)
    if temporary is not None:
        with contextlib.suppress(OSError):
            os.unlink(temporary)

    return _emit(
        {
            "ok": code == 0,
            "mode": "diff",
            "code": code,
            "console": console,
            "report": report,
            "reportWritten": None if temporary is not None else os.path.abspath(report_path),
            "old": os.path.abspath(args.old),
            "new": os.path.abspath(args.new),
            "dumpCsv": os.path.abspath(args.dump_csv) if args.dump_csv else None,
        },
        code,
    )


def run_query(args: argparse.Namespace) -> int:
    import wiztree_query as script

    argv = [args.csv, "--path", args.path, "--rows"]
    if args.recursive:
        argv.append("--recursive")
    if args.min_mb is not None:
        argv += ["--min-mb", str(args.min_mb)]
    if args.top is not None:
        argv += ["--top", str(args.top)]
    if args.versions:
        argv.append("--versions")
    if args.stale_days is not None:
        argv += ["--stale-days", str(args.stale_days)]

    with _captured() as out:
        code = script.main(argv)
    captured = out.getvalue()
    payload = _last_json(captured)
    console = _console_before_json(captured)

    if payload is None:
        return _emit(
            {"ok": False, "mode": "query", "error": "the query script produced no JSON result",
             "console": console},
            1,
        )
    payload["console"] = console
    payload["mode"] = "query"
    payload["ok"] = True
    if args.dump_csv:
        payload["dumpCsvRequested"] = os.path.abspath(args.dump_csv)
    return _emit(payload, code)


def run_verify(args: argparse.Namespace) -> int:
    import wiztree_verify_delete as script

    argv = list(args.paths) + ["--json"]
    if args.top is not None:
        argv += ["--top", str(args.top)]
    if args.quiet:
        argv.append("--quiet")

    with _captured() as out:
        code = script.main(argv)
    captured = out.getvalue()
    payload = _last_json(captured)
    console = _console_before_json(captured)

    if payload is None:
        return _emit(
            {"ok": False, "mode": "verify", "error": "the verify script produced no JSON result",
             "console": console},
            1,
        )
    payload["console"] = console
    payload["mode"] = "verify"
    return _emit(payload, code)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="JSON wrapper for the WizTree analysis scripts")
    sub = parser.add_subparsers(dest="mode", required=True)

    diff = sub.add_parser("diff", help="compare two WizTree snapshots")
    diff.add_argument("--report", default=None, help="where to write the Markdown report")
    diff.add_argument("--min-mb", dest="min_mb", type=float, default=None)
    diff.add_argument("--top", type=int, default=None)
    diff.add_argument("--depth", type=int, default=None)
    diff.add_argument("--root", default="")
    diff.add_argument("--subtree", default="")
    diff.add_argument("--dump-csv", dest="dump_csv", default="")
    diff.add_argument("old")
    diff.add_argument("new")
    diff.set_defaults(handler=run_diff)

    query = sub.add_parser("query", help="inspect one folder inside a snapshot")
    query.add_argument("--csv", required=True)
    query.add_argument("--path", required=True)
    query.add_argument("--recursive", action="store_true")
    query.add_argument("--min-mb", dest="min_mb", type=float, default=None)
    query.add_argument("--top", type=int, default=None)
    query.add_argument("--versions", action="store_true")
    query.add_argument("--stale-days", dest="stale_days", type=int, default=None)
    query.add_argument("--dump-csv", dest="dump_csv", default="")
    query.set_defaults(handler=run_query)

    verify = sub.add_parser("verify", help="read-only content check of candidate folders")
    verify.add_argument("paths", nargs="+")
    verify.add_argument("--top", type=int, default=None)
    verify.add_argument("--quiet", action="store_true")
    verify.set_defaults(handler=run_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    _configure_stdio()
    raw = list(sys.argv[1:] if argv is None else argv)
    # `--json` is a wrapper-level flag: the wrapped scripts reject unknown
    # arguments, so pull it out before delegating.
    if "--json" in raw:
        raw.remove("--json")
    parser = build_parser()
    args = parser.parse_args(raw)
    try:
        return int(args.handler(args))
    except SystemExit as exc:  # a wrapped script called sys.exit()
        code = exc.code if isinstance(exc.code, int) else 1
        return _emit({"ok": False, "mode": args.mode, "error": f"the analysis script exited with code {code}"}, code)
    except Exception as exc:  # noqa: BLE001 - the caller needs one JSON error, not a traceback
        import traceback

        return _emit(
            {
                "ok": False,
                "mode": args.mode,
                "error": f"{exc.__class__.__name__}: {exc}",
                "traceback": traceback.format_exc(limit=6),
            },
            1,
        )


if __name__ == "__main__":
    sys.exit(main())
