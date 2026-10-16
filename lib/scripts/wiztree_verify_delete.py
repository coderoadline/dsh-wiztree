#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
wiztree_verify_delete.py — 删除建议核实器（**只读，绝不删除任何东西**）。

为什么需要它
------------
WizTree 快照只能告诉你「目录名 + 大小 + 时间戳」，**证明不了目录里是什么**。
仅凭这三点就建议删除，可能让用户丢掉聊天记录、凭据、或正在用的库。
所以每条删除建议在交付前，都必须对目标目录做一次只读的内容核查。

本脚本做的事
------------
对每个候选目录：
  1. 统计文件类型分布（按体积）与文件总数；
  2. 列出最大的若干文件（带时间）；
  3. 识别**危险特征**：数据库/凭据/媒体/已安装的库/运行中的程序；
  4. 给出风险等级 ✅ / ⚠️ / ❌ 与一句话原因。

它**不删除、不修改、不移动**任何文件。

用法
----
    # 核实一个目录
    python wiztree_verify_delete.py 'C:\\Users\\ASUS\\AppData\\Roaming\\Tencent\\WeChat'

    # 一次核实多个（建议从候选清单里挑）
    python wiztree_verify_delete.py '路径1' '路径2' '路径3'

    # 只看结论摘要
    python wiztree_verify_delete.py '路径' --quiet
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

# ---------------------------------------------------------------------------
# 危险特征规则
# ---------------------------------------------------------------------------
# 每条: (匹配的扩展名集合或文件名关键字, 等级, 原因, 类别)
# 等级: "danger"=❌ 绝不能删, "warn"=⚠️ 需确认, "safe"=✅ 通常可删

DANGER_EXT = {
    ".db", ".sqlite", ".sqlite3", ".mdb", ".accdb",
    ".pem", ".key", ".pfx", ".p12", ".jks", ".keystore",
    ".kdbx",           # KeePass
    ".ost", ".pst",    # Outlook 邮件
    ".msg", ".eml",
    ".bak", ".backup",
    ".vhd", ".vhdx", ".vmdk", ".iso",
    ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf",
    ".psd", ".ai", ".sketch", ".fig",
    ".mp4", ".mov", ".avi", ".mkv", ".flv", ".wmv",
    ".jpg", ".jpeg", ".png", ".gif", ".heic", ".raw", ".cr2", ".nef",
    ".mp3", ".wav", ".flac", ".m4a", ".aac",
    ".zip", ".rar", ".7z", ".tar", ".gz",
}

DANGER_NAME_HINTS = [
    # 注意：这些关键字按“整词/带分隔符”匹配，避免误伤
    # （例如 "WeChatUtility.exe" 里含 "chat"，但它只是程序名，不是聊天记录）
    ("filestorage", "聊天软件的「接收文件」目录"),
    ("msg", "聊天记录相关"),
    ("message", "聊天记录相关"),
    ("history", "历史记录"),
    ("account", "账号信息"),
    ("credential", "凭据"),
    ("token", "令牌/登录态"),
    ("login", "登录信息"),
    ("profile", "用户配置"),
    ("database", "数据库"),
    ("contact", "联系人"),
    ("favorite", "收藏"),
    ("bookmark", "书签"),
    ("saved", "已保存内容"),
    ("document", "文档"),
    ("photo", "照片"),
    ("video", "视频"),
    ("image", "图片"),
    ("voice", "语音"),
    ("attachment", "附件"),
    ("license", "授权信息"),
    ("activation", "激活信息"),
]

# 需要“整词”匹配的短关键字：前后不能紧邻字母数字
WORD_BOUNDED_HINTS = [
    ("chat", "聊天记录相关"),
    ("im", "即时通讯数据"),
    ("db", "数据库文件"),
    ("key", "密钥/凭据"),
    ("bak", "备份"),
    ("data", "数据"),
]

# 明显是程序名/组件名，即使含危险关键字也忽略
BENIGN_COMPONENT_HINTS = [
    "wechatutility", "wechatocr", "wechatplayer", "wechatwin", "wechatapp",
    "thumbplayer", "xplugin", "radium", "wechatocr",
]


def _is_benign_component(rel_low: str) -> bool:
    return any(b in rel_low for b in BENIGN_COMPONENT_HINTS)


def _word_bounded(kw: str, rel_low: str) -> bool:
    """kw 必须以“整词”出现：前后不能是字母或数字。"""
    start = 0
    while True:
        i = rel_low.find(kw, start)
        if i < 0:
            return False
        before = rel_low[i - 1] if i > 0 else ""
        after = rel_low[i + len(kw)] if i + len(kw) < len(rel_low) else ""
        if not (before.isalnum()) and not (after.isalnum()):
            return True
        start = i + 1

SAFE_EXT = {".log", ".tmp", ".temp", ".etl", ".dmp", ".old", ".cache", ".crdownload", ".part"}
SAFE_NAME_HINTS = [
    ("thumbcache", "缩略图缓存"),
    ("cache", "缓存"),
    ("temp", "临时文件"),
    ("updater", "更新器目录（需确认是否为已下载安装包）"),
    ("update", "更新包"),
    ("crashpad", "崩溃转储"),
    ("logs", "日志"),
    ("dump", "转储"),
]

INSTALLER_EXT = {".exe", ".msi", ".nupkg", ".msix", ".appx", ".cab", ".delta"}


def human(n: float) -> str:
    n = float(n)
    for unit, div in (("GB", 1024 ** 3), ("MB", 1024 ** 2), ("KB", 1024)):
        if abs(n) >= div:
            return f"{n / div:.2f} {unit}"
    return f"{int(n)} B"


def use_utf8_output() -> None:
    """
    让本脚本的 print() 走 UTF-8。

    本脚本会打印 ✅/⚠️/❌ 和中文，而 Windows 控制台默认是 GBK/CP936，
    直接跑会抛 UnicodeEncodeError（重定向到管道时则会变成乱码）。
    这里只改编码，不改任何输出内容。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def scan(root: str) -> dict:
    """只读遍历一个目录。"""
    info = {
        "root": root, "exists": os.path.isdir(root), "n_files": 0, "n_dirs": 0,
        "total": 0, "by_ext": defaultdict(lambda: [0, 0]),
        "by_topdir": defaultdict(lambda: [0, 0]),
        "largest": [], "newest": [], "danger_hits": [], "warn_hits": [], "safe_hits": [],
        "errors": 0,
    }
    if not info["exists"]:
        return info

    root_norm = os.path.normcase(os.path.abspath(root))
    for dirpath, dirnames, filenames in os.walk(root, onerror=lambda e: info.update(errors=info["errors"] + 1)):
        info["n_dirs"] += len(dirnames)
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                st = os.stat(fp)
            except OSError:
                info["errors"] += 1
                continue
            size = st.st_size
            info["n_files"] += 1
            info["total"] += size
            ext = os.path.splitext(fn)[1].lower()
            info["by_ext"][ext][0] += 1
            info["by_ext"][ext][1] += size

            # 顶层子目录聚合
            rel = os.path.relpath(dirpath, root)
            top = rel.split(os.sep)[0] if rel != "." else "(直属文件)"
            info["by_topdir"][top][0] += 1
            info["by_topdir"][top][1] += size

            info["largest"].append((size, st.st_mtime, fp))
            info["newest"].append((st.st_mtime, size, fp))

            # 危险特征判定
            low = fn.lower()
            rel_low = os.path.relpath(fp, root).lower()
            benign = _is_benign_component(rel_low)
            if ext in DANGER_EXT and not benign:
                info["danger_hits"].append((ext, size, rel_low, f"扩展名 {ext}"))
            if not benign:
                hit = None
                for kw, why in DANGER_NAME_HINTS:
                    if kw in rel_low:
                        hit = (kw, why)
                        break
                if hit is None:
                    for kw, why in WORD_BOUNDED_HINTS:
                        if _word_bounded(kw, rel_low):
                            hit = (kw, why)
                            break
                if hit:
                    info["danger_hits"].append((hit[0], size, rel_low, hit[1]))
            if ext in INSTALLER_EXT:
                info["warn_hits"].append((ext, size, rel_low, "安装包/可执行文件（可能是运行中的程序）"))
            elif ext in SAFE_EXT:
                info["safe_hits"].append((ext, size, rel_low, f"可再生的 {ext}"))
            for kw, why in SAFE_NAME_HINTS:
                if kw in rel_low:
                    info["safe_hits"].append((kw, size, rel_low, why))
                    break

    info["largest"].sort(reverse=True)
    info["newest"].sort(reverse=True)
    return info


def verdict(info: dict) -> tuple[str, str]:
    """按危险特征给结论。"""
    if not info["exists"]:
        return "n/a", "路径不存在"

    d_total = sum(s for _, s, _, _ in info["danger_hits"])
    w_total = sum(s for _, s, _, _ in info["warn_hits"])
    danger_kinds = {k for k, _, _, _ in info["danger_hits"]}

    if info["n_files"] == 0:
        return "✅ 安全", "空目录（或只有子目录），不含文件"

    if danger_kinds and d_total > 0.05 * max(info["total"], 1):
        kinds = "、".join(sorted(danger_kinds)[:5])
        return "❌ 不要动", f"含数据/凭据类文件（{kinds}），合计 {human(d_total)}"
    if danger_kinds:
        kinds = "、".join(sorted(danger_kinds)[:5])
        return "⚠️ 需确认", f"含少量数据类文件（{kinds}，{human(d_total)}），需人工确认用途"

    if info["n_files"] > 0 and w_total > 0.5 * info["total"]:
        return "⚠️ 需确认", f"主要是可执行/安装文件（{human(w_total)}），需确认是否为已下载的安装包"
    return "✅ 安全", "只含日志/缓存/临时文件等可再生内容"


def report(info: dict, top: int = 15) -> None:
    print("=" * 78)
    print(f"核实目标: {info['root']}")
    if not info["exists"]:
        print("  [路径不存在]")
        return
    print(f"  文件 {info['n_files']:,} 个 / 子目录 {info['n_dirs']:,} 个 / 合计 {human(info['total'])}")
    if info["errors"]:
        print(f"  (有 {info['errors']} 个对象无法读取，已跳过)")

    if info["by_ext"]:
        print("\n  ── 文件类型分布（按体积前 12）──")
        for ext, (cnt, size) in sorted(info["by_ext"].items(), key=lambda kv: -kv[1][1])[:12]:
            print(f"     {human(size):>12}  x{cnt:<7,} {ext or '(无扩展名)'}")

    if info["by_topdir"]:
        print("\n  ── 顶层子目录（按体积前 12）──")
        for name, (cnt, size) in sorted(info["by_topdir"].items(), key=lambda kv: -kv[1][1])[:12]:
            print(f"     {human(size):>12}  x{cnt:<7,} {name}")

    if info["largest"]:
        print(f"\n  ── 最大的 {min(top, len(info['largest']))} 个文件 ──")
        for size, mtime, fp in info["largest"][:top]:
            ts = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
            print(f"     {human(size):>12}  {ts}  {os.path.relpath(fp, info['root'])}")

    if info["danger_hits"]:
        d_tot = sum(s for _, s, _, _ in info["danger_hits"])
        pct = d_tot / max(info["total"], 1) * 100
        print(f"\n  ── 数据类特征（{len(info['danger_hits'])} 处，合计 {human(d_tot)}，占 {pct:.2f}%）──")
        agg: dict[str, list] = defaultdict(lambda: [0, 0, ""])
        for kw, size, rel, why in info["danger_hits"]:
            agg[kw][0] += 1
            agg[kw][1] += size
            agg[kw][2] = why
        for kw, (cnt, size, why) in sorted(agg.items(), key=lambda kv: -kv[1][1])[:12]:
            print(f"     {human(size):>12}  x{cnt:<6,} [{kw}] {why}")
        if pct < 1:
            print("     (占比很低：多为程序自带的配置/密钥文件，通常不是用户数据)")

    if info["warn_hits"]:
        agg = defaultdict(lambda: [0, 0, ""])
        for kw, size, rel, why in info["warn_hits"]:
            agg[kw][0] += 1
            agg[kw][1] += size
            agg[kw][2] = why
        print(f"\n  ── ⚠️ 需确认特征（{len(info['warn_hits'])} 处）──")
        for kw, (cnt, size, why) in sorted(agg.items(), key=lambda kv: -kv[1][1])[:10]:
            print(f"     {human(size):>12}  x{cnt:<6,} [{kw}] {why}")

    if info["safe_hits"]:
        agg = defaultdict(lambda: [0, 0, ""])
        for kw, size, rel, why in info["safe_hits"]:
            agg[kw][0] += 1
            agg[kw][1] += size
            agg[kw][2] = why
        print(f"\n  ── ✅ 可再生内容（{len(info['safe_hits'])} 处）──")
        for kw, (cnt, size, why) in sorted(agg.items(), key=lambda kv: -kv[1][1])[:8]:
            print(f"     {human(size):>12}  x{cnt:<6,} [{kw}] {why}")

    lvl, why = verdict(info)
    print(f"\n  >>> 结论: {lvl}  —— {why}")
    print()


def summarize(info: dict) -> dict:
    """把一个目录的扫描结果压成结构化摘要（供工具 / --json 使用）。"""
    lvl, why = verdict(info)
    by_ext = sorted(info["by_ext"].items(), key=lambda kv: -kv[1][1])[:12]
    by_top = sorted(info["by_topdir"].items(), key=lambda kv: -kv[1][1])[:12]
    return {
        "path": info["root"],
        "exists": bool(info["exists"]),
        "level": lvl,
        "reason": why,
        "bytes": int(info["total"]),
        "files": int(info["n_files"]),
        "dirs": int(info["n_dirs"]),
        "errors": int(info["errors"]),
        "byExt": [{"ext": ext or "(无扩展名)", "count": int(cnt), "bytes": int(size)}
                  for ext, (cnt, size) in by_ext],
        "byTopDir": [{"name": name, "count": int(cnt), "bytes": int(size)}
                     for name, (cnt, size) in by_top],
        "dangerKinds": sorted({kw for kw, _, _, _ in info["danger_hits"]})[:12],
        "dangerBytes": int(sum(s for _, s, _, _ in info["danger_hits"])),
        "warnCount": len(info["warn_hits"]),
        "safeCount": len(info["safe_hits"]),
        "largest": [
            {"path": fp, "bytes": int(size), "mtime": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")}
            for size, mtime, fp in info["largest"][:15]
        ],
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="删除建议核实器（只读；不删除、不修改任何文件）")
    ap.add_argument("paths", nargs="+", help="要核实的目录（一个或多个）")
    ap.add_argument("--top", type=int, default=15, help="每个目录列出多少个最大文件")
    ap.add_argument("--quiet", action="store_true", help="只输出结论")
    ap.add_argument("--json", action="store_true", help="最后一行打印结构化 JSON（供工具调用）")
    args = ap.parse_args(argv)

    use_utf8_output()

    if args.json:
        print("注意：本脚本**只读**，不会删除或修改任何文件。\n")
        results = [scan(p) for p in args.paths]
        summaries = [summarize(info) for info in results]
        for info in results:
            report(info, args.top)
        if len(summaries) > 1:
            print("=" * 78)
            print("汇总")
            print("=" * 78)
            for item in summaries:
                print(f"  {item['level']:<10} {human(item['bytes']):>12}  {item['path']}")
                print(f"             └─ {item['reason']}")
        print(json.dumps({"ok": True, "results": summaries}, ensure_ascii=False))
        return 0

    print("注意：本脚本**只读**，不会删除或修改任何文件。\n")
    results = []
    for p in args.paths:
        info = scan(p)
        results.append(info)
        if args.quiet:
            lvl, why = verdict(info)
            print(f"{lvl:<10} {human(info['total']):>12}  {p}")
            print(f"           └─ {why}")
        else:
            report(info, args.top)

    if not args.quiet and len(results) > 1:
        print("=" * 78)
        print("汇总")
        print("=" * 78)
        for info in results:
            lvl, why = verdict(info)
            print(f"  {lvl:<10} {human(info['total']):>12}  {info['root']}")
            print(f"             └─ {why}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
