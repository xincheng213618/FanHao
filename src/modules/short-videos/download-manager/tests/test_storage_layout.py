from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from manager_core import domain_manifest, downloader_client


class StorageLayoutTests(unittest.TestCase):
    def test_blank_library_setting_uses_short_videos_under_storage_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-storage-layout-") as temp:
            root = Path(temp) / "media"
            with patch.object(domain_manifest, "setting", return_value=""):
                result = Path(domain_manifest.profile_output_dir(str(root), 123))

            self.assertEqual(result, root / "ShortVideos")

    def test_existing_short_videos_root_is_not_duplicated(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-storage-layout-") as temp:
            library = Path(temp) / "ShortVideos"
            with patch.object(domain_manifest, "setting", return_value=""):
                result = Path(domain_manifest.profile_output_dir(str(library), 123))

            self.assertEqual(result, library)

    def test_explicit_library_setting_still_wins(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-storage-layout-") as temp:
            library = Path(temp) / "custom-library"
            with patch.object(domain_manifest, "setting", return_value=str(library)):
                result = Path(domain_manifest.profile_output_dir(str(Path(temp) / "media"), 123))

            self.assertEqual(result, library)

    def test_manager_sidecar_uses_short_file_names_inside_readable_work_folder(self) -> None:
        with tempfile.TemporaryDirectory(prefix="fanhao-sidecar-config-") as temp:
            config_dir = Path(temp)

            def fake_setting(key: str, default: str = "") -> str:
                values = {
                    "download_proxy": "",
                    "cookie_file": str(config_dir / "missing-cookies.txt"),
                }
                return values.get(key, default)

            with (
                patch.object(downloader_client, "CONFIG_DIR", config_dir),
                patch.object(downloader_client, "setting", side_effect=fake_setting),
            ):
                config_path = downloader_client.write_sidecar_config(str(config_dir / "media"), 4)

            config_text = config_path.read_text(encoding="utf-8")
            self.assertIn('filename_template: "{id}"', config_text)
            self.assertIn('folder_template: "{date}_{title}_{id}"', config_text)
            self.assertIn('author_dir: "sec_uid"', config_text)


if __name__ == "__main__":
    unittest.main()
