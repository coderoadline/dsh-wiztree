#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wiztree_snapshot_diff.py — 对比两份 WizTree CSV 快照，找出“C 盘里哪些文件夹新增了多少”。

================================================================================
为什么不能简单地“两份 CSV 相减”
================================================================================
坑 1：WizTree 导出的 CSV 里，**文件夹行**的三个关键列是**整棵子树的累计值**：
    C:\\Users\\ASUS\\AppData\\Local\\Temp , 大小=8,000,000,000 , 文件=40000 , 文件夹=5000
含义是“Temp 及其所有子目录里共有 40000 个文件、5000 个目录、合计 8 GB”。
所以：
  * `大小` 列的差值 = 该文件夹子树的净增长（含所有后代）；
  * `文件` / `文件夹` 列的差值 = **精确**的新增文件数 / 新增目录数。
本工具会**自动校验**这一点（见“数据体检”），不成立就明确警告。

坑 2：**两次导出的覆盖范围可能不同**。
实测遇到：旧快照只导出了 `C:\\Users` 子树（55,283/55,284 行都在 C:\\Users 下），
`C:\\Windows`、`C:\\ProgramData` 等一行都没有。此时若把“旧快照没有的路径”
当成“新增文件夹”，会得出“20 分钟新增 122 GB”的荒谬结论
（真实增量只有 414 MB）。

本工具的判定规则：
  * 只有新旧两份都**完整枚举了子目录**的文件夹，其 `大小` 差值才被采信（comparable）；
  * 覆盖不全或旧快照缺失的路径，**绝不当作“新增”**，而是单独列出并标注
    “无法比对，不代表新增”；
  * `文件` / `文件夹` 的差值是精确的（累计计数不受导出范围影响），
    用来回答“到底新增了几个目录 / 几个文件”；
  * 输出“最小相关父文件夹”：父目录的增长若已完全由后代解释，就只列后代。

================================================================================
用法
================================================================================
    python wiztree_snapshot_diff.py OLD.csv NEW.csv -o report.md
    python wiztree_snapshot_diff.py OLD.csv NEW.csv -o report.md --min-mb 10 --dump-csv all.csv
    python wiztree_snapshot_diff.py OLD.csv NEW.csv -o report.md --root 'C:\\Users'
"""

from __future__ import annotations

import argparse
import bisect
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
BANNER_RE = re.compile(r"(WizTree[^)]*?)(\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2})")

COL_ALIASES = {
    "path": ["文件名称", "Name", "Path", "Filename"],
    "size": ["大小", "Size"],
    "alloc": ["分配", "Allocated"],
    "mtime": ["修改时间", "Modified"],
    "attrs": ["属性", "Attributes"],
    "files": ["文件", "Files"],
    "folders": ["文件夹", "Folders"],
}


# =============================================================================
# 读取
# =============================================================================

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


def read_snapshot(path: str, verbose: bool = True) -> tuple[pd.DataFrame, dict]:
    if not os.path.isfile(path):
        raise SystemExit(f"[错误] 找不到文件: {path}")
    enc = sniff_encoding(path)

    with open(path, "r", encoding=enc, newline="") as fh:
        banner = fh.readline().rstrip("\r\n")
        header_line = fh.readline()
    bm = BANNER_RE.search(banner)
    cols = [c.strip().lstrip("\ufeff") for c in next(csv.reader(io.StringIO(header_line)))]

    pick: dict[str, str] = {}
    for logical, aliases in COL_ALIASES.items():
        for a in aliases:
            if a in cols:
                pick[logical] = a
                break
    missing = [k for k in ("path", "size", "files", "folders") if k not in pick]
    if missing:
        raise SystemExit(
            f"[错误] {os.path.basename(path)} 缺少必需列 {missing}。\n"
            f"        实际表头: {cols}\n"
            f"        请用 WizTree 导出含 文件名称/大小/文件/文件夹 的 CSV。"
        )

    raw = pd.read_csv(path, encoding=enc, skiprows=1, dtype=str,
                      keep_default_na=False, low_memory=False, engine="c")
    raw.columns = [str(c).strip().lstrip("\ufeff") for c in raw.columns]

    d = pd.DataFrame()
    d["raw_path"] = raw[pick["path"]].astype(str).str.strip()
    d = d[d["raw_path"].str.len() > 0].copy()
    # 重新编号索引：否则下面 `.loc[idx, ...]` 会按“原始 CSV 行号”去对齐，
    # 而我们是在一个全新索引的 DataFrame 上取值，pandas 3 会因标签对不上而报错。
    d = d.reset_index(drop=True)
    d["key"] = d["raw_path"].str.lower().str.rstrip("\\")
    idx = d.index
    d["size"] = pd.to_numeric(raw.loc[idx, pick["size"]], errors="coerce").fillna(0).astype("int64")
    d["alloc"] = (pd.to_numeric(raw.loc[idx, pick["alloc"]], errors="coerce").fillna(0).astype("int64")
                  if "alloc" in pick else d["size"])
    d["files"] = pd.to_numeric(raw.loc[idx, pick["files"]], errors="coerce").fillna(0).astype("int64")
    d["folders"] = pd.to_numeric(raw.loc[idx, pick["folders"]], errors="coerce").fillna(0).astype("int64")
    d["mtime"] = raw.loc[idx, pick["mtime"]].astype(str) if "mtime" in pick else ""
    d["depth"] = d["key"].str.count("\\\\")
    d["parent"] = d["key"].map(lambda k: k.rsplit("\\", 1)[0] if "\\" in k else "")
    d = d.reset_index(drop=True)

    meta = {
        "file": os.path.abspath(path), "name": os.path.basename(path), "encoding": enc,
        "banner": banner.strip(), "time": bm.group(2) if bm else "",
        "rows": len(d), "n_columns": len(cols), "columns": cols,
        "dup_keys": int(d["key"].duplicated().sum()),
    }
    if verbose:
        print(f"[读入] {meta['name']}")
        print(f"       行数={meta['rows']:,}  列数={meta['n_columns']}  编码={enc}  "
              f"快照时间={meta['time'] or '未识别'}")
    return d, meta


# =============================================================================
# 数据体检
# =============================================================================

def subtree_counts(d: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    """
    计算每个文件夹的【直属】文件数与【未列出的子目录数】。

    WizTree 的 `文件夹` 列 = 该文件夹**自身** + 所有后代目录数（含自己）。
    `文件` 列 = 该文件夹子树内的文件数（不含目录）。
    所以对父目录 F 及其已列出的直属子目录 c1..cn：
        sum(F.folders)  = 1 + n + Σ folders(ci)
      ⇒ own_dirs(F) = F.folders - Σ folders(ci) - n
         own_dirs > 0 表示“还有 own_dirs-1 个直属子目录没有被导出成行”
         own_dirs == 0 表示子目录已列全（可放心与另一份快照做差）

    对 `文件` 列则没有“含自身”的问题：
        own_files(F) = F.files - Σ files(ci)
    """
    kids_f = d.groupby("parent")["files"].sum()
    kids_d = d.groupby("parent")["folders"].sum()
    n_kids = d.groupby("parent").size()
    idx = d["key"]
    own_f = d["files"].to_numpy() - kids_f.reindex(idx).fillna(0).to_numpy().astype("int64")
    own_d = (d["folders"].to_numpy()
             - kids_d.reindex(idx).fillna(0).to_numpy().astype("int64")
             - n_kids.reindex(idx).fillna(0).to_numpy().astype("int64"))
    return pd.Series(own_f, index=idx), pd.Series(own_d, index=idx)


def health_check(d: pd.DataFrame, label: str) -> dict:
    own_f, own_d = subtree_counts(d)
    roots = d[d["key"].str.match(r"^[a-z]:$")]
    root_f = int(roots["files"].iloc[0]) if len(roots) else 0
    root_d = int(roots["folders"].iloc[0]) if len(roots) else 0
    res = {
        "label": label,
        "own_files_sum": int(own_f.sum()),
        "own_files_negative": int((own_f < 0).sum()),
        "own_dirs_negative": int((own_d < 0).sum()),
        "root_files": root_f,
        "root_folders": root_d,
        # 根节点累计值 - 已列出的目录总数 = 未导出的目录数
        "unlisted_dirs": root_d - len(d),
        "unlisted_files": root_f - int(own_f.sum()),
    }
    res["cumulative_ok"] = (res["own_files_negative"] == 0 and res["own_dirs_negative"] <= 1)
    top = d["key"].map(lambda k: "\\".join(k.split("\\")[:2]) if "\\" in k else k)
    res["scope"] = top.value_counts().head(8).to_dict()
    return res


def completeness(d: pd.DataFrame) -> pd.Series:
    """
    该文件夹在【本快照】中，其【直属子目录】是否已被完整列出。

    判据： own_dirs == 0
      其中 own_dirs = 自身 `文件夹` 累计值 - Σ(直属子目录 `文件夹` 累计值) - 直属子目录个数
      （`文件夹` 列含文件夹自身，故需减去子目录个数）
      own_dirs > 0 表示“还有 own_dirs-1 个子目录没被导出成行”，
      此时该文件夹子树不完整，与另一份快照做差会把缺失的子树误算成增长，必须排除。

    注意：own_files > 0（有直属文件）不影响体积可比性——直属文件本来就计入
    该文件夹自己的 `大小`，只要子目录齐全，体积差值依然可信。
    """
    _, own_d = subtree_counts(d)
    return pd.Series(own_d.to_numpy() == 0, index=d["key"])


# =============================================================================
# 核心对比
# =============================================================================

def compare(old: pd.DataFrame, new: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    o = old[["key", "size", "files", "folders"]].rename(
        columns={"size": "old_size", "files": "old_files", "folders": "old_folders"})
    n = new[["key", "size", "files", "folders"]].rename(
        columns={"size": "new_size", "files": "new_files", "folders": "new_folders"})

    m = n.merge(o, on="key", how="left", indicator=True)
    only_new = m[m["_merge"] == "left_only"].drop(columns=["_merge"]).copy()
    m = m[m["_merge"] == "both"].drop(columns=["_merge"]).copy()
    m["in_old"] = True
    only_new["in_old"] = False
    only_new["old_size"] = 0
    only_new["old_files"] = 0
    only_new["old_folders"] = 0
    only_new["d_size"] = only_new["new_size"]
    only_new["d_files"] = only_new["new_files"]
    only_new["d_folders"] = only_new["new_folders"]
    only_new["comparable"] = True

    m["d_size"] = m["new_size"] - m["old_size"]
    m["d_files"] = (m["new_files"] - m["old_files"]).astype("int64")
    m["d_folders"] = (m["new_folders"] - m["old_folders"]).astype("int64")

    oc = completeness(old)
    nc = completeness(new)
    m["old_complete"] = m["key"].map(oc).fillna(False).to_numpy()
    m["new_complete"] = m["key"].map(nc).fillna(False).to_numpy()
    m["comparable"] = m["old_complete"] & m["new_complete"]

    has_kids = set(new["parent"]) - {""}
    m["is_leaf"] = ~m["key"].isin(has_kids)
    return m, only_new


def responsible_folders(m: pd.DataFrame, min_bytes: int) -> pd.DataFrame:
    """
    挑出【最小相关父文件夹】：若某父目录的增长已能由其后代解释，则丢弃父目录、只留后代。
    """
    cand = m[m["comparable"] & (m["d_size"] > min_bytes)].copy()
    if cand.empty:
        return cand

    m2 = m.sort_values("key")
    ks = m2["key"].tolist()
    prefix = [0]
    for v in m2["d_size"].tolist():
        prefix.append(prefix[-1] + v)

    def desc_sum(k: str) -> int:
        pref = k + "\\"
        i = bisect.bisect_left(ks, pref)
        j = bisect.bisect_left(ks, pref + "\uffff")
        return prefix[j] - prefix[i] if j > i else 0

    ds = [desc_sum(k) for k in cand["key"]]
    cand["desc_delta"] = ds
    cand["self_delta"] = cand["d_size"].to_numpy() - pd.Series(ds, index=cand.index).to_numpy()
    keep = cand["desc_delta"].to_numpy() < (cand["d_size"].to_numpy() - 1024)
    return cand[keep].copy()


def drill_down(m: pd.DataFrame, start: str, min_bytes: int, max_depth: int = 8) -> pd.DataFrame:
    """
    自顶向下定位增长点（核心算法）。

    为什么需要它：`大小` 是子树累计值，所以**父目录的差值本身就是精确的**，
    即使旧快照没有列出它的子目录。于是从根开始逐层分解，
    就能把“全盘 414 MB 的增长”一步步定位到具体子树。

    每行标记（关键：区分“真的新增”与“旧快照根本没观测到”）：
      kind=observed    该路径在旧快照中存在 → 差值精确（它自己的累计值是准的）
      kind=new         旧快照中不存在，但它**最近的已观测祖先**已把子目录列全
                       ⇒ 当时确实没有这个文件夹 ⇒ 真·新增，差值 = 全部大小
      kind=unobserved  旧快照中不存在，且最近的已观测祖先也没列全子目录
                       ⇒ 只是旧导出没覆盖该范围，**不能判定为新增**，整枝排除
      comparable=True  新旧两份都完整列出了它的子目录 → 可以继续下钻
    """
    idx = m.set_index("key")
    children: dict[str, list[str]] = {}
    for k in m["key"]:
        p = k.rsplit("\\", 1)[0] if "\\" in k else ""
        children.setdefault(p, []).append(k)

    observed = set(m.loc[m["in_old"], "key"])
    fully_listed = set(m.loc[m["comparable"], "key"])

    def classify(k: str) -> str:
        if k in observed:
            return "observed"
        parts = k.split("\\")
        for i in range(len(parts) - 1, 0, -1):
            anc = "\\".join(parts[:i])
            if anc in observed:
                return "new" if anc in fully_listed else "unobserved"
        return "unobserved"

    rows: list[dict] = []
    stack: list[tuple[str, int]] = [(start, 0)]
    while stack:
        key, depth = stack.pop()
        if depth >= max_depth or key not in idx.index:
            continue
        row = idx.loc[key]
        if isinstance(row, pd.DataFrame):
            row = row.iloc[0]
        kids = children.get(key, [])
        grown = []
        for c in kids:
            cr = idx.loc[c]
            if isinstance(cr, pd.DataFrame):
                cr = cr.iloc[0]
            kind = classify(c)
            if kind == "unobserved":
                continue                       # 未观测子树：整枝排除，不算作增长
            if cr["d_size"] > min_bytes or kind == "new":
                grown.append((c, cr, kind))
        if not grown:
            continue
        grown.sort(key=lambda t: -t[1]["d_size"])
        kids_delta = sum(int(cr["d_size"]) for _, cr, _ in grown)
        for c, cr, kind in grown:
            rows.append({
                "depth": depth + 1,
                "path": c,
                "delta": int(cr["d_size"]),
                "old_size": int(cr["old_size"]),
                "new_size": int(cr["new_size"]),
                "d_files": int(cr["d_files"]),
                "d_folders": int(cr["d_folders"]),
                "kind": kind,
                "observed": kind == "observed",
                "comparable": bool(cr["comparable"]),
                "parent_delta": int(row["d_size"]),
                "kids_delta": kids_delta,
                "n_kids": len(kids),
                "n_kids_grown": len(grown),
            })
            if children.get(c):
                stack.append((c, depth + 1))
    return pd.DataFrame(rows)


# =============================================================================
# 输出工具
# =============================================================================

def human(n: float) -> str:
    n = float(n)
    sign = "-" if n < 0 else ""
    a = abs(n)
    if a >= GB:
        return f"{sign}{a / GB:.2f} GB"
    if a >= MB:
        return f"{sign}{a / MB:.2f} MB"
    if a >= 1024:
        return f"{sign}{a / 1024:.1f} KB"
    return f"{sign}{int(a)} B"


def use_utf8_output() -> None:
    """
    让本脚本的 print() 走 UTF-8。

    报告里有中文和 ✅/⚠️/🆕，Windows 控制台默认 GBK/CP936：直接跑容易抛
    UnicodeEncodeError，重定向到管道时则会变成乱码。这里只改编码，不改输出内容。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def md(s) -> str:
    return str(s).replace("|", "\\|")


# =============================================================================
# main
# =============================================================================

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="对比两份 WizTree CSV 快照，找出文件夹级别的新增体积。")
    ap.add_argument("old"); ap.add_argument("new")
    ap.add_argument("-o", "--out", default="wiztree_diff_report.md")
    ap.add_argument("--min-mb", type=float, default=1.0,
                    help="最小增长阈值(MB)，默认 1；分析 C 盘短期变化时 1MB 更实用")
    ap.add_argument("--top", type=int, default=200)
    ap.add_argument("--depth", type=int, default=8, help="自顶向下下钻的最大层数")
    ap.add_argument("--root", default="", help="只分析该前缀下的路径")
    ap.add_argument("--subtree", default="", help="只对该子树做自顶向下下钻（推荐用于已完整枚举的区域）")
    ap.add_argument("--dump-csv", default="")
    ap.add_argument("--dump-json", default="")
    args = ap.parse_args(argv)

    use_utf8_output()

    print("=" * 78)
    print("WizTree 快照对比  (只对比文件夹行；大小/文件/文件夹 均为子树累计值)")
    print("=" * 78)

    old, om = read_snapshot(args.old)
    new, nm = read_snapshot(args.new)

    ho, hn = health_check(old, "旧快照"), health_check(new, "新快照")
    print("-" * 78)
    print("[体检] 累计列自洽性")
    for h in (ho, hn):
        print(f"  {h['label']}: 根 文件={h['root_files']:,} 文件夹={h['root_folders']:,}  "
              f"直属文件合计={h['own_files_sum']:,}  自洽={'是' if h['cumulative_ok'] else '否'}")
        print(f"      导出范围: {h['scope']}")
    if not (ho["cumulative_ok"] and hn["cumulative_ok"]):
        print("\n[警告] 累计列不自洽，结果可能不可靠！")

    def root_of(d):
        r = d[d["key"].str.match(r"^[a-z]:$")]
        return r.iloc[0] if len(r) else None
    ro, rn = root_of(old), root_of(new)
    if ro is None or rn is None:
        raise SystemExit("[错误] 快照中找不到根节点行(如 'C:\\')")

    print("-" * 78)
    print("[总量] 全盘变化")
    print(f"  大小     : {ro['size']:>15,} -> {rn['size']:>15,}  Δ {rn['size']-ro['size']:>+15,} "
          f"({human(rn['size']-ro['size'])})")
    print(f"  占用     : {ro['alloc']:>15,} -> {rn['alloc']:>15,}  Δ {rn['alloc']-ro['alloc']:>+15,}")
    print(f"  文件数   : {ro['files']:>15,} -> {rn['files']:>15,}  Δ {rn['files']-ro['files']:>+15,}")
    print(f"  文件夹数 : {ro['folders']:>15,} -> {rn['folders']:>15,}  Δ {rn['folders']-ro['folders']:>+15,}")

    m, only_new = compare(old, new)
    print("-" * 78)
    print(f"[对比] 共有文件夹 {len(m):,}；仅新快照有 {len(only_new):,}；"
          f"两边完整可对比 {int(m['comparable'].sum()):,}")

    if args.root:
        pref = args.root.lower().rstrip("\\")
        m = m[m["key"].str.startswith(pref + "\\") | (m["key"] == pref)].copy()
        only_new = only_new[only_new["key"].str.startswith(pref + "\\")
                            | (only_new["key"] == pref)].copy()
        print(f"[过滤] 只分析 {args.root} 下: 共有 {len(m):,}")

    thr = int(args.min_mb * MB)
    resp = responsible_folders(m, thr).sort_values("d_size", ascending=False)
    on_big = only_new[only_new["new_size"] > thr].sort_values("new_size", ascending=False)
    dirs_added = m[m["d_folders"] > 0].sort_values("d_folders", ascending=False)
    files_added = m[m["d_files"] > 0].sort_values("d_files", ascending=False)

    # 自顶向下定位增长点（核心结果）
    # 把“仅新快照存在”的路径也纳入：它们当时确实不存在，差值 = 全部新增
    combined = pd.concat([m, only_new], ignore_index=True)
    root_key = str(ro["key"])
    start = args.subtree.lower().rstrip("\\") if args.subtree else (
        args.root.lower().rstrip("\\") if args.root else root_key)
    dd = drill_down(combined, start, thr, max_depth=args.depth)
    if not dd.empty:
        dd = dd.sort_values(["depth", "delta"], ascending=[True, False]).reset_index(drop=True)

    print("-" * 78)
    print(f"[结果] 自顶向下定位到 {len(dd)} 个增长路径（深度 <= {args.depth}）")
    print(f"       可比对且增长 > {args.min_mb} MB 的最小相关父文件夹: {len(resp)} 个, "
          f"合计 {human(resp['d_size'].sum())}")
    print(f"       精确新增目录: {rn['folders']-ro['folders']:+,} 个   "
          f"精确新增文件: {rn['files']-ro['files']:+,} 个")
    print("-" * 78)
    for _, r in dd.head(40).iterrows():
        flag = "" if r["comparable"] else "  ← 边界(旧快照未列全子目录)"
        print(f"  {'  ' * int(r['depth'])}{human(r['delta']):>10}  "
              f"Δ文件 {r['d_files']:>+5}  {r['path']}{flag}")

    # ------------------------- 报告 -------------------------
    L: list[str] = []
    A = L.append
    A("# WizTree 快照对比报告：文件夹级新增体积")
    A("")
    A(f"- 生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}")
    A(f"- 旧快照：`{om['file']}`（WizTree 生成于 **{om['time']}**，{om['rows']:,} 行）")
    A(f"- 新快照：`{nm['file']}`（WizTree 生成于 **{nm['time']}**，{nm['rows']:,} 行）")
    A("")
    A("## 数据体检")
    A("")
    A("| 项目 | 旧快照 | 新快照 |")
    A("|---|---:|---:|")
    A(f"| 根节点 大小 | {ro['size']:,} | {rn['size']:,} |")
    A(f"| 根节点 文件数 | {ro['files']:,} | {rn['files']:,} |")
    A(f"| 根节点 文件夹数 | {ro['folders']:,} | {rn['folders']:,} |")
    A(f"| CSV 行数 | {om['rows']:,} | {nm['rows']:,} |")
    A(f"| 累计列自洽 | {'✅ 是' if ho['cumulative_ok'] else '❌ 否'} | {'✅ 是' if hn['cumulative_ok'] else '❌ 否'} |")
    A("")
    A("> `大小` / `文件` / `文件夹` 对文件夹行而言是**整棵子树的累计值**（已自动校验）。")
    A("> 因此 `文件` / `文件夹` 的差值即**精确的新增文件数 / 新增目录数**。")
    A("")
    A("### ⚠️ 导出范围差异（决定结论可信度）")
    A("")
    A("| 快照 | 实际导出的范围 |")
    A("|---|---|")
    for h in (ho, hn):
        sc = "、".join(f"`{k}` ({v:,} 行)" for k, v in list(h["scope"].items())[:6])
        A(f"| {h['label']} | {sc} |")
    A("")
    A("**本报告不把“旧快照没有的路径”当作新增文件夹**——那可能只是旧导出没覆盖到。")
    A("只有新旧两份都完整枚举了子目录的文件夹，其体积差值才被采信。")
    A("")

    A("## 1. 全盘总量变化（最可靠）")
    A("")
    A("| 指标 | 旧 | 新 | 变化 |")
    A("|---|---:|---:|---:|")
    A(f"| 总大小 | {human(ro['size'])} | {human(rn['size'])} | **{human(rn['size']-ro['size'])}** |")
    A(f"| 总占用 | {human(ro['alloc'])} | {human(rn['alloc'])} | {human(rn['alloc']-ro['alloc'])} |")
    A(f"| 文件数 | {ro['files']:,} | {rn['files']:,} | **{rn['files']-ro['files']:+,}** |")
    A(f"| 文件夹数 | {ro['folders']:,} | {rn['folders']:,} | **{rn['folders']-ro['folders']:+,}** |")
    A("")

    A(f"## 2. 最小相关父文件夹（可比对、增长 > {args.min_mb} MB）")
    A("")
    if resp.empty:
        A(f"_没有可比对且增长超过 {args.min_mb} MB 的文件夹。_")
    else:
        A(f"共 **{len(resp)}** 个，增长合计 **{human(resp['d_size'].sum())}**。")
        A("")
        A("“最小相关父文件夹”= 父目录的增长若已完全由后代解释，则只列后代、不列父目录。")
        A("")
        A("| # | 文件夹 | 新增 | 旧大小 | 新大小 | Δ文件 | Δ目录 |")
        A("|---:|---|---:|---:|---:|---:|---:|")
        for i, (_, r) in enumerate(resp.head(args.top).iterrows(), 1):
            A(f"| {i} | `{md(r['key'])}` | **{human(r['d_size'])}** | {human(r['old_size'])} "
              f"| {human(r['new_size'])} | {r['d_files']:+,} | {r['d_folders']:+,} |")
    A("")

    A("## 2b. 自顶向下定位增长点（推荐先看这里）")
    A("")
    A(f"下钻起点：`{start}`")
    A("")
    A("因为 `大小` 是子树累计值，**父目录的差值本身就是精确的**——即使旧快照没有列出它的子目录。")
    A("所以从根开始逐层分解，就能定位增长落在哪个子树里。")
    A("")
    A("标记含义：")
    A("")
    A("- `✓ 已观测` 旧快照中存在该路径 → 差值精确，可继续下钻")
    A("- `🆕 新增` 旧快照中不存在，但其父目录当时已被完整观测 → 当时确实没有它，差值 = 全部新增")
    A("- `⚠️ 边界` 旧快照列出了它，但没列全它的子目录 → 该行差值仍精确（它自己的累计值是准的），")
    A("  但无法再细分；差额落在“未列出的子目录或直属文件”里")
    A("")
    A("`本层已解释` = 该文件夹的直接子目录中已列出的增长之和；与它的差值比较，")
    A("差额即落在未列出的子目录或直属文件里。")
    A("")
    if dd.empty:
        A(f"_没有超过 {args.min_mb} MB 的增长路径。_")
    else:
        A("| 层级 | 文件夹 | 新增 | 本层已解释 | Δ文件 | Δ目录 | 判定 |")
        A("|---:|---|---:|---:|---:|---:|---|")
        for _, r in dd.head(args.top).iterrows():
            if r["kind"] == "new":
                tag = "🆕 新增"
            elif r["comparable"]:
                tag = "✓ 已观测·可下钻"
            else:
                tag = "⚠️ 边界"
            indent = "&nbsp;&nbsp;&nbsp;&nbsp;" * int(r["depth"])
            explained = f"{human(r['kids_delta'])} ({int(r['n_kids_grown'])}/{int(r['n_kids'])})"
            A(f"| {int(r['depth'])} | {indent}`{md(r['path'])}` | **{human(r['delta'])}** "
              f"| {explained} | {r['d_files']:+,} | {r['d_folders']:+,} | {tag} |")
    A("")

    # 未观测子树（旧导出没覆盖）——必须显式说明，否则会被误读成“新增”
    observed_keys = set(m["key"])
    fully_listed = set(combined.loc[combined["comparable"], "key"])

    def nearest_observed_ancestor(k: str) -> str | None:
        parts = k.split("\\")
        for i in range(len(parts) - 1, 0, -1):
            anc = "\\".join(parts[:i])
            if anc in observed_keys:
                return anc
        return None

    def is_unobserved(k: str) -> bool:
        if k in observed_keys:
            return False
        anc = nearest_observed_ancestor(k)
        if anc is None:
            return True
        return bool(anc not in fully_listed)

    # `.astype(bool)` 是必需的：Series.map() 遇到 None 会产出可空布尔（BooleanArray），
    # 与另一个可空布尔做 `&` 时 pandas 3 会直接报错。
    on_top_unobserved = only_new[
        only_new["key"].map(is_unobserved).astype(bool)
        & ~only_new["key"].map(
            lambda k: is_unobserved(k.rsplit("\\", 1)[0] if "\\" in k else "")
        ).astype(bool)
    ].sort_values("new_size", ascending=False)

    A("## 2c. 旧快照**未覆盖**的范围（不可判定，切勿当成新增）")
    A("")
    A("下面的顶层路径在旧快照中**一行都没有**，说明旧导出根本没有覆盖这些范围。")
    A("它们在“新快照大小”一栏的数字**不是新增量**，只是当前体积。")
    A("这些子树整体被排除在增长统计之外。")
    A("")
    A("| 顶层路径 | 新快照大小 | 说明 |")
    A("|---|---:|---|")
    for _, r in on_top_unobserved.head(30).iterrows():
        A(f"| `{md(r['key'])}` | {human(r['new_size'])} | 旧快照未导出该范围 |")
    A("")

    A("## 3. 精确新增的目录与文件")
    A("")
    A(f"全盘新增目录 **{rn['folders']-ro['folders']:+,}** 个、新增文件 **{rn['files']-ro['files']:+,}** 个。")
    A("")
    if not dirs_added.empty:
        A("### 3.1 出现了新目录的文件夹")
        A("")
        A("| 文件夹 | Δ目录 | Δ文件 | Δ大小 |")
        A("|---|---:|---:|---:|")
        for _, r in dirs_added.head(60).iterrows():
            A(f"| `{md(r['key'])}` | **{r['d_folders']:+,}** | {r['d_files']:+,} | {human(r['d_size'])} |")
        A("")
    if not files_added.empty:
        A("### 3.2 文件数增加最多的文件夹")
        A("")
        A("| 文件夹 | Δ文件 | Δ目录 | Δ大小 |")
        A("|---|---:|---:|---:|")
        for _, r in files_added.head(40).iterrows():
            A(f"| `{md(r['key'])}` | **{r['d_files']:+,}** | {r['d_folders']:+,} | {human(r['d_size'])} |")
        A("")

    A("## 4. 无法比对但体积较大的路径（**不代表新增**）")
    A("")
    A("这些路径只出现在新快照里，原因是旧快照没有导出该范围，因此无法判断其增量。")
    A("")
    if on_big.empty:
        A("_无。_")
    else:
        A(f"体积 > {args.min_mb} MB 的前 {min(args.top, len(on_big))} 个：")
        A("")
        A("| # | 路径 | 新快照大小 |")
        A("|---:|---|---:|")
        for i, (_, r) in enumerate(on_big.head(args.top).iterrows(), 1):
            A(f"| {i} | `{md(r['key'])}` | {human(r['new_size'])} |")
    A("")

    report = "\n".join(L)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(report)
    print("-" * 78)
    print(f"[写出] 报告: {os.path.abspath(args.out)}")

    if args.dump_csv:
        cols = ["key", "old_size", "new_size", "d_size", "d_files", "d_folders",
                "old_complete", "new_complete", "comparable", "is_leaf"]
        m[cols].sort_values("d_size", ascending=False).to_csv(
            args.dump_csv, index=False, encoding="utf-8-sig")
        print(f"[写出] CSV: {os.path.abspath(args.dump_csv)}")
    if args.dump_json:
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            json.dump({"old_meta": om, "new_meta": nm,
                       "root": {"old": {k: int(ro[k]) for k in ("size", "alloc", "files", "folders")},
                                "new": {k: int(rn[k]) for k in ("size", "alloc", "files", "folders")}},
                       "folders": m[["key", "old_size", "new_size", "d_size", "d_files",
                                     "d_folders", "comparable"]].to_dict(orient="records")},
                      fh, ensure_ascii=False)
        print(f"[写出] JSON: {os.path.abspath(args.dump_json)}")

    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
