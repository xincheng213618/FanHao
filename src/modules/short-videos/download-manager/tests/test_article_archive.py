from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

MODULE_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MODULE_DIR))

from manager_core.common import work_id_from_url, work_kind
from manager_core.domain_manifest import kind_from_manifest, manifest_preview_path
from manager_core.media_quality import validate_downloaded_video_quality
try:
    from .test_runtime_characterization import IsolatedManager
except ImportError:
    from test_runtime_characterization import IsolatedManager


class ArticleArchiveTests(unittest.TestCase):
    def test_article_quality_uses_document_not_video_probe(self):
        with tempfile.TemporaryDirectory(prefix="fanhao-article-quality-") as temp:
            document = Path(temp) / "fixture.html"
            document.write_text("<h1>正文</h1>", encoding="utf-8")
            record = {"media_type": "article", "file_paths": ["fixture.html"]}
            with patch("manager_core.media_quality.probe_actual_video_file") as probe:
                self.assertTrue(validate_downloaded_video_quality({"media_type": "video"}, temp, record)[0])
                probe.assert_not_called()
                self.assertFalse(validate_downloaded_video_quality({}, temp, {**record, "file_paths": []})[0])
                document.write_bytes(b"")
                self.assertFalse(validate_downloaded_video_quality({}, temp, record)[0])
            self.assertEqual(kind_from_manifest(record), "article")
            self.assertEqual(manifest_preview_path({**record, "file_paths": ["cover.jpg", "fixture.html"]}), "fixture.html")

    def test_import_read_and_rediscover_article(self):
        with tempfile.TemporaryDirectory(prefix="fanhao-article-manager-") as temp:
            root = Path(temp)
            manager = IsolatedManager(root).start()
            try:
                article_id = "7990000000000000001"
                url = f"https://www.douyin.com/article/{article_id}"
                self.assertEqual(work_id_from_url(url), article_id)
                self.assertEqual(work_kind(url), "article")
                payload = {"profile_url": "https://www.douyin.com/user/article-fixture?showTab=like", "profile_tab": "like", "text": url}
                result = manager.json_request("/api/links/import", method="POST", payload=payload)
                self.assertEqual(result["inserted"], 1)
                with closing(sqlite3.connect(manager.db_path)) as conn, conn:
                    conn.row_factory = sqlite3.Row
                    row = conn.execute("SELECT * FROM links WHERE aweme_id=?", (article_id,)).fetchone()
                    self.assertEqual((row["kind"], row["media_type"]), ("article", "article"))
                    output = root / "article-output"
                    output.mkdir()
                    (output / "article.html").write_text("<!doctype html><meta charset=utf-8><h1>离线正文</h1>", encoding="utf-8")
                    record = {"aweme_id": article_id, "media_type": "article", "desc": "测试文章",
                              "file_paths": ["article.html"], "file_names": ["article.html"]}
                    conn.execute(
                        "UPDATE links SET status='downloaded',output_dir=?,local_file_paths=?,local_file_names=?,metadata_json=? WHERE id=?",
                        (str(output), json.dumps(record["file_paths"]), json.dumps(record["file_names"]), json.dumps(record), row["id"]),
                    )
                library = manager.json_request("/api/library")
                self.assertEqual(library["items"][0]["media_type"], "article")
                status, headers, body = manager.request(library["items"][0]["assets"][0]["url"])
                self.assertEqual(status, 200)
                self.assertIn("离线正文", body.decode("utf-8"))
                self.assertIn("charset=utf-8", headers["Content-Type"])
                self.assertIn("sandbox", headers["Content-Security-Policy"])
                player = manager.json_request("/api/short-videos")
                self.assertEqual(player["total"], 0)
                # Repeated discovery updates the same row and keeps its completed state.
                again = manager.json_request("/api/links/import", method="POST", payload=payload)
                self.assertEqual(again["updated"], 1)
                self.assertEqual(manager.json_request("/api/library")["items"][0]["id"], row["id"])
                # A later card can expose a generic /video URL with no type metadata.
                manager.json_request("/api/links/import", method="POST", payload={
                    **payload, "text": url.replace("/article/", "/video/"),
                })
                self.assertEqual(manager.json_request("/api/library")["items"][0]["media_type"], "article")
                with closing(sqlite3.connect(manager.db_path)) as conn:
                    self.assertEqual(conn.execute("SELECT kind,media_type,url FROM links WHERE id=?", (row["id"],)).fetchone(),
                                     ("article", "article", url))
            finally:
                manager.close()


if __name__ == "__main__":
    unittest.main()
