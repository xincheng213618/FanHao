"""Exact full-snapshot chapter reconciliation; parity with chapter-identity.js."""
import math
import json
import re
import uuid


def reconcile_chapters(old_chapters, incoming_chapters, old_revision, new_revision, progress=None, allocate_id=None):
    allocate_id = allocate_id or (lambda: str(uuid.uuid4()))
    def validate(chapters, old):
        if not isinstance(chapters, list):
            raise ValueError("章节快照必须完整")
        indexes, ids = set(), set()
        for chapter in chapters:
            index = chapter.get("index")
            identity = chapter.get("id")
            if (type(index) is not int or not 1 <= index <= 9007199254740991 or index in indexes
                    or not isinstance(chapter.get("title"), str) or not isinstance(chapter.get("content"), str)
                    or (old and (not isinstance(identity, str) or not identity or identity in ids))):
                raise ValueError("章节快照损坏")
            indexes.add(index)
            if old:
                ids.add(identity)
    validate(old_chapters, True)
    validate(incoming_chapters, False)
    if not isinstance(new_revision, str) or not new_revision or new_revision == old_revision:
        raise ValueError("目录版本必须更新")
    def groups(chapters, key_for):
        result = {}
        for chapter in chapters:
            key = key_for(chapter)
            if key is not None:
                result.setdefault(key, []).append(chapter)
        return result
    def body_key(chapter):
        return chapter["content"] if re.search(r"[^ \t\r\n]", chapter["content"]) else None
    def title_key(chapter):
        return chapter["title"].strip(" \t\r\n") or None
    before, after = groups(old_chapters, body_key), groups(incoming_chapters, body_key)
    old_ids, allocated, retained, assigned, chapters = {c["id"] for c in old_chapters}, set(), {}, set(), []
    for chapter in incoming_chapters:
        key = body_key(chapter)
        previous = before.get(key, [])
        if key is not None and len(previous) == 1 and len(after.get(key, [])) == 1:
            identity = previous[0]["id"]
            retained[identity] = chapter["index"]
            assigned.add(chapter["index"])
        else:
            identity = allocate_id()
            if not isinstance(identity, str) or not identity or identity in old_ids or identity in allocated:
                raise ValueError("新章节身份冲突")
            allocated.add(identity)
        chapters.append(dict(id=identity, index=chapter["index"], title=chapter["title"], content=chapter["content"]))
    chapters.sort(key=lambda c: c["index"])
    if progress is None:
        return dict(chapters=chapters, progress=None)
    previous = progress.get("previous") or {key: progress.get(key) for key in ("chapterId", "chapterIndex", "scrollRatio", "catalogRevision")}
    if not progress.get("previous") and isinstance(progress.get("title"), str):
        previous["title"] = progress["title"]
    def unresolved(reason):
        return dict(chapters=chapters, progress=dict(status="unresolved", reason=reason, previous=previous))
    if progress.get("status") != "resolved":
        return unresolved(progress.get("reason") or "previous_unresolved")
    if not old_revision or progress.get("catalogRevision") != old_revision:
        return unresolved("stale_revision")
    old = next((c for c in old_chapters if c["id"] == progress.get("chapterId")), None)
    if old is None or old["index"] != progress.get("chapterIndex"):
        return unresolved("old_chapter_missing")
    ratio = progress.get("scrollRatio")
    if type(ratio) not in (int, float) or not math.isfinite(ratio) or not 0 <= ratio <= 1:
        return unresolved("invalid_ratio")
    if old["id"] in retained:
        return dict(chapters=chapters, progress=dict(status="resolved", chapterId=old["id"], chapterIndex=retained[old["id"]], scrollRatio=ratio, catalogRevision=new_revision))
    if len(before.get(body_key(old), [])) > 1 or len(after.get(body_key(old), [])) > 1:
        return unresolved("ambiguous_content")
    title = title_key(old)
    old_titles, new_titles = groups(old_chapters, title_key), groups(chapters, title_key)
    candidates = new_titles.get(title, [])
    if title and len(old_titles.get(title, [])) == 1 and len(candidates) == 1:
        candidate = candidates[0]
        if candidate["index"] not in assigned and len(after.get(body_key(candidate), [])) <= 1 and candidate["content"] != old["content"]:
            return dict(chapters=chapters, progress=dict(status="needs_review", reason="content_changed", previous=previous,
                candidate=dict(chapterId=candidate["id"], chapterIndex=candidate["index"], scrollRatio=0, catalogRevision=new_revision, title=candidate["title"])))
    return unresolved("no_unique_match")


def migrate_chapter_schema(conn):
    # Do not use executescript here: it would commit the caller's upgrade txn.
    for statement in (
        "ALTER TABLE novel_books ADD COLUMN catalog_revision TEXT",
        "ALTER TABLE novel_books ADD COLUMN legacy_write_allowed INTEGER NOT NULL DEFAULT 1",
        "ALTER TABLE novel_reading_state ADD COLUMN catalog_revision TEXT",
        "ALTER TABLE novel_reading_state ADD COLUMN status TEXT NOT NULL DEFAULT 'unresolved'",
        "ALTER TABLE novel_reading_state ADD COLUMN reason TEXT NOT NULL DEFAULT 'legacy_unverified'",
        "ALTER TABLE novel_reading_state ADD COLUMN anchor_json TEXT",
        "ALTER TABLE novel_reading_state ADD COLUMN candidate_json TEXT",
    ):
        conn.execute(statement)
    invalid = conn.execute("""SELECT c.id FROM novel_chapters c LEFT JOIN novel_books b ON b.id = c.book_id
        WHERE b.id IS NULL OR typeof(c.id) != 'text' OR c.id = '' OR typeof(c.chapter_index) != 'integer'
          OR c.chapter_index < 1 OR typeof(c.title) != 'text' OR typeof(c.content) != 'text' LIMIT 1""").fetchone()
    if invalid:
        raise ValueError("旧章节记录损坏，升级已回滚")
    for (book_id,) in conn.execute("SELECT id FROM novel_books"):
        conn.execute("UPDATE novel_books SET catalog_revision = ? WHERE id = ?", (str(uuid.uuid4()), book_id))
    for book_id, chapter_id, index, ratio in conn.execute("SELECT book_id, chapter_id, chapter_index, scroll_ratio FROM novel_reading_state"):
        anchor = dict(chapterId=chapter_id, chapterIndex=index, scrollRatio=ratio, catalogRevision=None)
        conn.execute("UPDATE novel_reading_state SET anchor_json = ? WHERE book_id = ?", (json.dumps(anchor, ensure_ascii=False), book_id))


def prepare_chapter_replacement(conn, book_id, incoming):
    book = conn.execute("SELECT catalog_revision FROM novel_books WHERE id = ?", (book_id,)).fetchone()
    old_chapters = [dict(id=row[0], index=row[1], title=row[2], content=row[3]) for row in conn.execute(
        "SELECT id, chapter_index, title, content FROM novel_chapters WHERE book_id = ? ORDER BY chapter_index", (book_id,))]
    row = conn.execute("SELECT status, reason, chapter_id, chapter_index, scroll_ratio, catalog_revision, anchor_json FROM novel_reading_state WHERE book_id = ?", (book_id,)).fetchone()
    progress = None
    if row:
        progress = dict(status=row[0], reason=row[1], chapterId=row[2], chapterIndex=row[3], scrollRatio=row[4], catalogRevision=row[5])
        if row[6]:
            progress["previous"] = json.loads(row[6])
        old = next((c for c in old_chapters if c["id"] == row[2]), None)
        if old:
            progress["title"] = old["title"]
    revision = str(uuid.uuid4())
    result = reconcile_chapters(old_chapters, incoming, book[0] if book else None, revision, progress)
    return dict(**result, revision=revision, existed=bool(book))


def finish_chapter_replacement(conn, book_id, replacement):
    conn.execute("UPDATE novel_books SET catalog_revision = ?, legacy_write_allowed = ? WHERE id = ?",
        (replacement["revision"], 0 if replacement["existed"] else 1, book_id))
    progress = replacement["progress"]
    if progress is None:
        return
    if progress["status"] == "resolved":
        conn.execute("""UPDATE novel_reading_state SET chapter_id = ?, chapter_index = ?, scroll_ratio = ?,
            catalog_revision = ?, status = 'resolved', reason = '', anchor_json = NULL, candidate_json = NULL WHERE book_id = ?""",
            (progress["chapterId"], progress["chapterIndex"], progress["scrollRatio"], progress["catalogRevision"], book_id))
    else:
        conn.execute("UPDATE novel_reading_state SET status = ?, reason = ?, anchor_json = ?, candidate_json = ? WHERE book_id = ?",
            (progress["status"], progress["reason"], json.dumps(progress["previous"], ensure_ascii=False),
             json.dumps(progress["candidate"], ensure_ascii=False) if progress.get("candidate") else None, book_id))
