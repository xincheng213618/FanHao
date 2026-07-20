# FanHao integration provenance

This downloader is embedded in FanHao's short-video download manager and is
the authoritative runtime copy for FanHao.

- Upstream repository: https://github.com/jiji262/douyin-downloader.git
- Upstream baseline: `ef3ad18c2b50e38e534f72aabe2b3fbb0b3fadd7`
- Imported local source commit: `a50dce65343e39eafcde3cb8268b4cb0509550f8`
- Import date: 2026-07-20

The import copied only files tracked by the source repository. It deliberately
excluded the source repository's `.git` directory, virtual environment,
cookies, local configuration, databases, logs, caches, and downloaded media.

At import time, the local source worktree also contained an explicit
`highest_resolution` / `max_resolution` compatibility alias and its tests in
`core/downloader_base.py` and `tests/test_media_quality.py`. Those changes are
part of FanHao's embedded version.

Future upstream updates should be reviewed and applied to this directory. The
FanHao runtime must not require the original sibling checkout to exist.
