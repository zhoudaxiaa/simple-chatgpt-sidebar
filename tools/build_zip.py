#!/usr/bin/env python3
"""把扩展打包成可上传 Chrome 商店的 zip，或一个干净的未打包目录。

只收运行期需要的文件（白名单），测试脚本和 tools/ 不进产物。
zip 的时间戳固定，保证同样内容重复打包得到一致的字节。

`chrome://extensions` 的「加载已解压的扩展程序」只认目录，不认 zip；
又想避开仓库里的测试文件，就 `--unpacked` 出一个只含白名单的目录。

用法：
    python tools/build_zip.py
    python tools/build_zip.py --out dist/package.zip
    python tools/build_zip.py --unpacked                 # 只出 dist/unpacked
    python tools/build_zip.py --unpacked --with-zip      # 目录 + zip 都要
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_version() -> str:
    """版本号只在 manifest.json 里维护，包名跟着它走。"""
    with (ROOT / "manifest.json").open(encoding="utf-8") as fh:
        return json.load(fh)["version"]


DEFAULT_OUT = ROOT / "dist" / f"simple-chatgpt-sidebar-{read_version()}.zip"

# 运行期文件白名单，顺序即包内顺序
FILES = [
    "manifest.json",
    "background.js",
    "session-bridge.js",
    "content.js",
    "chatgpt-inject.js",
    "sidepanel.html",
    "sidepanel.js",
    "options.html",
    "options.js",
    "options.css",
    "prompt-input.html",
    "prompt-input.js",
    "rules.json",
    "shared/defaults.js",
    "shared/template.js",
    "shared/page-info.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def write_zip(out: Path) -> None:
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for name in FILES:
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, (ROOT / name).read_bytes())


def write_unpacked(out: Path) -> None:
    """把白名单文件铺到 out/，清掉上一轮留下的多余文件。

    只允许往 dist/ 下面写，避免参数写错把仓库其他地方清空。
    """
    dist = (ROOT / "dist").resolve()
    if dist not in out.parents and out != dist:
        raise SystemExit(f"拒绝写入 {out}：未打包目录必须位于 {dist} 之内")

    if out.exists():
        for child in out.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    out.mkdir(parents=True, exist_ok=True)

    for name in FILES:
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())


def main() -> int:
    parser = argparse.ArgumentParser(description="打包扩展为 zip 或未打包目录")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="zip 输出路径")
    parser.add_argument(
        "--unpacked",
        nargs="?",
        const=str(ROOT / "dist" / "unpacked"),
        default=None,
        metavar="DIR",
        help="额外汇出未打包目录（默认 dist/unpacked），Chrome 可直接加载",
    )
    parser.add_argument(
        "--with-zip",
        action="store_true",
        help="配合 --unpacked 时同时生成 zip（默认只出目录）",
    )
    args = parser.parse_args()

    missing = [f for f in FILES if not (ROOT / f).is_file()]
    if missing:
        print("缺少文件：" + "、".join(missing), file=sys.stderr)
        return 1

    want_zip = args.unpacked is None or args.with_zip
    if want_zip:
        out = Path(args.out).resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        write_zip(out)
        print(f"{out}")
        print(f"{out.stat().st_size} 字节 / {len(FILES)} 个文件")

    if args.unpacked is not None:
        folder = Path(args.unpacked).resolve()
        write_unpacked(folder)
        print(f"{folder}")
        print(f"{len(FILES)} 个文件，可在 chrome://extensions 直接加载")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
