# FanHao Core Database

This document describes the normalized FanHao core database introduced in `data/fanhao-core-v2.sqlite`.

The design center is the work code: a code identifies the user-visible work, while the database uses integer ids for stable relationships.

## Principles

- `id` is the internal primary key for every main entity.
- `code` is the display work code, for example `IPX-247`.
- `code_search` is a normalized search helper, for example `ipx247`. It is indexed but not unique.
- Duplicate codes are allowed. Relationships always bind to `works.id`, not to `code`.
- External site identifiers are stored in `*_external_refs` tables.
- Image rows are assets owned by a work or a person. They are not separate local/remote cache domains.
- Rankings, TOP250 lists, and later manual lists are collections of works.

## Main Tables

### Works

`works` is the central table.

Important columns:

- `id`: integer primary key.
- `code`: display code.
- `code_search`: normalized search form.
- `title`, `release_date`, `duration_minutes`, `rating`, `rating_count`: work metadata.
- `raw_text`, `fields_json`: imported metadata payloads kept for audit and future extraction.

`code_search` has a normal index. It deliberately has no unique constraint.

### Local Works

`local_works` binds local files or folders to `works.id`.

Important columns:

- `work_id`: target work.
- `local_path`: local work folder.
- `source_info_path`: source `info.txt` path when migrated from the legacy database.
- `detected_code`, `detected_code_search`: code found locally.

### External References

External identifiers are separate from main tables:

- `work_external_refs`
- `person_external_refs`
- `maker_external_refs`
- `series_external_refs`

Each table uses `UNIQUE(provider, external_key)`.

Examples:

- `provider = 'javdb-video'`, `external_key = 'k64J'`
- `provider = 'javdb-actor'`, `external_key = 'eBNR'`
- `provider = 'javdb-maker'`, `external_key = '6M'`

### People

`people` stores local and network actor/person records.

`work_people` links works to people and stores a role such as `actor`.

Aliases are stored in `person_aliases`.

### Makers And Series

`makers` stores makers, labels, and studio-like entities.

`series` stores series and inferred prefix groups. A series can belong to a maker.

Relationship tables:

- `work_makers`: links works to makers with role `maker` or `label`.
- `work_series`: links works to series.

### Images

`images` replaces the old split mental model of `local_image_cache` and `remote_image_cache`.

Important columns:

- `owner_type`: `work` or `person`.
- `owner_id`: id of the owning work or person.
- `kind`: `cover`, `preview`, `avatar`, etc.
- `source_type`: `local`, `remote`, `generated`, or `unknown`.
- `local_path`, `remote_url`, `storage_path`: where the image comes from or is stored.
- `mime`, `byte_size`: lightweight metadata.

The migration copies available image blobs into `images.image_blob` when they are already present in the old local/remote image stores. This keeps the new image model owner-based while avoiding the old split between local and remote cache tables.

### Collections

`collections` stores TOP250 and similar work lists.

`collection_items` links a collection to works and stores `rank_no` plus ranking-time snapshots such as title and rating.

This makes TOP250 a work collection rather than a special person.

### Logs

`work_logs` is reserved for future work events such as scrape, local match, image download, and manual edit.
