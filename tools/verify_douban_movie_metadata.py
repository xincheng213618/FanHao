"""Synthetic-only real collector tests. No browser launch/network/user DB/cookies.

Uses the same JSON matching vectors as Node, real BeautifulSoup parsing and real
temporary sqlite3, with only page/context/HTTP/pacing external boundaries faked.
"""
import argparse
import copy
import hashlib
import html
import json
import re
import sqlite3
import sys
import tempfile
import traceback
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

sys.dont_write_bytecode = True
import backfill_douban_movie_metadata_browser as collector
import douban_movie_match as matcher


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "tools/fixtures/douban-movie-metadata-cases.json").read_text(encoding="utf-8"))
TESTS = []
OLD_TESTS = []


def test(name, fn):
    TESTS.append((name, fn))


def eq(actual, expected, message=""):
    assert actual == expected, message or f"{actual!r} != {expected!r}"


def raises(fn, *, code=None, kind=Exception):
    try:
        fn()
    except kind as error:
        if code:
            eq(getattr(error, "code", None), code)
        return error
    raise AssertionError("expected operation to reject")


def args(**updates):
    value = collector.parse_args([])
    vars(value).update(write=True, refresh=True, sleep=0.01, jitter=0, limit=0)
    vars(value).update(updates)
    return value


def target():
    item = FIXTURE["sequelTarget"]
    return collector.MovieTarget("synthetic-movie-one", "Synthetic", item["movieTitle"], item["searchTitle"], item["samples"])


def index_data(two=False):
    ids = ["synthetic-movie-one"] + (["synthetic-movie-two"] if two else [])
    return {"mediaItems": [{"id": key, "mediaKind": "movie", "title": FIXTURE["sequelTarget"]["movieTitle"], "category": "Synthetic", "relativePath": FIXTURE["sequelTarget"]["samples"][0]} for key in ids]}


def subject_html(meta):
    info = dict(meta.get("info") or {})
    if meta.get("originalTitle"):
        info["原名"] = meta["originalTitle"]
    if meta.get("aliases"):
        info["又名"] = " / ".join(meta["aliases"])
    info_html = "".join(f'<span class="pl">{html.escape(key)}:</span> {html.escape(str(value))}<br/>' for key, value in info.items())
    cover = f'<a class="nbgnbg"><img src="{html.escape(meta["coverUrl"])}"></a>' if meta.get("coverUrl") else ""
    return f'''<!doctype html><html><head><script type="application/ld+json">{json.dumps(meta.get("jsonLd", {}), ensure_ascii=False)}</script></head><body>
      <h1><span property="v:itemreviewed">{html.escape(meta.get("title", ""))}</span><span class="year">({html.escape(meta.get("year", ""))})</span></h1>
      <div id="info">{info_html}</div>{cover}<strong property="v:average">{meta.get("rating", 0)}</strong><span property="v:votes">{meta.get("ratingCount", 0)}</span>
      <span property="v:summary">{html.escape(meta.get("summary", ""))}</span></body></html>'''


class FakeResponse:
    def __init__(self, url, body="", status=200, mime="text/html"):
        self.url, self.status, self.headers = url, status, {"content-type": mime}
        self.ok, self._body = 200 <= status < 300, body

    def text(self):
        return self._body.decode("utf-8") if isinstance(self._body, bytes) else self._body

    def json(self):
        return json.loads(self.text())

    def body(self):
        return self._body if isinstance(self._body, bytes) else self._body.encode("utf-8")


class FakeIO:
    def __init__(self, urls=None, metas=None, overrides=None, suggest=True):
        self.urls = urls if urls is not None else [FIXTURE["metas"]["tv"]["doubanUrl"], FIXTURE["metas"]["sequel"]["doubanUrl"]]
        self.lookup = {meta["doubanUrl"]: meta for meta in (metas or [FIXTURE["metas"]["tv"], FIXTURE["metas"]["sequel"]])}
        self.overrides, self.suggest = overrides or {}, suggest
        self.events = []
        self.context = SimpleNamespace(request=SimpleNamespace(get=self.request), close=self.forbidden, new_page=self.forbidden)
        self.page = FakePage(self)

    def forbidden(self, *unused, **ignored):
        raise AssertionError("fixture must not launch/close a caller-owned browser resource")

    def request(self, url, **kwargs):
        self.events.append({"type": "request", "url": url, "kwargs": kwargs})
        assert re.match(r"https://(?:(?:www\.|movie\.|search\.)douban\.com|img\.doubanio\.com)/", url), f"unplanned synthetic URL: {url}"
        kind = "suggest" if "/j/subject_suggest" in url else "search" if "search?" in url else "home" if url == "https://movie.douban.com/" else "subject"
        override = self.overrides.get(url, self.overrides.get(kind))
        if isinstance(override, Exception):
            raise override
        if override is not None:
            return FakeResponse(override.get("url", url), override.get("body", ""), override.get("status", 200), override.get("mime", "text/html"))
        if kind == "home":
            return FakeResponse(url, "<html>synthetic home</html>")
        if kind == "suggest":
            return FakeResponse(url, json.dumps([{"url": value} for value in self.urls] if self.suggest else []), mime="application/json")
        if kind == "search":
            return FakeResponse(url, "".join(f'<a href="{html.escape(value)}">Search hint, not verified data</a>' for value in self.urls))
        assert url in self.lookup, f"unplanned synthetic request: {url}"
        return FakeResponse(url, subject_html(self.lookup[url]))

    def sleep(self, seconds):
        self.events.append({"type": "pause", "seconds": seconds})

    def pacer(self):
        return collector.RequestPacer(args(), self.sleep, lambda *unused: None)

    def request_urls(self):
        return [event["url"] for event in self.events if event["type"] == "request"]

    def paced(self, minimum_seconds=0.01):
        previous = None
        for index, event in enumerate(self.events):
            if event["type"] != "request":
                continue
            if previous is not None:
                assert any(item["type"] == "pause" and item["seconds"] >= minimum_seconds for item in self.events[previous + 1:index]), f"every explicit request needs pacing >= {minimum_seconds}s"
            previous = index


class FakePage:
    def __init__(self, io):
        self.io, self.url, self.response = io, "", None

    def goto(self, url, **kwargs):
        self.response = self.io.request(url, **kwargs)
        self.url = self.response.url
        return self.response

    def content(self):
        return self.response.text()

    def wait_for_timeout(self, milliseconds):
        self.io.events.append({"type": "dom-wait", "milliseconds": milliseconds})

    def wait_for_selector(self, *unused, **ignored):
        return None

    def eval_on_selector_all(self, *unused):
        # Forces actual collector HTML/href parsing; no fake selected subject.
        return []


def with_db(fn):
    with tempfile.TemporaryDirectory(prefix="fanhao-douban-metadata-python-") as directory:
        absolute = Path(directory).resolve()
        eq(absolute.parent, Path(tempfile.gettempdir()).resolve())
        assert absolute.name.startswith("fanhao-douban-metadata-python-")
        db_path = absolute / "synthetic.sqlite"
        handles = []

        def open_db():
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            handles.append(conn)
            return conn

        conn = open_db()
        try:
            collector.ensure_db(conn)
            fn(conn, open_db)
        finally:
            for handle in handles:
                handle.close()


def rows(conn):
    return [dict(row) for row in conn.execute("SELECT * FROM movie_metadata ORDER BY media_id")]


def seed(conn):
    collector.upsert_ok(conn, target(), FIXTURE["metas"]["sequel"], b"synthetic-cover-bytes", "image/jpeg")
    conn.execute("UPDATE movie_metadata SET updated_at='sentinel-updated', fetched_at='sentinel-fetched', error='sentinel-error', summary='sentinel-summary' WHERE media_id=?", (target().key,))
    conn.commit()


def run(conn, io, *, two=False, **updates):
    return collector.run(args(**updates), conn=conn, index=index_data(two), cookie_state=("", "", []), context=io.context, page=io.page, sleep_fn=io.sleep, log=lambda *unused: None, playwright_factory=io.forbidden)


for item in FIXTURE["canonical"]:
    test(f'canonical: {item["input"]}', lambda item=item: eq(matcher.canonical_douban_subject_url(item["input"]), item["expected"]))
for item in FIXTURE["clean"]:
    def clean_case(item=item):
        value = matcher.clean_movie_search_title(item["input"])
        for part in item["contains"]:
            assert part in value, f"{value} lost {part}"
        for part in item["excludes"]:
            assert part not in value, f"{value} retained {part}"
    test(f'clean: {item["input"]}', clean_case)
for item in FIXTURE["cases"]:
    def match_case(item=item):
        values = [copy.deepcopy(FIXTURE["metas"][value] if isinstance(value, str) else value) for value in item["candidates"]]
        before = copy.deepcopy(values)
        if item.get("expectedError"):
            raises(lambda: matcher.choose_movie_metadata(item["target"], values), code="METADATA_REVIEW_REQUIRED")
        else:
            result = matcher.choose_movie_metadata(item["target"], values)
            eq(result["doubanId"], item["expectedId"])
            assert any(result is value for value in values)
        eq(values, before, "matching must not mutate inputs")
    test(f'match: {item["name"]}', match_case)


def manual_guard():
    raises(lambda: matcher.validate_manual_movie_metadata(FIXTURE["metas"]["tv"]), code="METADATA_REVIEW_REQUIRED")
    raises(lambda: matcher.validate_manual_movie_metadata({**FIXTURE["metas"]["sequel"], "detailSource": "search"}), code="METADATA_REVIEW_REQUIRED")
    movie = FIXTURE["metas"]["war"]
    assert matcher.validate_manual_movie_metadata(movie) is movie
test("manual override still enforces complete movie evidence", manual_guard)


def manual_run_identity(conn, reopen):
    movie = FIXTURE["metas"]["war"]
    io = FakeIO([movie["doubanUrl"]], [movie])
    result = run(conn, io, two=True, media_id=target().key, douban_id=movie["doubanId"])
    eq(result["ok"], 1)
    eq(result["targets"], 1)
    eq(io.request_urls(), ["https://movie.douban.com/", movie["doubanUrl"]])
    eq(len(rows(conn)), 1)
    eq(rows(conn)[0]["media_id"], target().key)
    eq(rows(conn)[0]["douban_id"], movie["doubanId"])
    io.paced()
test("manual run targets one media ID and bypasses automatic title matching only", lambda: with_db(manual_run_identity))


def invalid_manual_run(conn, reopen):
    for updates in [{"douban_id": "10004"}, {"media_id": target().key, "douban_url": "https://evil.invalid/subject/10004/"}]:
        io = FakeIO()
        result = run(conn, io, two=True, **updates)
        eq(result["exitCode"], 1)
        eq(io.request_urls(), [])
        eq(rows(conn), [])
test("manual run requires a media ID and trusted subject before any request", lambda: with_db(invalid_manual_run))


def manual_tv_run(conn, reopen):
    seed(conn)
    before = rows(conn)
    tv = FIXTURE["metas"]["tv"]
    io = FakeIO([tv["doubanUrl"]], [tv])
    result = run(conn, io, two=True, media_id=target().key, douban_url=tv["doubanUrl"])
    eq(result["failed"], 1)
    eq(result["ok"], 0)
    eq(rows(conn), before)
    eq(io.request_urls(), ["https://movie.douban.com/", tv["doubanUrl"]])
test("manual run cannot write episodic metadata over an existing movie", lambda: with_db(manual_tv_run))


def select_full_movie(suggest=True):
    io = FakeIO(suggest=suggest)
    result = collector.fetch_movie_meta(io.context, io.page, target(), args(), io.pacer())
    eq(result["doubanId"], "10002")
    eq(result["detailSource"], "subject")
    eq([url for url in io.request_urls() if "/subject/" in url], [FIXTURE["metas"]["tv"]["doubanUrl"], FIXTURE["metas"]["sequel"]["doubanUrl"]])
    io.paced()
test("suggest full candidate list rejects first TV and chooses second movie", select_full_movie)
test("empty suggestions fall back to actual HTML href discovery", lambda: select_full_movie(False))


def default_pacing():
    io = FakeIO()
    defaults = collector.parse_args([])
    defaults.jitter = 0
    pace = collector.RequestPacer(defaults, io.sleep, lambda *unused: None)
    collector.fetch_movie_meta(io.context, io.page, target(), defaults, pace)
    io.paced(5)
test("default request pacing is at least five seconds", default_pacing)


def partial_injection():
    original = (collector.read_cookie_state, collector.read_json, sqlite3.connect, collector.sync_playwright)
    calls = []

    def forbidden(*unused, **ignored):
        calls.append("external-access")
        raise AssertionError("real resource access forbidden")

    collector.read_cookie_state = collector.read_json = sqlite3.connect = collector.sync_playwright = forbidden
    try:
        for key in ["conn", "index", "cookie_state", "context", "page"]:
            for omitted in [True, False]:
                injected = dict(conn=object(), index={}, cookie_state=("", "", []), context=object(), page=object())
                if omitted:
                    del injected[key]
                else:
                    injected[key] = None
                error = raises(lambda: collector.run(args(), **injected), kind=ValueError)
                assert "同时提供" in str(error)
        eq(calls, [])
    finally:
        collector.read_cookie_state, collector.read_json, sqlite3.connect, collector.sync_playwright = original
test("partial injection rejects before DB/cookie/browser access", partial_injection)


def candidate_budget():
    metas = [{**copy.deepcopy(FIXTURE["metas"]["tv"]), "doubanId": str(20001 + index), "doubanUrl": f"https://movie.douban.com/subject/{20001 + index}/"} for index in range(8)]
    io = FakeIO([meta["doubanUrl"] for meta in metas], metas)
    raises(lambda: collector.fetch_movie_meta(io.context, io.page, target(), args(), io.pacer()), code="METADATA_REVIEW_REQUIRED")
    eq(len([url for url in io.request_urls() if "/subject/" in url]), 5)
    io.paced()
test("candidate details are limited to five", candidate_budget)


def deduplicated():
    meta = FIXTURE["metas"]["sequel"]
    io = FakeIO(["https://evil.invalid/subject/10002/", meta["doubanUrl"], meta["doubanUrl"]])
    eq(collector.fetch_movie_meta(io.context, io.page, target(), args(), io.pacer())["doubanId"], "10002")
    eq(len(io.request_urls()), 2)
test("foreign/duplicate subjects do not trigger detail requests", deduplicated)


def incomplete_set():
    movie, tv = FIXTURE["metas"]["sequel"], FIXTURE["metas"]["tv"]
    io = FakeIO([movie["doubanUrl"], tv["doubanUrl"]], overrides={tv["doubanUrl"]: {"status": 503}})
    error = raises(lambda: collector.fetch_movie_meta(io.context, io.page, target(), args(), io.pacer()))
    assert "503" in str(error)
    io.paced()
test("one failed detail cannot downgrade to search or partially verified set", incomplete_set)


for redirect in ["https://evil.invalid/subject/10002/", "https://accounts.douban.com/passport/login", FIXTURE["metas"]["tv"]["doubanUrl"]]:
    def redirect_case(redirect=redirect):
        meta = FIXTURE["metas"]["sequel"]
        io = FakeIO([meta["doubanUrl"]], overrides={meta["doubanUrl"]: {"url": redirect, "body": subject_html(meta)}})
        error = raises(lambda: collector.fetch_movie_meta(io.context, io.page, target(), args(), io.pacer()))
        assert "跳转" in str(error)
    test(f"subject response redirect is not verified: {redirect}", redirect_case)


for label, failure in [("403", {"status": 403}), ("418", {"status": 418}), ("429", {"status": 429}), ("captcha", {"body": "请输入验证码"}), ("text rate limit", {"body": "搜索访问太频繁，请稍后再试"})]:
    def blocked(conn, reopen, failure=failure):
        io = FakeIO(overrides={FIXTURE["metas"]["tv"]["doubanUrl"]: failure})
        result = run(conn, io, two=True)
        eq(result["blocked"], True)
        eq(result["exitCode"], 2)
        eq(result["targets"], 2)
        eq(len(io.request_urls()), 3)  # home, suggest, first detail; then stop
        eq(rows(conn), [])
        io.paced()
    test(f"run {label} stops next candidate/target without writes", lambda blocked=blocked: with_db(blocked))


def successful(conn, reopen):
    io = FakeIO()
    result = run(conn, io)
    eq(result["ok"], 1)
    eq(rows(conn)[0]["douban_id"], "10002")
    before = rows(conn)
    conn.close()
    eq(rows(reopen()), before)
    io.paced()
test("real run persists verified subject and survives close/reopen", lambda: with_db(successful))


def failed_refresh(conn, reopen):
    seed(conn)
    before = rows(conn)
    io = FakeIO([FIXTURE["metas"]["tv"]["doubanUrl"]])
    result = run(conn, io)
    eq(result["failed"], 1)
    eq(rows(conn), before)
    conn.close()
    eq(rows(reopen()), before)
test("failed refresh preserves all existing ok columns", lambda: with_db(failed_refresh))


def dry_run(conn, reopen):
    seed(conn)
    before = rows(conn)
    for io in [FakeIO(), FakeIO([FIXTURE["metas"]["tv"]["doubanUrl"]])]:
        run(conn, io, two=True, write=False)
        eq(rows(conn), before)
        io.paced()
test("dry-run success/failure never updates or inserts metadata", lambda: with_db(dry_run))


for status in [500, 403]:
    def cover_fail(conn, reopen, status=status):
        seed(conn)
        before = rows(conn)
        meta = {**copy.deepcopy(FIXTURE["metas"]["sequel"]), "doubanId": "10012", "doubanUrl": "https://movie.douban.com/subject/10012/", "coverUrl": "https://img.doubanio.com/synthetic-cover.jpg"}
        io = FakeIO([meta["doubanUrl"]], [meta], {meta["coverUrl"]: {"status": status}})
        result = run(conn, io, two=True)
        eq([row for row in rows(conn) if row["media_id"] == target().key], before)
        assert meta["coverUrl"] in io.request_urls()
        if status == 403:
            eq(result["blocked"], True)
            eq(len(io.request_urls()), 4)  # home + suggest + detail + cover
        conn.close()
        eq([row for row in rows(reopen()) if row["media_id"] == target().key], before)
        io.paced()
    test(f"new subject cover HTTP {status} keeps existing row intact", lambda cover_fail=cover_fail: with_db(cover_fail))


def no_old_cover(conn, reopen):
    seed(conn)
    meta = {**copy.deepcopy(FIXTURE["metas"]["sequel"]), "doubanId": "10012", "doubanUrl": "https://movie.douban.com/subject/10012/", "coverUrl": ""}
    io = FakeIO([meta["doubanUrl"]], [meta])
    result = run(conn, io)
    row = rows(conn)[0]
    eq(result["ok"], 1)
    eq(row["douban_id"], "10012")
    assert not row["cover_blob"] and not row["cover_bytes"], "new subject must not inherit old subject pixels"
test("different subject without cover cannot inherit old cover", lambda: with_db(no_old_cover))


def cross_target_pacing(conn, reopen):
    io = FakeIO([FIXTURE["metas"]["sequel"]["doubanUrl"]])
    eq(run(conn, io, two=True)["ok"], 2)
    eq(len(io.request_urls()), 5)  # one home, two suggest + detail pairs
    io.paced()
test("pacing spans target boundaries and homepage", lambda: with_db(cross_target_pacing))


def duplicate_index(conn, reopen):
    metas = [{**copy.deepcopy(FIXTURE["metas"]["tv"]), "doubanId": str(21001 + index), "doubanUrl": f"https://movie.douban.com/subject/{21001 + index}/"} for index in range(8)]
    io = FakeIO([meta["doubanUrl"] for meta in metas], metas)
    index = index_data()
    index["mediaItems"].append(copy.deepcopy(index["mediaItems"][0]))
    result = collector.run(args(), conn=conn, index=index, cookie_state=("", "", []), context=io.context, page=io.page, sleep_fn=io.sleep, log=lambda *unused: None, playwright_factory=io.forbidden)
    eq(result["targets"], 1)
    eq(len([url for url in io.request_urls() if "/subject/" in url]), 5)
    io.paced()
test("duplicate index media ID cannot reset five-detail budget", lambda: with_db(duplicate_index))


for label, cover, success, blocked in [
    ("ordinary HTML", {"body": "<html>not a picture</html>", "mime": "text/html"}, False, False),
    ("captcha HTML", {"body": "请输入验证码", "mime": "text/html"}, False, True),
    ("image MIME", {"body": "synthetic-image-bytes", "mime": "image/jpeg"}, True, False),
]:
    def cover_mime(conn, reopen, cover=cover, success=success, blocked=blocked):
        seed(conn)
        before = rows(conn)
        meta = {**copy.deepcopy(FIXTURE["metas"]["sequel"]), "doubanId": "10012", "doubanUrl": "https://movie.douban.com/subject/10012/", "coverUrl": "https://img.doubanio.com/synthetic-cover.jpg"}
        io = FakeIO([meta["doubanUrl"]], [meta], {meta["coverUrl"]: cover})
        result = run(conn, io)
        eq(result["ok"], 1 if success else 0)
        eq(result["blocked"], blocked)
        if success:
            eq(rows(conn)[0]["douban_id"], "10012")
            eq(rows(conn)[0]["cover_blob"], cover["body"].encode("utf-8"))
        else:
            eq(rows(conn), before)
        io.paced()
    test(f"cover {label} response respects atomic metadata update", lambda cover_mime=cover_mime: with_db(cover_mime))


def legacy_scope(**extra):
    scope = {"re": re, "sqlite3": sqlite3, "datetime": datetime, "timezone": timezone, "argparse": argparse, "MovieTarget": collector.MovieTarget, "normalize_spaces": collector.normalize_spaces, "unique": collector.unique, "DoubanNoResultError": collector.DoubanNoResultError, **extra}
    for source in FIXTURE["legacy"]["python"]["functions"].values():
        exec(compile(source, "frozen-legacy-douban-collector.py", "exec"), scope)
    return scope


def legacy_clean():
    value = legacy_scope()["clean_movie_query_title"](FIXTURE["clean"][0]["input"])
    assert "唐顿庄园" in value and "唐顿庄园3" not in value
OLD_TESTS.append(("old cleaner loses sequel digit", legacy_clean))


def legacy_numeric_year():
    value = legacy_scope()["clean_movie_query_title"](FIXTURE["clean"][1]["input"])
    assert "1917" in value and "2019" not in value
OLD_TESTS.append(("old cleaner loses release year of numeric title", legacy_numeric_year))


def legacy_url():
    eq(legacy_scope()["subject_url_from_value"]("https://evil.invalid/subject/10002/"), FIXTURE["metas"]["sequel"]["doubanUrl"])
OLD_TESTS.append(("old URL regex accepts foreign subject path", legacy_url))


def legacy_first():
    io = FakeIO()
    pace = io.pacer()
    scope = legacy_scope(suggest_subject_url=lambda context, query: collector.suggest_subject_urls(context, query, pace)[0], fetch_subject_page_meta=lambda page, url, value: collector.fetch_subject_page_meta(page, url, value, pace))
    result = scope["fetch_movie_meta"](io.context, io.page, target(), args())
    eq(result["doubanId"], "10001")
    assert "第一季" in result["title"]
    eq(len(io.request_urls()), 2)
OLD_TESTS.append(("old real fetch accepts first TV candidate without film validation", legacy_first))


def legacy_upsert(conn, reopen):
    seed(conn)
    before = rows(conn)
    legacy_scope()["upsert_error"](conn, target(), RuntimeError("synthetic failure"))
    eq(rows(conn)[0]["status"], "error")
    assert rows(conn) != before
OLD_TESTS.append(("old SQL error upsert overwrites existing ok row", lambda: with_db(legacy_upsert)))


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass
    failed, old_passed = 0, 0
    for name, fn in TESTS:
        try:
            fn()
            print(f"PASS {name}")
        except Exception:
            failed += 1
            print(f"FAIL {name}", file=sys.stderr)
            traceback.print_exc()
    scenario_failures = failed
    for name, fn in OLD_TESTS:
        try:
            fn()
            old_passed += 1
            print(f"OLD-RED {name}")
        except Exception:
            failed += 1
            print(f"FAIL old control {name}", file=sys.stderr)
            traceback.print_exc()
    print(f"Douban movie metadata Python: {len(TESTS) - scenario_failures}/{len(TESTS)} scenarios; {old_passed}/{len(OLD_TESTS)} executable old controls")
    for name in ["backfill_douban_movie_metadata_browser.py", "douban_movie_match.py"]:
        print(f"{name} SHA256 {hashlib.sha256((ROOT / 'tools' / name).read_bytes()).hexdigest()}")
    print("Boundary: synthetic page/context only; actual BeautifulSoup and temporary SQLite; no browser launched or live Douban access.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
