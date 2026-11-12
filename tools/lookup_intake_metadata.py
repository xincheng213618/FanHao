"""Read one work through the same 115Chrome-backed JavDB client as metadata backfill."""

import argparse
from copy import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from time import sleep

from selenium.common.exceptions import SessionNotCreatedException

from backfill_javdb_metadata import AccessBlockedError, JavDbClient, configure_stdout, load_scraper_config, parse_args, parse_detail_page


def read_metadata(client, code, detail_url):
    if detail_url:
        driver = client.get_driver()
        for attempt in range(2):
            driver.get(detail_url)
            status = driver.execute_script("return performance.getEntriesByType('navigation')[0]?.responseStatus")
            if status not in (502, 503, 504) or attempt == 1:
                break
            sleep(1.5)
        if isinstance(status, int) and 400 <= status <= 599:
            return {"upstreamStatus": status}
        # The page must supply its own code for the intake service to compare.
        metadata = parse_detail_page(client.wait_for_detail_page(), driver.current_url, driver.title or "",
                                     fallback_code="", config=client.scraper_config)
    else:
        metadata = client.fetch_by_code(code)
    return None if metadata is None else {
        "code": metadata.code, "title": metadata.title,
        "actors": metadata.actors or [], "tags": metadata.tags or [],
        "date": metadata.release_date, "durationMinutes": metadata.duration_minutes,
        "rating": metadata.rating, "maker": metadata.maker, "series": metadata.series,
        "director": metadata.director, "imageUrl": metadata.image_url,
        "detailUrl": metadata.detail_url,
    }


def lookup_in_profile(args, detail_url):
    client = JavDbClient(args)
    try:
        return read_metadata(client, args.code[0], detail_url)
    except AccessBlockedError as error:
        reason = str(error)
        return {"accessBlocked": "login" if "登录" in reason or "登入" in reason else "blocked"}
    finally:
        client.close()


def lookup_metadata(args, detail_url):
    # The dedicated Chrome profile can reuse its own login while 115Chrome locks its database.
    if (args.profile_dir / "Local State").is_file() and args.profile_dir.resolve() != args.cookie_profile_dir.resolve():
        shared = copy(args)
        shared.cookie_profile_dir = None
        try:
            result = lookup_in_profile(shared, detail_url)
        except SessionNotCreatedException:
            pass  # Another JavDB tool may already be using the shared profile.
        else:
            if result is None or result.get("accessBlocked") != "login":
                return result

    with TemporaryDirectory(prefix="fanhao-intake-") as profile:
        temporary = copy(args)
        temporary.profile_dir = Path(profile)
        return lookup_in_profile(temporary, detail_url)


def main():
    configure_stdout()
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    parser.add_argument("--detail-url", default="")
    options, remaining = parser.parse_known_args()
    args = parse_args(remaining)
    if len(args.code) != 1 or not args.cookie_profile_dir:
        raise SystemExit("Expected one code and the 115Chrome profile")
    args.scraper_config_data = load_scraper_config(args.scraper_config)
    args.headless = True
    result = lookup_metadata(args, options.detail_url)
    print("FANHAO_INTAKE_METADATA=" + json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
