"""Offline cleanup fixtures; never invoke organizer entry points or real recycle APIs."""
import argparse
import contextlib
import importlib.util
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
arguments = argparse.ArgumentParser(add_help=False)
arguments.add_argument('--tool-root', type=Path)
options, unittest_arguments = arguments.parse_known_args()
TOOL_ROOT = options.tool_root.resolve() if options.tool_root else None
EXTENSIONS = {'.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx', '.sup', '.smi', '.sami',
              '.ttml', '.dfxp', '.sbv', '.scc', '.stl', '.lrc'}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


project_clean = load('subtitle_project_clean', ROOT / 'tools' / 'clean.py')
tool_clean = tool_work_cleanup = None
if TOOL_ROOT:
    if not (TOOL_ROOT / 'work_cleanup.py').is_file():
        raise RuntimeError('The requested Tool root does not contain work_cleanup.py')
    sys.path.insert(0, str(TOOL_ROOT))
    tool_clean = load('subtitle_desktop_clean', TOOL_ROOT / 'clean.py')
    tool_work_cleanup = load('subtitle_desktop_work_cleanup', TOOL_ROOT / 'work_cleanup.py')


def work_fixture(temp):
    sandbox = Path(temp).resolve()
    work = sandbox / 'ABC-123 title'
    work.mkdir()
    (work / 'ABC-123.part1.mp4').write_bytes(b'private fixture primary video')
    (work / 'cover.jpg').write_bytes(b'private fixture cover')
    (work / 'info.txt').write_text('video_id: ABC-123\nlocal_cover_file: cover.jpg\n', encoding='utf-8')
    tracks = work / 'subtitles'
    tracks.mkdir()
    subtitles = []
    for extension in sorted(EXTENSIONS):
        target = tracks / ('advert-code.zh-CN' + extension.upper())
        target.write_bytes(b'identical fixture content retained for every language and format')
        subtitles.append(target)
    # Same release/language tracks may deliberately have identical bytes.
    for name in ['ABC-123.en.srt', 'ABC-123.ja.srt']:
        target = work / name
        target.write_bytes(b'identical fixture content retained for every language and format')
        subtitles.append(target)
    junk = [work / name for name in ['advert.url', 'unrelated.cfg',
                                     'ABC-123.mp4.115chrome_123_4',
                                     'ABC-123.mp4.115chrome_123_4.cfg']]
    for index, target in enumerate(junk):
        target.write_bytes(f'fixture junk {index}'.encode())
    return sandbox, work, subtitles, junk


class SubtitleCleanupTests(unittest.TestCase):
    def verify_cleaner(self, module):
        with tempfile.TemporaryDirectory(prefix='fanhao-subtitle-cleanup-') as temp:
            sandbox, work, subtitles, junk = work_fixture(temp)
            expected = {path: path.read_bytes() for path in subtitles}
            config = module.CleanConfig(directory=str(sandbox), keywords=['advert'],
                                        max_size=100 * 1024 * 1024, hash_algo='sha256',
                                        match_scope='name', video_code_mode=True)
            with contextlib.redirect_stdout(io.StringIO()):
                result = module.run_clean(config)
            self.assertIsNotNone(result)
            for path, data in expected.items():
                self.assertEqual(path.read_bytes(), data, f'subtitle must survive every cleanup phase: {path.name}')
            self.assertTrue((work / 'info.txt').is_file())
            self.assertTrue((work / 'cover.jpg').is_file())
            self.assertTrue((work / 'ABC-123.part1.mp4').is_file())
            self.assertTrue(all(not path.exists() for path in junk), 'ordinary ads, cfg and 115 temporary files remain cleanup candidates')

    def test_project_all_phases_preserve_subtitles_and_remove_junk(self):
        self.verify_cleaner(project_clean)

    def test_project_preservation_is_case_insensitive_and_not_generic_txt(self):
        for extension in EXTENSIONS:
            self.assertTrue(project_clean._is_preserve_file('广告' + extension.upper()))
        self.assertFalse(project_clean._is_preserve_file('advert.txt'))
        self.assertFalse(project_clean._is_preserve_file('movie.srt.115chrome_1_2.cfg'))

    @unittest.skipUnless(TOOL_ROOT, 'pass --tool-root to verify the separately maintained desktop organizer')
    def test_desktop_cleaner_all_phases_preserve_subtitles(self):
        self.verify_cleaner(tool_clean)

    @unittest.skipUnless(TOOL_ROOT, 'pass --tool-root to verify the separately maintained desktop organizer')
    def test_authoritative_work_allowlist_keeps_subtitles_before_recycle(self):
        with tempfile.TemporaryDirectory(prefix='fanhao-subtitle-allowlist-') as temp:
            sandbox, work, subtitles, junk = work_fixture(temp)
            expected = {path: path.read_bytes() for path in subtitles}
            _, actions, kept, _ = tool_work_cleanup.plan_work_cleanup(work, 'ABC-123')
            self.assertEqual({Path(action.path) for action in actions}, set(junk))
            self.assertTrue(set(subtitles).issubset({Path(path) for path in kept}))
            dry = tool_work_cleanup.cleanup_work(work, 'ABC-123', dry_run=True)
            self.assertEqual(dry['planned'], len(junk))
            self.assertEqual(dry['recycled'], 0)
            self.assertTrue(all(path.exists() for path in junk))

            def fixture_recycle(path):
                target = Path(path).resolve()
                target.relative_to(sandbox)
                self.assertIn(target, junk)
                target.unlink()

            with patch.object(tool_work_cleanup, 'recycle_file', side_effect=fixture_recycle):
                result = tool_work_cleanup.cleanup_work(work, 'ABC-123')
            self.assertEqual(result['recycled'], len(junk))
            self.assertEqual(result['errors'], [])
            for path, data in expected.items():
                self.assertEqual(path.read_bytes(), data)
            self.assertTrue(all(not path.exists() for path in junk))


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0], *unittest_arguments])
