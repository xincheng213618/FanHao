from __future__ import annotations

import re
import unicodedata


QUALITY_AND_SITE_NOISE = [
    re.compile(r"\b(?:2160P|1440P|1080P|720P|480P|4K|8K|UHD|FHD|HD|SD)\b", re.I),
    re.compile(r"\b(?:H\.?264|H\.?265|X264|X265|HEVC|AVC|AAC|MP3)\b", re.I),
    re.compile(r"\b(?:UNCENSORED|LEAK|HACK|CHS|CHT|SUB|SUBBED|字幕|中文字幕)\b", re.I),
    re.compile(r"(?:^|[\s._@-])(?:WWW\.)?[A-Z0-9][A-Z0-9]{1,63}\.(?:COM|NET|ORG|XYZ|TV|CC|ME|CLUB|JP|INFO|BIZ|VIP|ONE|LA|APP|TW|US|DE)(?:\s*[@._-]|\s+|$)", re.I),
]

BAD_PREFIXES = {
    "AAC",
    "AVC",
    "BLURAY",
    "CARIBBEANCOM",
    "CHANNEL",
    "CHS",
    "CHT",
    "FHD",
    "FULL",
    "HD",
    "HEVC",
    "LT",
    "MP4",
    "PPV",
    "SUB",
    "TOKYOHOT",
    "UHD",
    "WEB",
    "X264",
    "X265",
}


def normalize_code(value: str | None) -> str:
    parsed = parse_code(value)
    return parsed["code"] if parsed else ""


def loose_code_key(value: str | None) -> str:
    code = normalize_code(value)
    return re.sub(r"[^A-Z0-9]", "", code, flags=re.I).lower() if code else ""


def code_key(value: str | None) -> str:
    return loose_code_key(value)


def stored_code_key(value: str | None) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or ""), flags=re.I).lower()


def extract_codes(value: str | None) -> list[str]:
    text = clean_code_text(value)
    if not text:
        return []

    matches = []
    for definition in [*special_patterns(), *standard_patterns()]:
        collect_matches(matches, text, definition)

    matches.sort(key=lambda item: (-item["score"], item["index"]))
    seen = set()
    codes = []
    for item in matches:
        key = stored_code_key(item["code"])
        if not key or key in seen:
            continue
        seen.add(key)
        codes.append(item["code"])
    return codes


def parse_code(value: str | None) -> dict | None:
    text = clean_code_text(value)
    if not text:
        return None

    matches = []
    for definition in special_patterns():
        collect_matches(matches, text, definition)
    for definition in standard_patterns():
        collect_matches(matches, text, definition)

    matches.sort(key=lambda item: (-item["score"], item["index"]))
    return matches[0] if matches else None


def special_patterns() -> list[dict]:
    return [
        {
            "type": "fc2",
            "pattern": re.compile(r"\bFC2(?:[-_\s.]?PPV)?[-_\s.]?0*(\d{4,9})(?=$|\D)", re.I),
            "format": lambda match: f"FC2-PPV-{strip_leading_zeros(match.group(1))}",
        },
        {
            "type": "heyzo",
            "pattern": re.compile(r"\bHEYZO(?:[-_\s.]?(?:HD|LT|FULL))*[-_\s.]*0*(\d{3,6})(?:[-_\s.]?(?:HD|LT|FULL))*\b", re.I),
            "format": lambda match: f"HEYZO-{strip_leading_zeros(match.group(1))}",
        },
        {
            "type": "heydouga",
            "pattern": re.compile(r"\bHEYDOUGA[-_\s.]?(\d{4})[-_\s.]?(\d{3,5})\b", re.I),
            "format": lambda match: f"HEYDOUGA-{match.group(1)}-{strip_leading_zeros(match.group(2))}",
        },
        {
            "type": "xxx-av",
            "pattern": re.compile(r"\bXXX[-_\s.]?AV[-_\s.]?0*(\d{3,6})\b", re.I),
            "format": lambda match: f"XXX-AV-{strip_leading_zeros(match.group(1))}",
        },
        {
            "type": "date-id",
            "pattern": re.compile(r"\b(\d{6})[-_](\d{2,4})\b", re.I),
            "format": lambda match: f"{match.group(1)}-{match.group(2)}",
        },
        {
            "type": "western-date",
            "pattern": re.compile(r"\b([A-Z][A-Z0-9]{1,17}[A-Z])[-_.](\d{2})[-_.](\d{2})[-_.](\d{2})\b", re.I),
            "format": lambda match: f"{match.group(1).upper()}.{match.group(2)}.{match.group(3)}.{match.group(4)}",
        },
        {
            "type": "prefix-code",
            "pattern": re.compile(
                r"\b(3DSVR|CW3D2D?BD|MCB3D(?:BD)?|S2M(?:BD)?|T28|T38|TH101|KIN8(?:TENGOKU)?|GACHI|C0930|H0930|H4610|RED|GEDO|CZ|N|K|SE)[-_\s.]?0*([A-Z]?\d{2,8}(?:[-_]\d{2,6})?[A-Z]?)\b",
                re.I,
            ),
            "format": lambda match: f"{normalize_prefix(match.group(1))}-{normalize_code_number(match.group(2))}",
        },
    ]


def standard_patterns() -> list[dict]:
    return [
        {
            "type": "standard",
            "pattern": re.compile(r"\b\d{2,6}[-_\s.]?([A-Z]{2,12})[-_\s﹣－–—.]?0*(\d{2,8}[A-Z]?)\b", re.I),
            "format": lambda match: f"{match.group(1).upper()}-{normalize_code_number(match.group(2))}",
        },
        {
            "type": "standard",
            "pattern": re.compile(r"\b([A-Z]{2,12})[-_\s﹣－–—.]?0*(\d{2,8}[A-Z]?)\b", re.I),
            "format": lambda match: f"{match.group(1).upper()}-{normalize_code_number(match.group(2))}",
        },
        {
            "type": "lettered",
            "pattern": re.compile(r"\b([A-Z]{2,12})[-_\s﹣－–—.]?([A-Z]{1,5}0*\d{2,8}[A-Z]?)\b", re.I),
            "format": lambda match: f"{match.group(1).upper()}-{normalize_code_number(match.group(2))}",
        },
    ]


def collect_matches(target: list[dict], text: str, definition: dict) -> None:
    for match in definition["pattern"].finditer(text):
        code = definition["format"](match)
        if not is_useful_code(code):
            continue
        target.append(
            {
                "code": code,
                "key": stored_code_key(code),
                "type": definition["type"],
                "index": match.start(),
                "score": score_code(code, definition["type"], match.start()),
            }
        )


def clean_code_text(value: str | None) -> str:
    text = unicodedata.normalize("NFKC", str(value or ""))
    text = text.replace("\\", "/").replace("_", "-")
    text = re.sub(r"\.[A-Z0-9]{1,5}$", " ", text, flags=re.I)
    text = re.sub(r"\b20\d{2}[-_.年]\d{1,2}[-_.月]\d{1,2}日?\b", " ", text)
    text = re.sub(r"\b\d{4}[-_.]\d{1,2}[-_.]\d{1,2}\b", " ", text)
    text = text.upper()
    text = re.sub(r"[()[\]{}【】]", " ", text)
    for pattern in QUALITY_AND_SITE_NOISE:
        text = pattern.sub(" ", text)
    text = re.sub(r"[-\s.]{2,}", "-", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_prefix(value: str) -> str:
    return re.sub(r"TENGOKU$", "", str(value or "").upper())


def normalize_code_number(value: str) -> str:
    raw = re.sub(r"[_\s.]", "-", str(value or "").upper())
    match = re.match(r"^([A-Z]*?)0*(\d+)(.*)$", raw)
    if not match:
        return raw
    head, digits, tail = match.groups()
    stripped = strip_leading_zeros(digits)
    min_width = 3 if len(digits) <= 3 else len(digits)
    return f"{head}{stripped.zfill(min_width)}{tail}"


def strip_leading_zeros(value: str) -> str:
    stripped = re.sub(r"^0+", "", str(value or ""))
    return stripped or "0"


def is_useful_code(code: str) -> bool:
    prefix = str(code or "").split("-", 1)[0].upper()
    if not prefix or prefix in BAD_PREFIXES:
        return False
    if re.fullmatch(r"HEYDOUGA-\d{4}", code or "", re.I):
        return False
    if re.fullmatch(r"\d{3,4}P", prefix):
        return False
    if re.fullmatch(r"20\d{2}", prefix):
        return False
    return bool(re.search(r"[A-Z]", code, re.I) or re.fullmatch(r"\d{6}-\d{2,4}", code))


def score_code(code: str, code_type: str, index: int) -> int:
    score = 100
    if code_type not in {"standard", "lettered"}:
        score += 30
    if code_type == "standard":
        score += 12
    if "-" in code:
        score += 8
    if index == 0:
        score += 6
    if re.match(r"^(FC2|HEYZO|HEYDOUGA|XXX-AV)", code, re.I):
        score += 20
    if re.match(r"^[A-Z]{2,12}-\d{3,}", code):
        score += 10
    if re.match(r"^\d{6}-\d{2,4}$", code):
        score += 8
    return score
