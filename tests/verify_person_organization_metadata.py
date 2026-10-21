import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import io
from PIL import Image
from fetch_person_organization_metadata import fetch_group
from backfill_javdb_metadata import JavDbMeta

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

group["code"] = "FC2-PPV-1234567"
fetches = []
fresh = JavDbMeta(code="FC2-PPV-1234567", title="FC2-PPV-1234567 Synthetic updated title",
                  detail_url="https://javdb.com/v/fresh", image_url="https://c0.jdbstatic.com/covers/fresh.jpg",
                  release_date="2026-10-16", rating=4.5, rating_count=123)


def fetch_meta(code, detail_url):
    fetches.append((code, detail_url))
    return fresh


result, cover = fetch_group(group, None, download, fetch_meta)
assert cover and not result["metadataError"]
assert "2026-10-16" in result["rawText"] and fresh.title in result["rawText"]
assert result["imageUrl"] == fresh.image_url and calls[-1] == (fresh.image_url, fresh.detail_url)
assert fetches == [(group["code"], group["detailUrl"])]

result, cover = fetch_group(group, None, failure, fetch_meta)
assert not cover and not result["metadataError"] and result["coverError"]
assert fresh.title in result["rawText"], "cover failure must not discard a successful metadata refresh"

result, cover = fetch_group(group, None, download, lambda *args: None)
assert not cover and "完全匹配" in result["metadataError"]
assert result["rawText"] == group["metadata"]["rawText"]

wrong = JavDbMeta(code="FC2-PPV-123456", title="Wrong", detail_url="https://javdb.com/v/wrong", image_url=fresh.image_url)
fetches.clear()


def stale_detail(code, detail_url):
    fetches.append((code, detail_url))
    return wrong if detail_url else fresh


result, cover = fetch_group(group, None, download, stale_detail)
assert cover and not result["metadataError"]
assert fetches == [(group["code"], group["detailUrl"]), (group["code"], "")]
result, cover = fetch_group(group, None, download, lambda *args: wrong)
assert not cover and "完全匹配" in result["metadataError"]
result, cover = fetch_group(group, None, download, failure)
assert not cover and "synthetic network failure" in result["metadataError"]
group["metadata"]["imageUrl"] = "https://c0.jdbstatic.com/covers/old.jpg"
result, cover = fetch_group(group, None, download, failure)
assert cover and result["metadataError"], "a failed refresh may still restore the stored cover without reporting metadata success"
group["catalogueRefreshed"] = True
result, cover = fetch_group(group, None, download, failure)
assert cover and not result["metadataError"], "fresh exact actor-card facts do not require a second logged-in detail request"
print("person-organization-metadata: exact FC2 refresh, new URLs, stale links, mismatches, failed metadata/cover and stored-cover fallback passed (no network or browser)")
