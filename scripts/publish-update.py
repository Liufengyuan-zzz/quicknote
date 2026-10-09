#!/usr/bin/env python3
"""
publish-update.py — 生成 Tauri 自动更新清单 latest.json（交给 GitHub Release 托管）

为什么这么做：
  Tauri 更新器只认一个固定格式的 JSON：最新版本号 + 各平台下载地址 + 安装包签名。
  仓库公开之后，这个清单可以直接作为 Release 资产发布，客户端用「永久固定链接」取：
      https://github.com/<owner>/<repo>/releases/latest/download/latest.json
  于是不需要任何对象存储、也不需要令牌（公开仓库的 Release 资产可匿名下载）。

流程（CI 由 .github/workflows/build-packages.yml 调用）：
  1. 在产物目录里找出更新包并配对同名 .sig
       Windows → *-setup.exe   （NSIS 安装包，全公司统一用它，避免 MSI/NSIS 两份并存）
       macOS   → *.app.tar.gz  （原地替换 .app，dmg 只负责首次安装）
  2. 按本次 tag 拼出每个包的 Release 下载地址
  3. 写出 latest.json，随后由 Create Release 步骤与安装包一并上传

用法：
  # CI（推荐）：环境变量 GITHUB_REPOSITORY / GITHUB_REF_NAME 由 Actions 自动提供
  python scripts/publish-update.py --dir installers --out latest.json

  # 本地预览（不写文件，只打印）
  python scripts/publish-update.py --dir installers --dry-run

  # 手工发版（本地已构建出产物时）
  python scripts/publish-update.py --dir installers --tag v1.6.4 --repo Liufengyuan-zzz/quicknote
"""

import argparse
import json
import os
import plistlib
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

# 更新包后缀 → Tauri 平台标识
#   Windows **只认 NSIS 的 -setup.exe**：MSI 装的和 NSIS 装的会各自更新成另一种形态，
#   机器上会出现两份安装。所以不把 .msi 当备选 —— 只在它出现时给出明确报错。
PLATFORM_BY_SUFFIX = [
    ('-setup.exe', 'windows-x86_64'),
    ('.app.tar.gz', 'darwin-aarch64'),
]


def die(msg: str) -> None:
    """报错退出。

    GitHub Actions 只把 ``::error::`` 开头的行显示成运行页上的注解，
    否则失败原因只埋在整页日志里 —— 本项目就为此多花过一轮排查。
    注解不支持换行，因此把续行压成一行再输出；完整信息仍走 stderr。
    """
    lines = [l.strip() for l in msg.split('\n') if l.strip()]
    flat = lines[0] + (' ｜ ' + ' ｜ '.join(lines[1:]) if len(lines) > 1 else '')
    print(f'::error::{flat}')
    sys.exit(f'❌ {msg}')


def macos_bundle_version(targz: Path) -> str:
    """从 .app.tar.gz 内部读出 CFBundleShortVersionString。

    为什么需要这个函数：macOS 更新包的名字固定是 ``<productName>.app.tar.gz``，
    **天生不含版本号**（Tauri 官方约定），所以「文件名里必须有本次版本号」这条防呆
    对 macOS 不成立 —— 这正是 v1.6.3 第一次发版时发布步骤失败的原因。
    直接读包内 Info.plist 反而比看文件名更硬：它证明的是真正打进包里的版本。
    """
    try:
        with tarfile.open(targz, 'r:gz') as tf:
            for member in tf.getmembers():
                if member.isfile() and member.name.endswith('Contents/Info.plist'):
                    fh = tf.extractfile(member)
                    if fh is None:
                        continue
                    info = plistlib.loads(fh.read())
                    ver = info.get('CFBundleShortVersionString') or ''
                    if ver:
                        return str(ver)
    except Exception:
        # 读不出来不算错，交给调用方降级处理（见下）
        pass
    return ''


def find_updater_artifacts(root: Path, version: str):
    """挑出更新包并配对签名。

    三层校验，每一层都对应一种「构建成功但用户更新不了/更新错」的真实故障：
      1. 同平台出现多个候选 → 报错。产物目录里混进历史版本时，盲目取第一个会发出旧包。
      2. 版本号对不上 → 报错。三处版本号（package.json / Cargo.toml /
         tauri.conf.json）不一致是常见失误，会导致清单版本与实际包不符。
         ⚠️ 核验方式分平台：Windows 看文件名（含版本）；macOS 包名**不含版本**，
         改读包内 Info.plist —— 别一刀切按文件名判，那会把正常的 macOS 包判死。
      3. 缺同名 .sig → 报错。Tauri 在没有签名私钥时是**静默跳过**签名的。
    """
    found = {}
    for suffix, platform in PLATFORM_BY_SUFFIX:
        if platform in found:
            continue

        cands = [p for p in sorted(root.rglob('*' + suffix))
                 if p.is_file() and not p.name.endswith('.sig')]
        if not cands:
            if suffix == '-setup.exe' and list(root.rglob('*.msi')):
                die('只找到了 .msi，没有 NSIS 的 *-setup.exe。\n'
                    '   Windows 更新包必须用 NSIS 安装包 —— 用 MSI 当更新源会让\n'
                    '   「MSI 装的机器」被更新成 NSIS 版，机器上出现两份安装。\n'
                    '   请确认 tauri 构建配置里包含 nsis target。')
            continue

        if len(cands) > 1:
            die(f'{platform} 找到多个更新包，无法确定用哪个：\n  '
                + '\n  '.join(str(c) for c in cands)
                + '\n   发布目录里应只含本次构建的产物（不要堆积历史版本）。')

        path = cands[0]

        # ---- 版本号核验（分平台）----
        if suffix == '.app.tar.gz':
            inner = macos_bundle_version(path)
            if inner and inner != version:
                die(f'{platform} 更新包内版本号与配置不一致：\n'
                    f'   包内 Info.plist:      {inner}\n'
                    f'   tauri.conf.json 版本: {version}\n'
                    f'   （package.json / Cargo.toml / tauri.conf.json 三处必须一致）')
            if inner:
                print(f'   ℹ️ {path.name} 包内版本 = {inner}'
                      f'（macOS 包名不含版本号，属官方约定，改从包内校验）')
            else:
                print(f'   ⚠️ {path.name} 未能读出版本号，本项校验跳过（构建与签名校验仍有效）')
        elif version not in path.name:
            die(f'{platform} 更新包文件名与版本号不一致：\n'
                f'   产物名:              {path.name}\n'
                f'   tauri.conf.json 版本: {version}\n'
                f'   （package.json / Cargo.toml / tauri.conf.json 三处必须一致）')

        sig = path.with_name(path.name + '.sig')
        if not sig.exists():
            die(f'更新包缺少签名文件：{sig}\n'
                f'   TAURI_SIGNING_PRIVATE_KEY / _PASSWORD 是否配置正确？')
        found[platform] = (path, sig.read_text(encoding='utf-8').strip())
    return found


def read_version(repo_root: Path) -> str:
    """版本号以 tauri.conf.json 为唯一来源（它也会写进 App 元数据）。"""
    conf = json.loads((repo_root / 'src-tauri' / 'tauri.conf.json').read_text(encoding='utf-8'))
    return conf['version']


def verify_endpoint(repo_root: Path, repo: str, dry_run: bool) -> None:
    """确认「App 里编译进去的更新地址」与「本次发布位置」一致。

    这两个值一个写在 tauri.conf.json、一个来自 CI 环境，很容易只改一边；
    后果是客户端一直去查旧地址 —— 表现为「怎么发新版都不提示更新」，且极难排查。
    """
    conf = json.loads((repo_root / 'src-tauri' / 'tauri.conf.json').read_text(encoding='utf-8'))
    endpoints = (conf.get('plugins', {}).get('updater', {}) or {}).get('endpoints', [])
    if not endpoints:
        die('tauri.conf.json 缺少 plugins.updater.endpoints，客户端不知道去哪查更新')

    expected = f'https://github.com/{repo}/releases/latest/download/latest.json'
    actual = endpoints[0]
    print(f'🔗 App 内更新地址：{actual}')
    if actual == expected:
        print('✅ 与本次发布位置一致')
        return

    detail = (f'更新地址不一致：\n'
              f'  App 内（tauri.conf.json）: {actual}\n'
              f'  本次发布位置:            {expected}')
    if dry_run:
        print(f'⚠️  {detail}\n   （dry-run 忽略；正式发版前必须一致）')
    else:
        die(detail)


def build_manifest(artifacts, version, repo, tag, notes):
    base = f'https://github.com/{repo}/releases/download/{tag}'
    platforms = {
        platform: {
            'signature': signature,
            'url': f'{base}/{path.name}',
        }
        for platform, (path, signature) in artifacts.items()
    }
    manifest = {
        'version': version,
        'pub_date': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'platforms': platforms,
    }
    # notes 是可选项。刻意留空而不是填 tag 名：App 的更新提示条会另起一段显示它，
    # 填 tag 的话就成了「发现新版本 v1.6.3 · v1.6.3」这种重复。
    # 需要时在 CI 用 --notes 显式传入。
    if notes:
        manifest['notes'] = notes
    return manifest


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='installers', help='打包产物所在目录')
    ap.add_argument('--repo-root', default='.', help='仓库根目录（读 tauri.conf.json 用）')
    ap.add_argument('--repo', default=os.environ.get('GITHUB_REPOSITORY', ''),
                    help='owner/repo，默认取环境变量 GITHUB_REPOSITORY')
    ap.add_argument('--tag', default=os.environ.get('GITHUB_REF_NAME', ''),
                    help='本次发布的 tag（如 v1.6.3），默认取环境变量 GITHUB_REF_NAME')
    ap.add_argument('--out', default='latest.json', help='清单输出路径')
    ap.add_argument('--notes', default='', help='更新说明（可选；留空则清单不含 notes 字段）')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不写文件')
    args = ap.parse_args()

    root = Path(args.dir)
    if not root.is_dir():
        die(f'产物目录不存在：{root}')
    if not args.repo:
        die('缺少 --repo（或环境变量 GITHUB_REPOSITORY）')
    if not args.tag:
        die('缺少 --tag（或环境变量 GITHUB_REF_NAME）——需要它拼出安装包的下载地址')

    version = read_version(Path(args.repo_root))
    artifacts = find_updater_artifacts(root, version)
    if not artifacts:
        die('没有找到任何更新包（*-setup.exe / *.app.tar.gz）。\n'
            '   检查 tauri.conf.json 的 bundle.createUpdaterArtifacts 是否为 true。')

    verify_endpoint(Path(args.repo_root), args.repo, args.dry_run)

    manifest = build_manifest(artifacts, version, args.repo, args.tag, args.notes)
    print(f'📦 版本 {version}（tag {args.tag}），平台：{", ".join(manifest["platforms"])}')
    text = json.dumps(manifest, ensure_ascii=False, indent=2)
    print(text)

    if args.dry_run:
        print('\n[dry-run] 未写文件。将随 Release 一起上传的产物：')
        for f in sorted(p for p in root.rglob('*') if p.is_file()):
            print('  -', f.name)
        return

    out = Path(args.out)
    out.write_text(text + '\n', encoding='utf-8')
    print(f'\n✅ 已写出 {out}（下一步由 Create Release 与安装包一并上传）')


if __name__ == '__main__':
    main()
