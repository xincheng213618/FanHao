# 离线工具

这里保留实际执行扫描、采集、整理、迁移、修复和构建的工具。应用后台任务也会调用其中一部分；这些源码不属于可删除的临时产物。

验证脚本、诊断工具、测试服务和样本已移到 [`../tests/`](../tests/README.md)。日常检查仍运行 `npm run verify`。

## 按用途查找

| 分类 | 工具 |
| --- | --- |
| 下载后整理与归档 | [`fanhao.py`](fanhao.py)、[`movefile.py`](movefile.py)、[`clean.py`](clean.py)、[`fanhao_file_workflows.mjs`](fanhao_file_workflows.mjs)、[`windows_folder_move.ps1`](windows_folder_move.ps1) |
| 人物目录与身份 | [`organize_person_library.mjs`](organize_person_library.mjs)、[`fetch_person_organization_metadata.py`](fetch_person_organization_metadata.py)、[`audit_person_identities.mjs`](audit_person_identities.mjs) |
| JavDB 资料采集 | [`javdb.py`](javdb.py)、[`javlibrary.py`](javlibrary.py)、[`run_javdb_source_pipeline.py`](run_javdb_source_pipeline.py)、[`import_javdb_actor.py`](import_javdb_actor.py)、[`batch_import_javdb_actors.py`](batch_import_javdb_actors.py)、[`refresh_core_javdb_actor_movies.py`](refresh_core_javdb_actor_movies.py) |
| 番号资料补全与同步 | [`backfill_javdb_actor_page.py`](backfill_javdb_actor_page.py)、[`backfill_javdb_metadata.py`](backfill_javdb_metadata.py)、[`cache_javdb_rankings.py`](cache_javdb_rankings.py)、[`import_info_metadata.mjs`](import_info_metadata.mjs)、[`sync_core_info_metadata.mjs`](sync_core_info_metadata.mjs)、[`sync_javdb_sidecars.py`](sync_javdb_sidecars.py)、[`full_scan_core_library.py`](full_scan_core_library.py) |
| 番号资料检查与维修 | [`repair_invalid_fanhao_ratings.mjs`](repair_invalid_fanhao_ratings.mjs)、[`report_metadata_quality.mjs`](report_metadata_quality.mjs)、[`report_missing_local_by_actor.py`](report_missing_local_by_actor.py)、[`report_scan_noise.mjs`](report_scan_noise.mjs) |
| 影视资料补全 | [`backfill_douban_movie_metadata.mjs`](backfill_douban_movie_metadata.mjs)、[`backfill_douban_movie_metadata_browser.py`](backfill_douban_movie_metadata_browser.py)、[`backfill_douban_tv_metadata.mjs`](backfill_douban_tv_metadata.mjs) |
| 图库扫描与采集 | [`rescan_image_library.mjs`](rescan_image_library.mjs)、[`import_tuimzz_downloads.py`](import_tuimzz_downloads.py)、[`sync_tuimzz_photo_sets.py`](sync_tuimzz_photo_sets.py)、[`archive_image_reader.py`](archive_image_reader.py) |
| 封面与图像缓存 | [`generate_missing_covers.mjs`](generate_missing_covers.mjs)、[`cache_local_images.py`](cache_local_images.py)、[`cache_remote_images.py`](cache_remote_images.py)、[`cache_remote_images_node.mjs`](cache_remote_images_node.mjs)、[`core_image_cache_cleanup.mjs`](core_image_cache_cleanup.mjs)、[`migrate_core_images_to_sqlite.mjs`](migrate_core_images_to_sqlite.mjs) |
| 短视频资料与缓存 | [`generate_missing_short_video_covers.mjs`](generate_missing_short_video_covers.mjs)、[`cleanup_short_video_author_aliases.mjs`](cleanup_short_video_author_aliases.mjs)、[`recover_short_video_sec_uids.py`](recover_short_video_sec_uids.py)、[`migrate_short_video_covers_to_sqlite.mjs`](migrate_short_video_covers_to_sqlite.mjs)、[`migrate_short_video_author_metadata.mjs`](migrate_short_video_author_metadata.mjs) |
| 短视频目录与数据库迁移 | [`move_short_video_storage.ps1`](move_short_video_storage.ps1)、[`migrate_short_video_storage.ps1`](migrate_short_video_storage.ps1)、[`move_short_video_author_dirs.ps1`](move_short_video_author_dirs.ps1)、[`rebase_short_video_storage.mjs`](rebase_short_video_storage.mjs)、[`rebuild_short_video_database.mjs`](rebuild_short_video_database.mjs) |
| 小说采集与整理 | [`collect_novel.py`](collect_novel.py)、[`cool18_thread_to_novel.py`](cool18_thread_to_novel.py)、[`diyibanzhu_novel_probe.py`](diyibanzhu_novel_probe.py)、[`rescan_novel_library.py`](rescan_novel_library.py)、[`fix_novel_format.py`](fix_novel_format.py) |
| 漫画采集 | [`run_manga_collector.ps1`](run_manga_collector.ps1)、[`manga_collector.py`](manga_collector.py)、[`manga_collector_requirements.txt`](manga_collector_requirements.txt) |
| 音乐维护 | [`rescan_music_library.mjs`](rescan_music_library.mjs)、[`migrate_music_root_state.mjs`](migrate_music_root_state.mjs) |
| 通用维护 | [`cleanup_metadata_cache.mjs`](cleanup_metadata_cache.mjs)、[`cleanup_user_state.mjs`](cleanup_user_state.mjs)、[`export_chrome_cookies.mjs`](export_chrome_cookies.mjs) |
| 构建 | [`build_short_video_web.mjs`](build_short_video_web.mjs)、[`build_douyin_manager_installer.ps1`](build_douyin_manager_installer.ps1) |
| 共用 Python 模块 | [`code_parser.py`](code_parser.py)、[`fanhao_tool_db.py`](fanhao_tool_db.py)、[`javdb_card_facts.py`](javdb_card_facts.py)、[`person_identity.py`](person_identity.py)、[`core_image_store.py`](core_image_store.py)、[`remote_image_cache.py`](remote_image_cache.py)、[`douban_movie_match.py`](douban_movie_match.py)、[`novel_text_formatter.py`](novel_text_formatter.py)、[`novel_chapter_identity.py`](novel_chapter_identity.py)、[`project_paths.py`](project_paths.py) |

## 执行边界

归档、清理、扫描、修复和迁移工具可能修改真实文件或数据库。执行前阅读当前脚本的参数和默认路径；分类索引不代表需要逐个执行。共用模块由其他脚本导入，保留原路径以兼容应用调用和已有操作命令。
