#!/usr/bin/env python3
"""扫描 plugins/ 生成 registry.json。

sha256 口径（宿主安装时按同样算法校验）：
    对目录下所有文件按相对路径排序，逐个把
    "相对路径 + b'\0' + 文件sha256 + b'\n'" 喂进外层 sha256。
这样改任何一个字节、增删任何一个文件都会变。
文件内容先做 CRLF → LF 归一，否则同一个提交在 Windows / Linux 上会算出两个值。
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGINS = ROOT / "plugins"
REGISTRY = ROOT / "registry.json"
RAW_BASE = "https://cdn.jsdelivr.net/gh/publieople/onefeed-plugins@main/plugins/"


def dir_digest(path: Path) -> str:
    outer = hashlib.sha256()
    files = sorted(p for p in path.rglob("*") if p.is_file())
    for f in files:
        rel = f.relative_to(path).as_posix()
        blob = f.read_bytes().replace(b"\r\n", b"\n")
        inner = hashlib.sha256(blob).hexdigest()
        outer.update(rel.encode("utf-8"))
        outer.update(b"\0")
        outer.update(inner.encode("ascii"))
        outer.update(b"\n")
    return outer.hexdigest()


def main(argv: list[str]) -> int:
    if not PLUGINS.is_dir():
        print(f"找不到插件目录: {PLUGINS}")
        return 1
    plugins = []
    for plugin_dir in sorted(p for p in PLUGINS.iterdir() if p.is_dir()):
        mf = plugin_dir / "plugin.json"
        if not mf.is_file():
            print(f"[skip] {plugin_dir.name}: 没有 plugin.json")
            continue
        data = json.loads(mf.read_text(encoding="utf-8"))
        plugins.append({
            "id": data["id"],
            "name": data["name"],
            "version": data["version"],
            "description": data.get("description", ""),
            "author": data.get("author", ""),
            "license": data.get("license", ""),
            "kinds": data.get("kinds", []),
            "capabilities": data.get("capabilities", []),
            "features": data.get("features", []),
            "feeds": [f.get("id") for f in data.get("feeds", [])],
            "download": RAW_BASE + data["id"] + "/",
            "sha256": dir_digest(plugin_dir),
        })
    registry = {
        "schemaVersion": 1,
        "name": "OneFeed 官方示例插件集",
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "plugins": plugins,
    }
    REGISTRY.write_text(json.dumps(registry, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"写入 {REGISTRY.name}: {len(plugins)} 个插件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))