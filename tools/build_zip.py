#!/usr/bin/env python3
"""把扩展打包成可上传 Chrome 商店的 zip。

只打包运行期需要的文件（白名单），测试脚本和 tools/ 不进包。
时间戳固定，保证同样内容重复打包得到一致的字节。

用法：
    python tools/build_zip.py
    python tools/build_zip.py --out dist/package.zip
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "dist" / "simple-chatgpt-sidebar-1.0.0.zip"

# 运行期文件白名单，顺序即包内顺序
FILES = [
    "manifest.json",
    "background.js",
    "session-bridge.js",
    "content.js",
    "chatgpt-inject.js",
    "sidepanel.html",
    "sidepanel.js",
    "sidepanel.css",
    "options.html",
    "options.js",
    "options.css",
    "prompt-input.html",
    "prompt-input.js",
    "rules.json",
    "shared/defaults.js",
    "shared/template.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def main() -> int:
    parser = argparse.ArgumentParser(description="打包扩展为 zip")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出路径")
    args = parser.parse_args()
    out = Path(args.out).resolve()

    missing = [f for f in FILES if not (ROOT / f).is_file()]
    if missing:
        print("缺少文件：" + "、".join(missing), file=sys.stderr)
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in FILES:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (ROOT / name).read_bytes())

    print(f"{out}")
    print(f"{out.stat().st_size} 字节 / {len(FILES)} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
