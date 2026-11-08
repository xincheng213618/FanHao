"""Read one work through the same 115Chrome-backed JavDB client as metadata backfill."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from backfill_javdb_metadata import JavDbClient, configure_stdout, load_scraper_config, parse_args


def main():
    configure_stdout()
    args = parse_args()
    if len(args.code) != 1 or not args.cookie_profile_dir:
        raise SystemExit("Expected one code and the 115Chrome profile")
    args.scraper_config_data = load_scraper_config(args.scraper_config)
    args.headless = True
    with TemporaryDirectory(prefix="fanhao-intake-") as profile:
        args.profile_dir = Path(profile)
        client = JavDbClient(args)
        try:
            metadata = client.fetch_by_code(args.code[0])
            result = None if metadata is None else {
                "code": metadata.code, "title": metadata.title,
                "actors": metadata.actors or [], "tags": metadata.tags or [],
                "date": metadata.release_date, "durationMinutes": metadata.duration_minutes,
                "rating": metadata.rating, "maker": metadata.maker, "series": metadata.series,
                "director": metadata.director, "imageUrl": metadata.image_url,
                "detailUrl": metadata.detail_url,
            }
            print("FANHAO_INTAKE_METADATA=" + json.dumps(result, ensure_ascii=False), flush=True)
        finally:
            client.close()


if __name__ == "__main__":
    main()
