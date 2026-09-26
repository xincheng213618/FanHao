from __future__ import annotations

import sys
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).resolve().parents[1]
if str(MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(MODULE_DIR))

from manager_core.database import is_antibot_error


class DownloadErrorClassificationTests(unittest.TestCase):
    def test_argus_uifid_rejection_is_antibot(self) -> None:
        self.assertTrue(is_antibot_error("HTTP 403: Blocked by ArgusSecurityPlugin Uifid Not Found"))

    def test_content_unavailable_is_not_antibot(self) -> None:
        self.assertFalse(is_antibot_error("作品已不可用（作者可能已删除作品或更改可见权限）"))


if __name__ == "__main__":
    unittest.main()
