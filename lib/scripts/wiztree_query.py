#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wiztree_query.py — 从 WizTree 快照 CSV 里查询某个文件夹的明细，**不扫描 C 盘**。

用途：当你想知道“某个大文件夹里到底是什么占地方”“哪些是旧版本残留可以删”时，
直接从最新快照里查，比重新扫盘快几个数量级，也不会有任何磁盘 I/O 压力。

注意：如果导出的是**仅文件夹**的 CSV（所有行的路径都以 `\\` 结尾），
那么最小的粒度就是文件夹，查不到文件名；此时用 `文件`/`文件夹` 列的数字判断规模。

用法
----
    # 列出某文件夹的直属子目录，按大小排序
    python wiztree_query.py NEW.csv --path 'C:\\Users\\ASUS\\AppData\\Local\\Temp' --top 30

    # 递归列出该文件夹下所有 >100MB 的子目录
    python wiztree_query.py NEW.csv --path 'C:\\Users\\ASUS' --recursive --min-mb 100

    # 找“旧版本残留”：同一父目录下名字里带版本号、且体积较大的项
    python wiztree_query.py NEW.csv --path '...\\kingsoft\\wps\\addons\\pool' --versions

    # 找长期未修改的文件夹（判断是否废弃）
    python wiztree_query.py NEW.csv --path 'C:\\Users\\ASUS\\AppData' --stale-days 180
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
from datetime import datetime

import pandas as pd

MB = 1024 * 1024
GB = 1024 * 1024 * 1024


def sniff_encoding(path: str) -> str:
    with open(path, "rb") as fh:
        if fh.read(3) == b"\xef\xbb\xbf":
            return "utf-8-sig"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            fh.read(1 << 20)
        return "utf-8"
    except UnicodeDecodeError:
        return "gbk"


def human(n: float) -> str:
    n = float(n)
    s = "-" if n < 0 else ""
    a = abs(n)
    if a >= GB:
        return f"{s}{a / GB:.2f} GB"
    if a >= MB:
        return f"{s}{a / MB:.2f} MB"
    if a >= 1024:
        return f"{s}{a / 1024:.1f} KB"
    return f"{s}{int(a)} B"


def load(path: str) -> pd.DataFrame:
    enc = sniff_encoding(path)
    with open(path, "r", encoding=enc, newline="") as fh:
        fh.readline()
        cols = [c.strip().lstrip("\ufeff") for c in next(csv.reader(io.StringIO(fh.readline())))]
    raw = pd.read_csv(path, encoding=enc, skiprows=1, dtype=str,
                      keep_default_na=False, low_memory=False, engine="c")
    raw.columns = [str(c).strip().lstrip("\ufeff") for c in raw.columns]

    pcol = next((c for c in ("文件名称", "Name", "Path") if c in cols), None)
    scol = next((c for c in ("大小", "Size") if c in cols), None)
    if pcol is None or scol is None:
        raise SystemExit(f"[错误] 表头无法识别: {cols}")

    d = pd.DataFrame()
    d["raw_path"] = raw[pcol].astype(str).str.strip()
    d = d[d["raw_path"].str.len() > 0].copy()
    # 重新编号索引：下面用 `.loc[idx, ...]` 从 raw 取对齐的行，
    # 索引若是 CSV 原始行号，pandas 3 会因为标签对不上而报错。
    d = d.reset_index(drop=True)
    idx = d.index
    d["key"] = d["raw_path"].str.lower().str.rstrip("\\")
    d["is_dir"] = d["raw_path"].str.endswith("\\")
    d["size"] = pd.to_numeric(raw.loc[idx, scol], errors="coerce").fillna(0).astype("int64")
    for logical, aliases in (("files", ("文件", "Files")), ("folders", ("文件夹", "Folders")),
                             ("mtime", ("修改时间", "Modified")), ("attrs", ("属性", "Attributes"))):
        col = next((c for c in aliases if c in cols), None)
        d[logical] = raw.loc[idx, col].astype(str) if col else ""
    d["parent"] = d["key"].map(lambda k: k.rsplit("\\", 1)[0] if "\\" in k else "")
    return d.reset_index(drop=True)


VER_RE = re.compile(r"[_\-.]?(\d+\.\d+(?:\.\d+)*)")


def select(csv: str, path: str, recursive: bool = False, min_mb: float = 0.0,
           stale_days: int = 0, top: int = 40, versions: bool = False) -> dict:
    """
    纯查询入口：返回结构化结果，不打印任何东西（供工具/JSON 模式复用）。

    返回 {"meta": {...}, "rows": [...], "total": int, "matched": int, ...}
    rows 里的每一项：path/size/files/folders/mtime/isDir，按体积降序。
    versions=True 时另给 "versionGroups"：[{group, versions: [{version, path, size, mtime}]}]
    """
    d = load(csv)
    meta = {
        "csv": os.path.abspath(csv),
        "csvName": os.path.basename(csv),
        "rows": int(len(d)),
        "dirs": int(d["is_dir"].sum()),
        "files": int((~d["is_dir"]).sum()),
        "foldersOnly": not bool(d["is_dir"].any()),
    }

    target = path.lower().rstrip("\\")
    exact = target in set(d["key"])
    if not exact:
        sel = d[d["key"].str.startswith(target + "\\")].copy()
    elif recursive:
        sel = d[d["key"].str.startswith(target + "\\")].copy()
    else:
        sel = d[d["parent"] == target].copy()

    filtered = int(len(sel))
    notes = []
    if not sel.empty:
        sel = sel[sel["size"] >= min_mb * MB]
        sel = sel.sort_values("size", ascending=False)
        if stale_days:
            cutoff = pd.Timestamp.now() - pd.Timedelta(days=stale_days)
            mt = pd.to_datetime(sel["mtime"], errors="coerce")
            before = len(sel)
            sel = sel[mt < cutoff]
            notes.append(f"只保留 {stale_days} 天前修改过的: {len(sel)}/{before} 个")

    rows = []
    for _, r in sel.head(top).iterrows():
        rows.append({
            "path": r["key"],
            "size": int(r["size"]),
            "files": int(r["files"] or 0),
            "folders": int(r["folders"] or 0),
            "mtime": str(r["mtime"])[:19],
            "isDir": bool(r["is_dir"]),
        })

    version_groups = []
    if versions:
        found = []
        for _, r in sel.iterrows():
            m = VER_RE.search(os.path.basename(r["key"]))
            if m:
                stem = VER_RE.sub("", os.path.basename(r["key"])).strip("_-.")
                found.append((stem, m.group(1), r["key"], int(r["size"]), str(r["mtime"])[:19]))
        buckets: dict = {}
        for stem, version, key, size, mtime in found:
            buckets.setdefault(stem, []).append(
                {"version": version, "path": key, "size": size, "mtime": mtime})
        for stem in sorted(buckets):
            entries = sorted(buckets[stem], key=lambda item: item["version"])
            version_groups.append({
                "group": stem,
                "count": len(entries),
                "totalBytes": sum(item["size"] for item in entries),
                "versions": entries,
            })

    return {
        "meta": meta,
        "path": path,
        "exactMatch": exact,
        "recursive": bool(recursive),
        "minMb": min_mb,
        "staleDays": stale_days,
        "matched": int(len(sel)),
        "beforeThreshold": filtered,
        "totalBytes": int(sel["size"].sum()),
        "rows": rows,
        "versionGroups": version_groups,
        "notes": notes,
    }


def query_rows(argv=None) -> dict:
    """`--rows` 的结构化入口：跑一次 select()，打印 JSON 后返回同一份结果。"""
    ap = argparse.ArgumentParser(description="从 WizTree CSV 快照查询文件夹明细（结构化输出）")
    ap.add_argument("csv")
    ap.add_argument("--path", required=True)
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--min-mb", type=float, default=0.0)
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--versions", action="store_true")
    ap.add_argument("--stale-days", type=int, default=0)
    args = ap.parse_args(argv)

    result = select(args.csv, args.path, recursive=args.recursive, min_mb=args.min_mb,
                    stale_days=args.stale_days, top=args.top, versions=args.versions)
    meta = result["meta"]
    print(f"[读入] {meta['csvName']}: {meta['rows']:,} 行, "
          f"文件夹 {meta['dirs']:,} / 文件 {meta['files']:,}")
    if meta["foldersOnly"]:
        print("[注意] 该快照只有文件夹行，无法查到文件名，最小粒度=文件夹")
    if not result["exactMatch"]:
        print(f"[警告] 快照中没有 `{args.path}`，尝试前缀匹配")
    for note in result["notes"]:
        print(f"[过滤] {note}")
    if result["versionGroups"]:
        print(f"\n=== 带版本号的项，按同名前缀分组 ===")
        for group in result["versionGroups"]:
            print(f"\n  [{group['group']}]  合计 {human(group['totalBytes'])}  共 {group['count']} 个版本")
            for item in group["versions"]:
                print(f"     {human(item['size']):>10}  v{item['version']:<16} {item['mtime'][:16]}  "
                      f"{os.path.basename(item['path'])}")
    else:
        print(f"\n=== `{args.path}` {'递归后代' if args.recursive else '直属子项'} "
              f"(>= {args.min_mb} MB, 前 {args.top}) ===")
        print(f"{'大小':>12}  {'文件数':>9}  {'目录数':>8}  {'修改时间':<17}  名称")
        for row in result["rows"]:
            kind = "D" if row["isDir"] else "F"
            print(f"{human(row['size']):>12}  {row['files']:>9}  {row['folders']:>8}  "
                  f"{row['mtime'][:16]:<17} {kind} {os.path.basename(row['path'])}")
        print(f"\n合计列出 {len(result['rows'])} / {result['matched']} 项，"
              f"全部匹配项体积合计 {human(result['totalBytes'])}")
    print(json.dumps(result, ensure_ascii=False))
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="从 WizTree CSV 快照查询文件夹明细（不扫描磁盘）")
    ap.add_argument("csv")
    ap.add_argument("--path", required=True, help="要查询的文件夹")
    ap.add_argument("--recursive", action="store_true", help="递归列出所有后代")
    ap.add_argument("--min-mb", type=float, default=0.0)
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--versions", action="store_true", help="按“同名前缀 + 版本号”分组，找旧版本残留")
    ap.add_argument("--stale-days", type=int, default=0, help="只列出超过 N 天未修改的")
    ap.add_argument("--dump-csv", default="")
    ap.add_argument("--rows", action="store_true", help="额外打印结构化 JSON（供工具调用）")
    args = ap.parse_args(argv)

    if args.rows:
        query_rows([args.csv, "--path", args.path]
                   + (["--recursive"] if args.recursive else [])
                   + (["--versions"] if args.versions else [])
                   + ["--min-mb", str(args.min_mb), "--top", str(args.top)]
                   + (["--stale-days", str(args.stale_days)] if args.stale_days else []))
        return 0

    d = load(args.csv)
    print(f"[读入] {os.path.basename(args.csv)}: {len(d):,} 行, "
          f"文件夹 {int(d['is_dir'].sum()):,} / 文件 {int((~d['is_dir']).sum()):,}")
    if not d["is_dir"].any():
        print("[注意] 该快照只有文件夹行，无法查到文件名，最小粒度=文件夹")

    target = args.path.lower().rstrip("\\")
    if target not in set(d["key"]):
        print(f"[警告] 快照中没有 `{args.path}`，尝试前缀匹配")
        sel = d[d["key"].str.startswith(target + "\\")]
    elif args.recursive:
        sel = d[d["key"].str.startswith(target + "\\")].copy()
    else:
        sel = d[d["parent"] == target].copy()

    if sel.empty:
        print("[结果] 空")
        return 0

    sel = sel[sel["size"] >= args.min_mb * MB]
    sel = sel.sort_values("size", ascending=False)

    if args.stale_days:
        cutoff = pd.Timestamp.now() - pd.Timedelta(days=args.stale_days)
        mt = pd.to_datetime(sel["mtime"], errors="coerce")
        sel = sel[mt < cutoff]
        print(f"[过滤] 只保留 {args.stale_days} 天前修改过的: {len(sel)} 个")

    if args.versions:
        rows = []
        for _, r in sel.iterrows():
            m = VER_RE.search(os.path.basename(r["key"]))
            if m:
                stem = VER_RE.sub("", os.path.basename(r["key"])).strip("_-.")
                rows.append({"group": stem, "version": m.group(1), "path": r["key"],
                             "size": int(r["size"]), "mtime": r["mtime"]})
        if not rows:
            print("[结果] 没找到带版本号的项")
            return 0
        v = pd.DataFrame(rows).sort_values(["group", "version"])
        print(f"\n=== 带版本号的项（共 {len(v)} 个），按同名前缀分组 ===")
        for g, grp in v.groupby("group"):
            tot = grp["size"].sum()
            print(f"\n  [{g}]  合计 {human(tot)}  共 {len(grp)} 个版本")
            for _, r in grp.iterrows():
                print(f"     {human(r['size']):>10}  v{r['version']:<16} {r['mtime'][:16]}  "
                      f"{os.path.basename(r['path'])}")
        if args.dump_csv:
            v.to_csv(args.dump_csv, index=False, encoding="utf-8-sig")
            print(f"\n[写出] {os.path.abspath(args.dump_csv)}")
        return 0

    print(f"\n=== `{args.path}` {'递归后代' if args.recursive else '直属子项'} "
          f"(>= {args.min_mb} MB, 前 {args.top}) ===")
    print(f"{'大小':>12}  {'文件数':>9}  {'目录数':>8}  {'修改时间':<17}  名称")
    for _, r in sel.head(args.top).iterrows():
        kind = "D" if r["is_dir"] else "F"
        print(f"{human(r['size']):>12}  {r['files']:>9}  {r['folders']:>8}  "
              f"{str(r['mtime'])[:16]:<17} {kind} {os.path.basename(r['key'])}")
    print(f"\n合计列出 {min(args.top, len(sel))} / {len(sel)} 项，"
          f"全部匹配项体积合计 {human(sel['size'].sum())}")

    if args.dump_csv:
        sel.to_csv(args.dump_csv, index=False, encoding="utf-8-sig")
        print(f"[写出] {os.path.abspath(args.dump_csv)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
