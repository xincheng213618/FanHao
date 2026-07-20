from __future__ import annotations

import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core import config, database, downloader_client  # noqa: E402


DOWNLOADER_SETTING_KEYS = (
    "downloader_root",
    "downloader_python",
    "downloader_run",
)


def settings_connection(values: dict[str, str]) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    connection.executemany(
        "INSERT INTO settings(key, value) VALUES(?, ?)",
        values.items(),
    )
    return connection


def read_settings(connection: sqlite3.Connection) -> dict[str, str]:
    return {
        str(row["key"]): str(row["value"])
        for row in connection.execute("SELECT key, value FROM settings")
    }


class EmbeddedDownloaderConfigTests(unittest.TestCase):
    def test_default_root_is_colocated_for_source_and_frozen_layouts(self) -> None:
        self.assertEqual(
            config.DEFAULT_DOWNLOADER_ROOT,
            (config.INSTALL_DIR / "downloader").resolve(),
        )
        if not config.FROZEN_BUILD:
            self.assertEqual(
                config.DEFAULT_DOWNLOADER_ROOT,
                (MODULE_DIR / "downloader").resolve(),
            )

    def test_environment_root_takes_precedence_over_database_settings(self) -> None:
        environment_root = Path(r"C:\Overrides\douyin-downloader")
        with (
            patch.object(
                downloader_client,
                "downloader_root_env_value",
                return_value=str(environment_root),
            ),
            patch.object(
                downloader_client,
                "setting",
                side_effect=AssertionError("SQLite settings must not be read"),
            ),
        ):
            root, python_executable, run_file = downloader_client.configured_downloader_paths()

        expected_root = environment_root.resolve()
        self.assertEqual(root, expected_root)
        self.assertEqual(
            python_executable,
            expected_root / ".venv" / "Scripts" / "python.exe",
        )
        self.assertEqual(run_file, expected_root / "run.py")

    def test_setup_requires_modern_python_and_tracks_dependency_fingerprints(self) -> None:
        setup_source = (MODULE_DIR / "setup-downloader.ps1").read_text(encoding="utf-8")

        self.assertIn("sys.version_info >= (3, 10)", setup_source)
        self.assertIn("Python 3.10 or newer is required", setup_source)
        self.assertIn(".fanhao-serve-dependencies.sha256", setup_source)
        self.assertIn("Test-DownloaderDependencyFiles", setup_source)


class DownloaderSettingsMigrationTests(unittest.TestCase):
    def target_settings(self) -> dict[str, str]:
        return {
            "downloader_root": str(config.DOWNLOADER_ROOT),
            "downloader_python": str(config.DOWNLOADER_PYTHON),
            "downloader_run": str(config.DOWNLOADER_RUN),
        }

    def legacy_settings(self) -> dict[str, str]:
        return {
            "downloader_root": str(config.LEGACY_DOWNLOADER_ROOT),
            "downloader_python": str(config.LEGACY_DOWNLOADER_PYTHON),
            "downloader_run": str(config.LEGACY_DOWNLOADER_RUN),
        }

    def test_legacy_defaults_migrate_even_when_the_old_checkout_still_exists(self) -> None:
        connection = settings_connection(self.legacy_settings())
        self.addCleanup(connection.close)

        migrated = database.migrate_downloader_settings(
            connection,
            environment_override=False,
            path_is_valid=lambda _key, _value: True,
        )

        self.assertEqual(set(migrated), set(DOWNLOADER_SETTING_KEYS))
        self.assertEqual(read_settings(connection), self.target_settings())

    def test_invalid_paths_migrate_to_the_colocated_runtime(self) -> None:
        invalid = {
            "downloader_root": r"Z:\Missing\downloader",
            "downloader_python": r"Z:\Missing\downloader\.venv\Scripts\python.exe",
            "downloader_run": r"Z:\Missing\downloader\run.py",
        }
        connection = settings_connection(invalid)
        self.addCleanup(connection.close)

        migrated = database.migrate_downloader_settings(
            connection,
            environment_override=False,
            path_is_valid=lambda _key, _value: False,
        )

        self.assertEqual(set(migrated), set(DOWNLOADER_SETTING_KEYS))
        self.assertEqual(read_settings(connection), self.target_settings())

    def test_valid_custom_paths_are_preserved(self) -> None:
        custom = {
            "downloader_root": r"C:\Custom\douyin-downloader",
            "downloader_python": r"C:\Custom\python.exe",
            "downloader_run": r"C:\Custom\run.py",
        }
        connection = settings_connection(custom)
        self.addCleanup(connection.close)

        migrated = database.migrate_downloader_settings(
            connection,
            environment_override=False,
            path_is_valid=lambda _key, _value: True,
        )

        self.assertEqual(migrated, ())
        self.assertEqual(read_settings(connection), custom)

    def test_partially_invalid_custom_triplet_migrates_atomically(self) -> None:
        custom = {
            "downloader_root": r"C:\Custom\douyin-downloader",
            "downloader_python": r"C:\Custom\missing-python.exe",
            "downloader_run": r"C:\Custom\run.py",
        }
        connection = settings_connection(custom)
        self.addCleanup(connection.close)

        migrated = database.migrate_downloader_settings(
            connection,
            environment_override=False,
            path_is_valid=lambda key, _value: key != "downloader_python",
        )

        self.assertEqual(set(migrated), set(DOWNLOADER_SETTING_KEYS))
        self.assertEqual(read_settings(connection), self.target_settings())

    def test_environment_override_leaves_persisted_paths_untouched(self) -> None:
        invalid = {
            "downloader_root": r"Z:\Missing\downloader",
            "downloader_python": r"Z:\Missing\python.exe",
            "downloader_run": r"Z:\Missing\run.py",
        }
        connection = settings_connection(invalid)
        self.addCleanup(connection.close)

        migrated = database.migrate_downloader_settings(
            connection,
            environment_override=True,
            path_is_valid=lambda _key, _value: False,
        )

        self.assertEqual(migrated, ())
        self.assertEqual(read_settings(connection), invalid)


if __name__ == "__main__":
    unittest.main()
