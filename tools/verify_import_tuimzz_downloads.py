from __future__ import annotations

import json
import stat
import tempfile
import unittest
from pathlib import Path

import import_tuimzz_downloads as importer


class ImportTuimzzDownloadsTests(unittest.TestCase):
    def test_sequence_parsers(self) -> None:
        self.assertEqual(importer.parse_root_number("389A"), 389)
        self.assertEqual(importer.parse_source_sequence(Path("B389020(1).7z"), 389), 20)
        self.assertEqual(importer.parse_local_sequence("徐莉芝 - NO.005 [10P].rar"), 5)
        self.assertEqual(importer.parse_local_sequence("108.小王[20P].rar"), 108)
        self.assertIsNone(importer.parse_local_sequence("没有序号.rar"))
        with self.assertRaises(importer.ImportSafetyError):
            importer.parse_source_sequence(Path("B390001.7z"), 389)

    def test_safe_archive_member(self) -> None:
        self.assertTrue(importer.safe_archive_member("B389001.zip"))
        self.assertTrue(importer.safe_archive_member("folder/B389001.zip"))
        self.assertFalse(importer.safe_archive_member("../B389001.zip"))
        self.assertFalse(importer.safe_archive_member("C:/B389001.zip"))

    def test_remove_junk_files_clears_read_only_attribute(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            junk = root / "read-only.URL"
            keep = root / "video.mp4"
            junk.write_text("shortcut", encoding="utf-8")
            keep.write_bytes(b"video")
            junk.chmod(junk.stat().st_mode & ~stat.S_IWRITE)
            importer.remove_junk_files(root, root)
            self.assertFalse(junk.exists())
            self.assertTrue(keep.exists())

    def test_safe_remove_tree_retries_read_only_members(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            work = root / "run" / "work"
            work.mkdir(parents=True)
            member = work / "read-only.jpg"
            member.write_bytes(b"image")
            member.chmod(member.stat().st_mode & ~stat.S_IWRITE)
            importer.safe_remove_tree(root / "run", root)
            self.assertFalse((root / "run").exists())

    def test_media_extensions_include_video_only_archives(self) -> None:
        self.assertIn(".mp4", importer.MEDIA_EXTENSIONS)
        self.assertNotIn(".txt", importer.MEDIA_EXTENSIONS)

    def test_output_stem_must_match_source_sequence(self) -> None:
        self.assertEqual(importer.validate_output_stem("003.Person [12V]", 3), "003.Person [12V]")
        self.assertEqual(importer.validate_output_stem("Person - NO.017 title", 17), "Person - NO.017 title")
        with self.assertRaises(importer.ImportSafetyError):
            importer.validate_output_stem("unzipped", 3)
        with self.assertRaises(importer.ImportSafetyError):
            importer.validate_output_stem("004.Person", 3)

    def test_legacy_password_is_read_without_importing_script(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "legacy.py"
            path.write_text('DEFAULT_PASSWORD = "fixture-secret"\nraise RuntimeError("must not execute")\n', encoding="utf-8")
            self.assertEqual(importer.load_legacy_password(path, "UNSET_TEST_PASSWORD"), "fixture-secret")

    def test_deduplicate_identical_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "389A"
            bucket = root / "001-100"
            bucket.mkdir(parents=True)
            (bucket / "B389001.7z").write_bytes(b"same")
            (bucket / "B389001(1).7z").write_bytes(b"same")
            sources, duplicates = importer.deduplicate_sources(root, "389A", 389)
            self.assertEqual(len(sources), 1)
            self.assertEqual(sources[0].sequence, 1)
            self.assertEqual(sources[0].path.name, "B389001.7z")
            self.assertEqual(len(duplicates), 1)

    def test_deduplicate_rejects_different_copy(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "301"
            root.mkdir()
            (root / "B301002.7z").write_bytes(b"base")
            (root / "B301002(1).7z").write_bytes(b"copy")
            with self.assertRaises(importer.ImportSafetyError):
                importer.deduplicate_sources(root, "301", 301)

    def test_choose_destination_prefers_existing_alias_then_existing_canonical(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            library = Path(temp) / "library"
            library.mkdir()
            proposed = library / "[Person]"
            alias = library / "Person"
            alias.mkdir()
            item = {"proposed_destination": str(proposed), "local_directories": [str(alias)]}
            self.assertEqual(importer.choose_destination(item, proposed, library), alias.resolve())
            proposed.mkdir()
            item["local_directories"] = [str(alias), str(proposed)]
            self.assertEqual(importer.choose_destination(item, proposed, library), proposed.resolve())

    def test_build_plan_skips_existing_sequence_and_limits_by_size(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            input_root = base / "downloads"
            source_root = input_root / "285"
            source_root.mkdir(parents=True)
            (source_root / "B285001.7z").write_bytes(b"existing")
            (source_root / "B285002.7z").write_bytes(b"xx")
            (source_root / "B285003.7z").write_bytes(b"y")

            library = base / "library"
            alias = library / "Person"
            alias.mkdir(parents=True)
            (alias / "001.Person.rar").write_bytes(b"placeholder")
            proposed = library / "[Person]"

            legacy_csv = base / "artfilepath.csv"
            legacy_csv.write_text(
                "URL,Post Viewsss,Girl Nums,Entry Title,Path\n"
                f"https://old.example/264531.html,,B285,Person,{proposed}\n",
                encoding="utf-8",
            )
            report = base / "latest.json"
            report.write_text(
                json.dumps(
                    {
                        "items": [
                            {
                                "post_id": "264531",
                                "status": "update",
                                "destination_name": "Person",
                                "remote_count": 3,
                                "legacy_codes": ["B285"],
                                "proposed_destination": str(proposed),
                                "local_directories": [str(alias)],
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            roots, tasks, totals = importer.build_plan(
                input_root,
                ["285"],
                library,
                legacy_csv,
                report,
                max_items=1,
            )
            self.assertEqual(roots[0].candidate_count, 2)
            self.assertEqual(totals["candidate_count"], 2)
            self.assertEqual(totals["selected_count"], 1)
            self.assertEqual(totals["limited_out_count"], 1)
            self.assertEqual(tasks[0].sequence, 3)
            self.assertEqual(tasks[0].destination, alias.resolve())


if __name__ == "__main__":
    unittest.main()
