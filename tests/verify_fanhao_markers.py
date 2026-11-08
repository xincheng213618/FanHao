"""Offline organizer checks using synthetic media in isolated temporary directories."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import fanhao


class FilenameMarkerTests(unittest.TestCase):
    def test_edition_markers_and_canonical_order(self):
        cases = [
            ("HMN-921.restored.LTX.mp4", "[LTX]"),
            ("MIDA-840-UC.mp4", "[UC]"),
            ("MIDA-840-U.mp4", "[U]"),
            ("MIDA-840-C.mp4", "[C]"),
            ("[A]MIDA-840-C-U-ltx.mp4", "[A][LTX][UC]"),
            ("[A][LTX][UC]MIDA-840", "[A][LTX][UC]"),
            ("[A]MIDA-840-LTX-C.mp4", "[A][LTX][C]"),
            ("[A]MIDA-840-LTX.mp4", "[A][LTX]"),
            ("[UC]MIDA-840_ltx.mp4", "[LTX][UC]"),
            ("MIDA-840_lTx_u_c.mp4", "[LTX][UC]"),
        ]
        for name, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(fanhao.extract_name_markers(name), expected)

    def test_a_requires_manual_prefix_and_letters_require_boundaries(self):
        for name in [
            "MIDA-840[A].mp4",
            "[UC][A]MIDA-840",
            "A-MIDA-840.mp4",
            "CAWD-900.mp4",
            "ABC-123-CU.mp4",
            "ABC-123-LTXPRO.mp4",
            "ABC-123-CLTX.mp4",
            "ABC-123-CD1.mp4",
            "[website]ABC-123.mp4",
        ]:
            with self.subTest(name=name):
                expected = "[UC]" if name.startswith("[UC]") else ""
                self.assertEqual(fanhao.extract_name_markers(name), expected)
        for title in ["ABC-123 巨乳Cカップ", "ABC-123 U-15 測試", "ABC-123 Vol.C", "ABC-123 c級", "[LTX]ABC-123 標題 C"]:
            with self.subTest(title=title):
                self.assertEqual(fanhao.extract_name_markers(title), "[LTX]" if title.startswith("[LTX]") else "")
        self.assertEqual(fanhao.extract_name_markers("489155.com@ABC-940-LTX.mp4"), "[LTX]")
        self.assertEqual(fanhao.extract_name_markers("ABC-123", ["ABC-123[A].mp4"]), "")
        self.assertEqual(fanhao.extract_name_markers("ABC-123", ["[A]ABC-123.mp4"]), "[A]")


class OrganizerMarkerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="fanhao-markers-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.incoming = self.root / "incoming"
        self.incoming.mkdir()
        self.output = self.root / "organized"
        self.meta = fanhao.VideoMeta("ABC-123", "ABC-123 测试标题", ["测试人物"], None, {})

    def organizer(self, dry_run=False):
        return fanhao.VideoOrganizer(
            str(self.incoming), str(self.output), sleep=0,
            dry_run=dry_run, save_database=False,
        )

    def test_folder_a_and_file_editions_survive_real_rename(self):
        source = self.incoming / "[A]ABC-123"
        source.mkdir()
        (source / "ABC-123.restored.LTX-UC.mp4").write_bytes(b"synthetic media")
        organizer = self.organizer()
        with patch.object(organizer, "_fetch_meta", return_value=self.meta):
            organizer.organize()
        target = self.output / "测试人物" / "[A][LTX][UC]ABC-123 测试标题"
        self.assertFalse(source.exists())
        self.assertEqual((target / "ABC-123 测试标题.mp4").read_bytes(), b"synthetic media")
        self.assertTrue((target / "info.txt").is_file())
        self.assertEqual(fanhao.extract_name_markers(target.name), "[A][LTX][UC]")

    def test_loose_mp4_marker_survives_folder_preparation(self):
        source = self.incoming / "ABC-123.restored.LTX.mp4"
        source.write_bytes(b"synthetic loose media")
        organizer = self.organizer()
        with patch.object(organizer, "_fetch_meta", return_value=self.meta):
            organizer.organize()
        target = self.output / "测试人物" / "[LTX]ABC-123 测试标题"
        self.assertEqual((target / "ABC-123 测试标题.mp4").read_bytes(), b"synthetic loose media")
        self.assertFalse(source.exists())

    def test_multipart_markers_are_read_without_renaming_parts(self):
        source = self.incoming / "ABC-123"
        source.mkdir()
        files = {"ABC-123.LTX.part1.mp4": b"part 1", "ABC-123-C.part2.mp4": b"part 2"}
        for name, content in files.items():
            (source / name).write_bytes(content)
        organizer = self.organizer()
        with patch.object(organizer, "_fetch_meta", return_value=self.meta):
            organizer.organize()
        target = self.output / "测试人物" / "[LTX][C]ABC-123 测试标题"
        for name, content in files.items():
            self.assertEqual((target / name).read_bytes(), content)

    def test_dry_run_uses_file_markers_without_writing(self):
        source = self.incoming / "[A]ABC-123"
        source.mkdir()
        media = source / "ABC-123-LTX-UC.mp4"
        media.write_bytes(b"untouched")
        organizer = self.organizer(dry_run=True)
        with self.assertLogs("fanhao", level="INFO") as logs:
            organizer._apply_metadata(str(source), source.name, self.meta, source.name)
        self.assertIn("[A][LTX][UC]ABC-123 测试标题", "\n".join(logs.output))
        self.assertEqual(media.read_bytes(), b"untouched")
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
