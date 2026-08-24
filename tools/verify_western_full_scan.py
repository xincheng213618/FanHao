from pathlib import Path
from tempfile import TemporaryDirectory

import full_scan_core_library as scanner


with TemporaryDirectory(prefix="fanhao-western-full-scan-") as temp_dir:
    western_root = Path(temp_dir) / "R"
    person_dir = western_root / "Anjelica"
    collection_dir = person_dir / "Collection"
    collection_dir.mkdir(parents=True)
    (collection_dir / "alpha.mp4").write_bytes(b"video-a")
    (collection_dir / "alpha.jpg").write_bytes(b"image-a")
    (collection_dir / "beta.wmv").write_bytes(b"video-b")
    (collection_dir / "folder.jpg").write_bytes(b"shared-image")

    original_roots = scanner.WESTERN_ROOTS
    scanner.WESTERN_ROOTS = [western_root]
    try:
        works = scanner.scan_person(person_dir, [western_root])
    finally:
        scanner.WESTERN_ROOTS = original_roots

    assert len(works) == 2, "Western full scan must create one work per video"
    assert [work.title for work in works] == ["alpha.mp4", "beta.wmv"]
    assert all(len(work.videos) == 1 for work in works)
    assert all(work.work_dir.suffix.lower() in scanner.VIDEO_EXTS for work in works)
    assert len(works[0].images) == 1, "Same-basename image should stay with its video"
    assert len(works[1].images) == 0, "Shared folder image must not leak across multiple videos"

print("Western full scan verification passed.")
