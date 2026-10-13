"""Download covers from catalogue URLs. Info comes from the existing record."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

import requests
from PIL import Image
from remote_image_cache import download_remote_image


def fetch_group(group, session, download=download_remote_image):
    metadata = group["metadata"]
    result = {"rawText": metadata["rawText"], "imageUrl": metadata["imageUrl"], "coverError": ""}
    cover = b""
    try:
        if not metadata["imageUrl"]:
            raise RuntimeError("数据库没有封面地址，已保留原封面")
        data, _ = download(metadata["imageUrl"], session=session, referer=group.get("detailUrl") or "https://javdb.com/", timeout=30)
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
    with requests.Session() as session:
        for index, group in enumerate(plan["groups"], 1):
            if group.get("metadataDone"):
                continue
            result, cover = fetch_group(group, session)
            if cover:
                (options.output / f'{group["localWorkId"]}.jpg').write_bytes(cover)
            (options.output / f'{group["localWorkId"]}.json').write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            print(f'[{index}/{len(plan["groups"])}] {group["code"]} info 使用数据库记录 · 封面 {"已下载" if cover else "失败: " + result["coverError"]}', flush=True)


if __name__ == "__main__":
    main()
