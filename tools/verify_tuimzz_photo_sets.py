import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("sync_tuimzz_photo_sets.py")
SPEC = importlib.util.spec_from_file_location("sync_tuimzz_photo_sets", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class TuimzzSyncTests(unittest.TestCase):
    def test_parse_current_category_card_shape(self):
        page = """
        <article class="post-item post-283404">
          <span class="post-viewsss">钻石</span><span class="girl-nums">20+</span>
          <a href="https://www.tuimzz.com/283404.html"><h2 class="entry-title">徐莉芝Booty#微密圈系列图集</h2></a>
        </article>
        """
        posts = MODULE.parse_category_page(page, "https://www.tuimzz.com/category/mq", 1)
        self.assertEqual(1, len(posts))
        self.assertEqual("283404", posts[0].post_id)
        self.assertEqual(20, posts[0].remote_count)
        self.assertTrue(posts[0].remote_count_open_ended)
        self.assertEqual("徐莉芝Booty", MODULE.destination_name_from_title(posts[0].title))

    def test_multiple_post_gap_requires_review_instead_of_downloading_all(self):
        with tempfile.TemporaryDirectory() as root:
            library = Path(root)
            destination = library / "[小猫咪ck]"
            destination.mkdir()
            for index in range(1, 6):
                (destination / f"{index:03}.rar").write_bytes(b"x")
            posts = [
                MODULE.RemotePost("1", "https://www.tuimzz.com/1.html", "小猫咪ck#微密圈A", "钻石", "3", 3, False, 1),
                MODULE.RemotePost("2", "https://www.tuimzz.com/2.html", "小猫咪ck#微密圈B", "钻石", "3", 3, False, 1),
            ]
            MODULE.assign_post_destinations(posts, {})
            groups = MODULE.build_local_groups(posts, library)
            self.assertEqual(1, len(groups))
            self.assertEqual(6, groups[0].remote_count)
            self.assertEqual(5, groups[0].local_count)
            self.assertEqual("review", groups[0].status)
            self.assertIn("group_count_gap_unallocated", groups[0].review_flags)

    def test_open_ended_count_is_not_treated_as_exact(self):
        with tempfile.TemporaryDirectory() as root:
            library = Path(root)
            destination = library / "[测试人物]"
            destination.mkdir()
            (destination / "001.rar").write_bytes(b"one")
            post = MODULE.RemotePost("9", "https://www.tuimzz.com/9.html", "测试人物#微密圈", "钻石", "1+", 1, True, 1)
            MODULE.assign_post_destinations([post], {})
            group = MODULE.build_local_groups([post], library)[0]
            self.assertEqual("review", group.status)
            self.assertIn("remote_count_open_ended", group.review_flags)

    def test_bracketed_and_plain_directories_share_one_manifest(self):
        with tempfile.TemporaryDirectory() as root:
            library = Path(root)
            first = library / "[禅院熏]"
            second = library / "禅院熏"
            first.mkdir()
            second.mkdir()
            (first / "001.rar").write_bytes(b"one")
            (second / "001.rar").write_bytes(b"one")
            (second / "002.rar").write_bytes(b"two")
            post = MODULE.RemotePost("3", "https://www.tuimzz.com/3.html", "禅院熏#微密圈合集", "钻石", "2", 2, False, 1)
            MODULE.assign_post_destinations([post], {})
            group = MODULE.build_local_groups([post], library)[0]
            self.assertEqual(2, group.local_count)
            self.assertEqual("current", group.status)
            self.assertIn("multiple_local_directories", group.review_flags)

    def test_extract_baidu_redirect_and_facts(self):
        body = '<script>window.location.href="https://pan.baidu.com/s/example?pwd=5280";</script>'
        url = MODULE.extract_external_download_url(body, "https://www.tuimzz.com/download.php")
        self.assertEqual("https://pan.baidu.com/s/example?pwd=5280", url)
        self.assertEqual(("example", "5280"), MODULE.baidu_link_facts(url))

    def test_alias_matches_parenthetical_and_source_suffixes(self):
        self.assertIn(
            MODULE.normalized_destination_key("轩子巨二兔"),
            MODULE.destination_alias_keys("轩子巨二兔(轩子巨2兔)"),
        )
        self.assertIn(MODULE.normalized_destination_key("鱼神"), MODULE.destination_alias_keys("鱼神微密圈"))
        self.assertEqual("王心悦(绣人)", MODULE.destination_name_from_title("王心悦(绣人)#内购纯净版2套合辑"))

    def test_cookie_json_is_scoped_to_tuimzz(self):
        value = '[{"domain":".tuimzz.com","name":"session","value":"ok"},{"domain":"example.com","name":"bad","value":"no"}]'
        self.assertEqual("session=ok", MODULE.normalize_cookie_text(value))

    def test_locked_latest_csv_falls_back_without_blocking_html(self):
        payload = {
            "generated_at": "2026-08-10T00:00:00Z",
            "library_root": r"T:\微密圈",
            "totals": {
                "remote_posts": 0,
                "destination_groups": 0,
                "update_posts": 0,
                "missing_local_posts": 0,
                "resolved_baidu_links": 0,
            },
            "items": [],
        }
        written = []

        def fake_write(path, _text):
            written.append(path.name)
            if path.name == "latest.csv":
                raise PermissionError("locked")

        with tempfile.TemporaryDirectory() as root, mock.patch.object(MODULE, "atomic_write_text", side_effect=fake_write):
            paths = MODULE.write_reports(payload, Path(root))

        self.assertEqual("latest.pending.csv", paths["csv"].name)
        self.assertIn("latest.html", written)
        self.assertIn("latest.pending.csv", written)


if __name__ == "__main__":
    unittest.main()
