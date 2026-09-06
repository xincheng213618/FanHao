"""Pure conservative movie identity checks; mirrors lib/douban-movie-match.js.

Search snippets discover candidates only. This module has no I/O or dependencies.
"""
import math
import re
import unicodedata
from urllib.parse import parse_qs, urlsplit


class MovieMetadataMatchError(ValueError):
    code = "METADATA_REVIEW_REQUIRED"

    def __init__(self, reason):
        self.reason = reason
        super().__init__(f"电影资料待核对：{reason}")


def _text(value):
    return "" if value is None else str(value)


def canonical_douban_subject_url(value):
    text = re.sub(r"&amp;", "&", _text(value).strip(), flags=re.I)
    if not text or re.search(r"[\s<>\"']", text):
        return ""
    if re.fullmatch(r"/subject/\d+/?(?:[?#].*)?", text, flags=re.ASCII):
        text = f"https://movie.douban.com{text}"
    try:
        url = urlsplit(text)
        if url.scheme not in {"http", "https"} or url.username or url.password:
            return ""
        if url.port is not None and url.port != (443 if url.scheme == "https" else 80):
            return ""
        if url.hostname == "movie.douban.com" and re.fullmatch(r"/subject/\d+/?", url.path, flags=re.ASCII):
            return f"https://movie.douban.com/subject/{url.path.split('/')[2]}/"
        if url.hostname in {"www.douban.com", "douban.com", "search.douban.com"} and re.fullmatch(r"/link2?/?", url.path):
            target = parse_qs(url.query).get("url", [""])[0]
            if urlsplit(target).hostname != "movie.douban.com":
                return ""
            return canonical_douban_subject_url(target)
    except (ValueError, TypeError):
        pass
    return ""


_RELEASE_TOKEN = re.compile(
    r"\b(?:2160p|1080p|720p|480p|4k|8k|uhd|remux|bluray|blu[-_. ]?ray|web[-_. ]?dl|hdtv|hdr10?\+?|dv|hevc|x265|x264|h[. ]?264|h[. ]?265|aac|dts|truehd|atmos|proper|repack)\b",
    re.I | re.ASCII,
)


def _nfkc(value):
    return unicodedata.normalize("NFKC", _text(value))


def _letter_or_number(char):
    return unicodedata.category(char)[0] in "LN"


def _east_asian(text):
    return any(any(script in unicodedata.name(char, "") for script in ["CJK", "HIRAGANA", "KATAKANA", "HANGUL"]) for char in text)


def _latin_or_number(char):
    return "LATIN" in unicodedata.name(char, "") or unicodedata.category(char).startswith("N")


def _latin_name(text):
    return bool(text) and _latin_or_number(text[0]) and all(
        _latin_or_number(char) or unicodedata.category(char)[0] in "PS" or unicodedata.category(char) == "Zs"
        for char in text
    )


def _local_title_parts(value, from_path=False):
    text = _nfkc(value)
    text = (re.split(r"[\\/]", text)[-1] if from_path else text).strip()
    text = re.sub(r"\.(?:mkv|mp4|m2ts|ts|avi|mov|wmv)$", "", text, flags=re.I)
    text = re.sub(r"[._]+", " ", text)
    years = [match for match in re.finditer(r"(?<!\d)(?:19|20)\d{2}(?!\d)", text, flags=re.ASCII)
             if any(_letter_or_number(char) for char in text[:match.start()])
             and (match.start() == 0 or re.match(r"[\s([{（【]", text[match.start() - 1]))
             and (match.end() == len(text) or re.match(r"[\s)\]}）】-]", text[match.end()]))]
    year = years[-1].group() if years else ""
    if years:
        text = re.sub(r"[\s([{（【]+$", "", text[:years[-1].start()])

    def clean_bracket(match):
        remaining = re.sub(r"[\s\d.,+-]+", "", _RELEASE_TOKEN.sub("", match.group(1)), flags=re.ASCII)
        return match.group() if remaining else " "

    text = re.sub(r"\[([^\]]*)\]", clean_bracket, text)
    text = _RELEASE_TOKEN.sub(" ", text)
    text = re.sub(r"\b\d+(?:[.,]\d+)?\s*(?:gb|mb)\b", " ", text, flags=re.I | re.ASCII)
    return {"title": re.sub(r"\s+", " ", text).strip(), "year": year}


def _normalize_title(value):
    return "".join(char for char in _nfkc(value).lower() if _letter_or_number(char))


def _title_variants(value):
    text = re.sub(r"\((?:港|台|中国大陆|香港|台湾|新加坡|马来西亚)\)\s*$", "", _nfkc(value)).strip()
    variants = {_normalize_title(text)}
    splits = list(re.finditer(r"\s+", text))
    for split in splits:
        left, right = text[:split.start()], text[split.end():]
        if left and _latin_name(right) and _east_asian(left):
            variants.update([_normalize_title(left), _normalize_title(right)])
            break
    for split in splits:
        left, right = text[:split.start()], text[split.end():]
        if _latin_name(left) and right and _east_asian(right):
            variants.update([_normalize_title(left), _normalize_title(right)])
            break
    variants.discard("")
    return variants


def clean_movie_search_title(value):
    parts = _local_title_parts(value)
    title = parts["title"]
    name = title
    for split in re.finditer(r"\s+", title):
        left, right = title[:split.start()], title[split.end():]
        if left and right and re.match(r"[A-Za-z]", right) and _latin_name(right) and _east_asian(left):
            name = left
            break
    return " ".join(part for part in [name, parts["year"]] if part)


def movie_match_target(target=None):
    target = target or {}
    primary = target.get("movieTitle") or target.get("movie_title") or target.get("title") or target.get("searchTitle") or target.get("search_title") or ""
    samples = target.get("samples") if isinstance(target.get("samples"), list) else []
    primary_text = re.sub(r"\s+", " ", _nfkc(primary)).strip()
    samples = [sample for sample in samples if re.sub(r"\s+", " ", _nfkc(sample)).strip() != primary_text]
    parts = [_local_title_parts(primary), *(_local_title_parts(value, True) for value in samples)]
    years = list(dict.fromkeys(part["year"] for part in parts if part["year"]))
    titles = set().union(*(_title_variants(part["title"]) for part in parts))
    return {"titles": titles, "year": years[0] if years else "", "conflictingYears": len(years) > 1}


def _positive_count(value):
    if value is None or value == "" or isinstance(value, bool):
        return False
    try:
        number = float(value)
        return math.isfinite(number) and number > 0
    except (TypeError, ValueError, OverflowError):
        return False


def _has_text(value):
    return isinstance(value, str) and bool(value.strip())


def _candidate_failure(meta):
    if not isinstance(meta, dict) or meta.get("detailSource") != "subject" or not _has_text(meta.get("title")) or not canonical_douban_subject_url(meta.get("doubanUrl")):
        return "incomplete-subject"
    info = meta.get("info") if isinstance(meta.get("info"), dict) else {}
    json_ld = meta.get("jsonLd") if isinstance(meta.get("jsonLd"), dict) else {}
    raw_types = []
    for value in [meta.get("subjectType"), meta.get("@type"), json_ld.get("@type")]:
        raw_types.extend(value if isinstance(value, list) else [value])
    types = [re.split(r"[/#]", _text(value))[-1].lower() for value in raw_types if value]
    episodic = any(value in {"tvseries", "tvseason", "tvepisode"} for value in types) or _positive_count(meta.get("seasonCount")) or _positive_count(meta.get("episodeCount")) or _has_text(meta.get("episodeDuration"))
    episodic = episodic or any(re.search(r"[1-9]\d*", _text(info.get(key)), flags=re.ASCII) for key in ["季数", "集数"]) or _has_text(info.get("单集片长"))
    if episodic:
        return "episodic-subject"
    if "movie" not in types and not (_has_text(info.get("上映日期")) and _has_text(info.get("片长"))):
        return "unknown-subject-type"
    return ""


def inspect_movie_candidate(target, meta):
    failure = _candidate_failure(meta)
    if failure:
        return {"matched": False, "reason": failure}
    local = movie_match_target(target)
    if local["conflictingYears"]:
        return {"matched": False, "reason": "conflicting-local-years"}
    if not local["titles"]:
        return {"matched": False, "reason": "missing-local-title"}
    aliases = meta.get("aliases") if isinstance(meta.get("aliases"), list) else []
    remote_titles = set().union(*(_title_variants(title) for title in [meta.get("title"), meta.get("originalTitle"), *aliases]))
    if not remote_titles.intersection(local["titles"]):
        return {"matched": False, "reason": "title-mismatch"}
    if local["year"] and _text(meta.get("year")).strip() != local["year"]:
        return {"matched": False, "reason": "year-mismatch"}
    return {"matched": True, "reason": ""}


def choose_movie_metadata(target, candidates):
    matches = {}
    for candidate in candidates or []:
        if inspect_movie_candidate(target, candidate)["matched"]:
            matches[canonical_douban_subject_url(candidate.get("doubanUrl"))] = candidate
    if len(matches) != 1:
        raise MovieMetadataMatchError("ambiguous-subjects" if matches else "no-confirmed-movie")
    return next(iter(matches.values()))


def validate_manual_movie_metadata(meta):
    failure = _candidate_failure(meta)
    if failure:
        raise MovieMetadataMatchError(failure)
    return meta
