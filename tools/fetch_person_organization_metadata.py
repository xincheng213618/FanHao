"""Refresh exact catalogue metadata, then download its cover for organization."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path
from types import SimpleNamespace
import time
from urllib.parse import urlparse

import requests
from PIL import Image
from remote_image_cache import download_remote_image
from backfill_javdb_metadata import (
    AccessBlockedError, DEFAULT_CHROME_BINARY, DEFAULT_SCRAPER_CONFIG_PATH,
    JavDbClient, load_scraper_config, render_raw_text,
)
from code_parser import loose_code_key


def fetch_group(group, session, download=download_remote_image, fetch_metadata=None):
    metadata = group["metadata"]
    result = {"rawText": metadata["rawText"], "imageUrl": metadata["imageUrl"],
              "detailUrl": group.get("detailUrl", ""), "metadataError": "", "coverError": ""}
    # The full actor scan already refreshed these exact work identities and URLs.
    # Reuse its card facts; some detail/search pages require a separate login.
    if fetch_metadata is not None and not (group.get("catalogueRefreshed") and result["imageUrl"] and result["detailUrl"]):
        try:
            detail_url = result["detailUrl"]
            if detail_url and (urlparse(detail_url).scheme != "https" or urlparse(detail_url).hostname != "javdb.com"):
                raise RuntimeError("作品详情地址不是有效的 JavDB 地址")
            meta = fetch_metadata(group["code"], detail_url)
            # A stale link or fuzzy search must never change a work's identity.
            if meta and loose_code_key(meta.code) != loose_code_key(group["code"]) and detail_url:
                meta = fetch_metadata(group["code"], "")
            if not meta or loose_code_key(meta.code) != loose_code_key(group["code"]):
                raise RuntimeError("JavDB 未找到完全匹配的番号，已保留原资料")
            if not meta.title or (meta.title == meta.code and not meta.image_url):
                raise RuntimeError("JavDB 未返回有效作品资料，已保留原资料")
            result.update(rawText=render_raw_text(meta), imageUrl=meta.image_url or metadata["imageUrl"],
                          detailUrl=meta.detail_url)
        except Exception as error:
            result["metadataError"] = str(error)
    cover = b""
    try:
        if not result["imageUrl"]:
            raise RuntimeError("数据库没有封面地址，已保留原封面")
        data, _ = download(result["imageUrl"], session=session, referer=result["detailUrl"] or "https://javdb.com/", timeout=30)
        with Image.open(io.BytesIO(data)) as image:
            output = io.BytesIO()
            image.convert("RGB").save(output, format="JPEG", quality=95)
            cover = output.getvalue()
    except Exception as error:
        result["coverError"] = str(error)
    return result, cover


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    plan = json.loads(options.plan.read_text(encoding="utf-8"))
    options.output.mkdir(parents=True, exist_ok=True)
    args = SimpleNamespace(profile_dir=(Path("data/selenium-person-organization-profile") / str(plan["personId"])).resolve(),
                           chrome_binary=DEFAULT_CHROME_BINARY, driver_path=None,
                           proxy="http://127.0.0.1:10809", no_proxy=False, headless=True,
                           search_wait_seconds=25, detail_wait_seconds=35,
                           scraper_config_data=load_scraper_config(DEFAULT_SCRAPER_CONFIG_PATH))
    client = JavDbClient(args)
    unavailable = ""

    def fetch_metadata(code, detail_url):
        nonlocal unavailable
        if unavailable:
            raise RuntimeError(unavailable)
        try:
            return client.fetch_by_code(code, detail_url)
        except Exception as error:
            if isinstance(error, AccessBlockedError) or client.driver is None:
                unavailable = str(error)
            raise

    try:
        with requests.Session() as session:
            for index, group in enumerate(plan["groups"], 1):
                if group.get("metadataDone"):
                    continue
                cover_path = options.output / f'{group["localWorkId"]}.jpg'
                cover_path.unlink(missing_ok=True)
                result, cover = fetch_group(group, session, fetch_metadata=fetch_metadata)
                if cover:
                    cover_path.write_bytes(cover)
                (options.output / f'{group["localWorkId"]}.json').write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                print(f'[{index}/{len(plan["groups"])}] {group["code"]} 资料 {"已更新" if not result["metadataError"] else "失败: " + result["metadataError"]} · 封面 {"已下载" if cover else "失败: " + result["coverError"]}', flush=True)
                if not unavailable:
                    time.sleep(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
