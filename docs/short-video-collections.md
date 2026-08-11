# Short-video collection contract

Custom collections are local-user metadata over the canonical short-video catalog. They do not copy or own media files.

## API

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/short-videos/collections` | Ordered collection summaries |
| `POST` | `/api/short-videos/collections` | Create a collection |
| `PATCH` | `/api/short-videos/collections/:collectionId` | Rename a collection |
| `DELETE` | `/api/short-videos/collections/:collectionId` | Delete a collection and its memberships |
| `GET` | `/api/short-videos/collections/:collectionId/videos?limit=&cursor=` | Videos ordered by newest membership first; returns `nextCursor` |
| `GET` | `/api/short-videos/collections/:collectionId/videos/:videoId` | Membership-scoped video detail and previous/next members |
| `PUT` | `/api/short-videos/collections/:collectionId/videos/:videoId` | Add a video idempotently |
| `DELETE` | `/api/short-videos/collections/:collectionId/videos/:videoId` | Remove a video idempotently |

Every mutation uses the existing local-admin/same-origin gate. Reads follow the existing local-library read policy.

Collection names are NFKC-normalized, internal whitespace is collapsed, and leading/trailing whitespace is removed. A name must contain 1–40 Unicode characters after normalization. Names are unique per local user with case-insensitive comparison. Invalid input returns `400`, missing collections/videos return `404`, and normalized name conflicts return `409`.

Pagination uses the opaque `(added_at, video_id)` keyset cursor returned as `nextCursor`; clients must not construct or edit it. `total` and each page are read from one SQLite snapshot. A video detail request succeeds only when the video belongs to that collection, including members beyond the first page. Short-lived SQLite lock contention returns a sanitized retryable `503` response.

The API accepts a canonical catalog id or an existing aweme id for video membership, but stores and returns the canonical video id. Repeating an add or remove succeeds without changing the original add time. Database foreign keys cascade memberships when either the catalog video or collection is deleted; deleting a collection never deletes video records or files. The database also enforces `(local_user_id, normalized_name)` uniqueness.

## Client routes

The Web client uses these stable paths:

- `/short-videos/collections/:collectionId`
- `/short-videos/collections/:collectionId/videos/:videoId`

Collection playback uses membership order and loads another API page when playback reaches the end of the currently loaded page. The Android Web client uses the same API and preserves its collection views in the existing hash/history navigation contract; native playback receives the collection feed URL and requires no new Android permission.
