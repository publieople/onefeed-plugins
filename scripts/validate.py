#!/usr/bin/env python3
"""校验 plugins/ 下每个插件的 manifest 与入口文件。

规则与宿主 plugin_runtime/manifest.py 保持一致（宿主侧是最终裁判，这里只是提交前自检）。
用法：
    python scripts/validate.py            # 校验全部
    python scripts/validate.py bilibili   # 只校验一个
出错时退出码 1，CI 里可直接当门禁。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
SCHEMA_VERSION = 1
CAPABILITIES = {"http", "browser", "cli"}
KINDS = {"video", "images", "article", "short", "list"}
FEATURES = {"comments", "detail", "media", "summary"}
EMBED_PROVIDERS = {"bilibili", "douyin"}
HOST_RE = re.compile(r"^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+$")
MAX_ENTRY_BYTES = 200 * 1024


def check_manifest(plugin_dir: Path) -> list[str]:
    errs: list[str] = []

    def bad(msg: str) -> None:
        errs.append(msg)

    mf = plugin_dir / "plugin.json"
    if not mf.is_file():
        return ["缺少 plugin.json"]
    try:
        data = json.loads(mf.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return [f"plugin.json 不是合法 JSON: {exc}"]

    if data.get("schemaVersion") != SCHEMA_VERSION:
        bad(f"schemaVersion 必须是 {SCHEMA_VERSION}")
    pid = data.get("id")
    if not isinstance(pid, str) or not ID_RE.match(pid):
        bad("id 必须是 2-32 位小写字母/数字/连字符，且以字母开头")
    elif pid != plugin_dir.name:
        bad(f"id（{pid}）必须与目录名（{plugin_dir.name}）一致")
    if not str(data.get("name") or "").strip():
        bad("缺少 name")
    for key in ("version", "minHostVersion"):
        val = data.get(key)
        if not isinstance(val, str) or not SEMVER_RE.match(val):
            bad(f"{key} 必须是 x.y.z")

    entry = data.get("entry") or "index.js"
    entry_path = plugin_dir / entry
    if not entry_path.is_file():
        bad(f"entry 指向的 {entry} 不存在")
    elif entry_path.stat().st_size > MAX_ENTRY_BYTES:
        bad(f"{entry} 超过 {MAX_ENTRY_BYTES // 1024}KB，请拆分或压缩")
    else:
        code = entry_path.read_text(encoding="utf-8", errors="replace")
        if "module.exports" not in code:
            bad(f"{entry} 必须用 module.exports 导出插件对象")

    caps = data.get("capabilities")
    if not isinstance(caps, list) or not caps:
        bad("capabilities 必须是非空数组")
    else:
        unknown = [c for c in caps if c not in CAPABILITIES]
        if unknown:
            bad(f"未知能力: {unknown}")
        if "cli" in caps:
            allow = (data.get("cli") or {}).get("allow")
            if not isinstance(allow, list) or not allow:
                bad("声明 cli 能力时必须有 cli.allow（命令白名单）")
            else:
                for rule in allow:
                    if (not isinstance(rule, list) or not rule
                            or not all(isinstance(x, str) and x for x in rule)):
                        bad(f"cli.allow 每条必须是字符串数组: {rule!r}")

    kinds = data.get("kinds")
    if not isinstance(kinds, list) or not kinds:
        bad("kinds 必须是非空数组")
    else:
        unknown = [k for k in kinds if k not in KINDS]
        if unknown:
            bad(f"未知 kind: {unknown}")

    feeds = data.get("feeds")
    if not isinstance(feeds, list) or not feeds:
        bad("feeds 必须是非空数组")
    else:
        seen = set()
        for feed in feeds:
            if not isinstance(feed, dict):
                bad(f"feeds 项必须是对象: {feed!r}")
                continue
            fid = feed.get("id")
            if not isinstance(fid, str) or not fid:
                bad(f"feed 缺少 id: {feed!r}")
            elif fid in seen:
                bad(f"feed id 重复: {fid}")
            else:
                seen.add(fid)
            if not str(feed.get("name") or "").strip():
                bad(f"feed {fid} 缺少 name")

    features = data.get("features")
    if features is not None:
        if not isinstance(features, list):
            bad("features 必须是数组")
        else:
            unknown = [f for f in features if f not in FEATURES]
            if unknown:
                bad(f"未知 feature: {unknown}（可选 {sorted(FEATURES)}）")
            if "media" in features and "detail" not in features:
                bad("声明了 media 就要同时声明 detail：媒体地址只能从详情里来")

    embeds = data.get("embeds")
    if embeds is not None:
        if not isinstance(embeds, list):
            bad("embeds 必须是数组")
        else:
            unknown = [e for e in embeds if e not in EMBED_PROVIDERS]
            if unknown:
                bad(f"未知 embed 提供方: {unknown}（可选 {sorted(EMBED_PROVIDERS)}）")

    hosts = data.get("mediaHosts")
    if hosts is not None:
        if not isinstance(hosts, list):
            bad("mediaHosts 必须是数组")
        else:
            for h in hosts:
                if not isinstance(h, str) or not HOST_RE.match(h.lower()):
                    bad(f"mediaHosts 每项必须是不带协议的域名（可带 *. 前缀）: {h!r}")

    settings = data.get("settings")
    if settings is not None and not isinstance(settings, list):
        bad("settings 必须是数组")
    return errs


def main(argv: list[str]) -> int:
    if not PLUGINS.is_dir():
        print(f"找不到插件目录: {PLUGINS}")
        return 1
    targets = argv or sorted(p.name for p in PLUGINS.iterdir() if p.is_dir())
    failed = 0
    for name in targets:
        plugin_dir = PLUGINS / name
        if not plugin_dir.is_dir():
            print(f"[skip] {name}: 目录不存在")
            failed += 1
            continue
        errs = check_manifest(plugin_dir)
        if errs:
            failed += 1
            print(f"[FAIL] {name}")
            for e in errs:
                print(f"       - {e}")
        else:
            print(f"[ ok ] {name}")
    print(f"\n{len(targets) - failed}/{len(targets)} 个插件通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
