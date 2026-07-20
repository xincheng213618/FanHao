import time
from typing import Any, Dict

from core.downloader_base import BaseDownloader, DownloadResult
from utils.logger import setup_logger
from utils.timing import elapsed_ms, timing_event

logger = setup_logger("VideoDownloader")


class VideoDownloader(BaseDownloader):
    async def download(self, parsed_url: Dict[str, Any]) -> DownloadResult:
        started = time.monotonic()
        result = DownloadResult()

        aweme_id = parsed_url.get("aweme_id")
        if not aweme_id:
            logger.error("No aweme_id found in parsed URL")
            result.add_error("No aweme_id found in parsed URL")
            return result

        timing_event("video_download_begin", aweme_id=aweme_id)
        result.total = 1
        self._progress_set_item_total(1, "单作品下载")
        self._progress_update_step("下载作品", "单作品资源下载中")

        should_started = time.monotonic()
        should_download = await self._should_download(aweme_id)
        if not should_download and not self._comments_config():
            logger.info("Video %s already downloaded, skipping", aweme_id)
            result.skipped += 1
            self._progress_advance_item("skipped", str(aweme_id))
            timing_event(
                "video_download_skip_local",
                aweme_id=aweme_id,
                elapsed_ms=elapsed_ms(started),
                should_download_ms=elapsed_ms(should_started),
            )
            return result

        detail_started = time.monotonic()
        await self.rate_limiter.acquire()

        aweme_data = await self.api_client.get_video_detail(aweme_id)
        timing_event(
            "video_detail_done",
            aweme_id=aweme_id,
            ok=bool(aweme_data),
            elapsed_ms=elapsed_ms(detail_started),
        )
        if not aweme_data:
            last_error = str(getattr(self.api_client, "last_error", "") or "").strip()
            message = f"Failed to get video detail: {aweme_id}"
            if last_error:
                message = f"{message} ({last_error})"
            logger.error("%s", message)
            result.failed += 1
            result.add_error(message)
            self._progress_advance_item("failed", str(aweme_id))
            timing_event(
                "video_download_done",
                aweme_id=aweme_id,
                status="failed_detail",
                elapsed_ms=elapsed_ms(started),
                total=result.total,
                success=result.success,
                failed=result.failed,
                skipped=result.skipped,
            )
            return result

        if not should_download:
            if await self._collect_comments_for_existing_video(aweme_data):
                logger.info("Collected comments for already-downloaded video %s", aweme_id)
                result.success += 1
                self._progress_advance_item("success", str(aweme_id))
            else:
                logger.info("Video %s already downloaded, skipping", aweme_id)
                result.skipped += 1
                self._progress_advance_item("skipped", str(aweme_id))
            timing_event(
                "video_download_done",
                aweme_id=aweme_id,
                status="comments_collected" if result.success else "skipped_local",
                elapsed_ms=elapsed_ms(started),
                total=result.total,
                success=result.success,
                failed=result.failed,
                skipped=result.skipped,
            )
            return result

        asset_started = time.monotonic()
        success = await self._download_aweme(aweme_data)
        timing_event(
            "video_assets_done",
            aweme_id=aweme_id,
            success=success,
            elapsed_ms=elapsed_ms(asset_started),
        )
        if success:
            result.success += 1
            self._progress_advance_item("success", str(aweme_id))
        else:
            result.failed += 1
            result.add_error(f"Failed to download aweme assets: {aweme_id}")
            self._progress_advance_item("failed", str(aweme_id))

        timing_event(
            "video_download_done",
            aweme_id=aweme_id,
            status="success" if success else "failed_assets",
            elapsed_ms=elapsed_ms(started),
            total=result.total,
            success=result.success,
            failed=result.failed,
            skipped=result.skipped,
        )
        return result

    async def _collect_comments_for_existing_video(self, aweme_data: Dict[str, Any]) -> bool:
        author = aweme_data.get("author", {}) or {}
        author_name = author.get("nickname", "unknown")
        return await self._collect_comments_for_existing_aweme(aweme_data, author_name)

    async def _download_aweme(self, aweme_data: Dict[str, Any]) -> bool:
        author = aweme_data.get("author", {}) or {}
        author_name = author.get("nickname", "unknown")
        # Cache author on the hosting job so JobRow can display the nickname
        # and `retry_failed_awemes` doesn't need to re-fetch user info.
        self._progress_report_author(
            nickname=author_name if author_name != "unknown" else None,
            sec_uid=author.get("sec_uid"),
        )
        return await self._download_aweme_assets(aweme_data, author_name)
