#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Environment probe for the dsh-wiztree plugin (read-only, no arguments).

Prints one JSON object describing this interpreter and the third-party modules
the analysis scripts need:

    {"python": "3.12.14", "executable": "...", "sitePackages": "...",
     "modules": {"pandas": "3.0.1", "numpy": "2.3.5"},
     "missing": [], "error": null}

Exit status is 0 whenever the interpreter itself ran; `missing` carries the
verdict about pandas/numpy so the caller can report one actionable message.
"""

from __future__ import annotations

import json
import sys

MODULES = ("pandas", "numpy")

#: Distribution name -> import name when they differ.
DIST_NAMES = {"pandas": "pandas", "numpy": "numpy"}


def main() -> int:
    import importlib
    import site
    import traceback

    result: dict = {
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "sitePackages": None,
        "modules": {},
        "missing": [],
        "error": None,
    }
    try:
        result["sitePackages"] = site.getusersitepackages()
    except Exception as exc:  # pragma: no cover - defensive
        result["error"] = f"site.getusersitepackages failed: {exc}"

    for name in MODULES:
        try:
            module = importlib.import_module(name)
        except Exception as exc:
            result["missing"].append(name)
            result["modules"][name] = None
            if result["error"] is None:
                result["error"] = f"import {name} failed: {exc.__class__.__name__}: {exc}"
            if name == "pandas":
                result.setdefault("traceback", traceback.format_exc(limit=1).strip().splitlines()[-1])
        else:
            result["modules"][name] = getattr(module, "__version__", "unknown")

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
