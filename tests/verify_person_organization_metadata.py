import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import io
from PIL import Image
from fetch_person_organization_metadata import fetch_group

data = io.BytesIO()
Image.new("RGB", (4, 4), "blue").save(data, format="PNG")
group = {"detailUrl": "https://javdb.com/v/synthetic", "metadata": {
    "rawText": "番号: ABC-123\n标题: Synthetic", "imageUrl": "https://c0.jdbstatic.com/covers/synthetic.jpg"}}
calls = []


def download(url, **kwargs):
    calls.append((url, kwargs["referer"]))
    return data.getvalue(), "image/png"


result, cover = fetch_group(group, None, download)
assert result["rawText"] == group["metadata"]["rawText"]
assert result["coverError"] == ""
assert calls == [(group["metadata"]["imageUrl"], group["detailUrl"])]
with Image.open(io.BytesIO(cover)) as image:
    assert image.format == "JPEG"


def failure(*args, **kwargs):
    raise RuntimeError("synthetic network failure")


result, cover = fetch_group(group, None, failure)
assert not cover
assert "synthetic network failure" in result["coverError"]
assert result["rawText"] == group["metadata"]["rawText"]
group["metadata"]["imageUrl"] = ""
result, cover = fetch_group(group, None, download)
assert not cover and "没有封面地址" in result["coverError"]
assert len(calls) == 1
print("person-organization-metadata: stored URLs and info, validated JPEG conversion, download failure and absent URL passed (no network or browser)")
