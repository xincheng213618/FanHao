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
| 中文字幕补全与校验 | [`subtitles_batch.mjs`](subtitles_batch.mjs)、[`check_subtitle_batch.mjs`](check_subtitle_batch.mjs) |
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

`movefile.py` 按只读人物身份快照匹配：同名或别名必须唯一归属同一个已确认的 ID。独立人物先在人物映射中确认合并；同名歧义、不同人物的目录归属和多个别名目标会跳过。普通与 VR 目标根分别匹配，VR 包含旧 `V:\AV` 布局；只归档到已经存在的正式人物目录。旧桌面 Tool 入口转到本项目脚本。

移动流程是身份匹配、不可变文件计划、PowerShell 执行、路径回执和定向索引。保留按目标盘并行、同盘串行。正式库的已索引路径先完成，再处理暂存区导入；已完成作品通过现有目录重关联服务保存作品和文件 ID。目录重关联允许同一人物合并已有的目录登记。新增导入只登记计划中的新作品，复用现有扫描与资料解析函数，保留已有本地作品和文件记录。最后重载主服务的资料库快照。

```powershell
# 只看暂存区匹配结果
python tools/movefile.py --dry-run
# 将指定人物在正式库和暂存区的别名目录列入同一计划
python tools/movefile.py --consolidate --person-id 123 --plan data/migration-logs/example/plan.json
# 执行；中断后使用同一命令和同一计划恢复
python tools/movefile.py --execute data/migration-logs/example/plan.json
```

计划固定目录的物理路径、人物归属、每个文件的大小、修改时间和内容指纹；执行前再次验证。源和目标人物目录以 `.fanhao-move-plan.json` 记录归属，同一计划还有独占执行锁，冲突操作须先完成或恢复原计划。小文件使用完整 SHA-256，大视频使用三个 64 KiB 窗口的 SHA-256 指纹，并非完整视频哈希。同名作品目录已经存在时，整部来件保留为带有稳定来源标记的另一版本，现有内容不被覆盖。跨盘复制先写本计划专用的临时文件，核对后才切换到最终位置并移除源文件。同一 SMB 共享中的移动使用已解析的实际路径重命名。仅清理已经为空的源目录；新出现的文件、文件变化和路径漂移会阻止完成。散落视频先整理成作品目录后再导入。`--serial` 可以关闭目标盘并行，`--db` 可以指定核心库。

离线验证：`npm run verify:movefile`，覆盖人物匹配、文件计划、复制与恢复、冲突保护、只导入新增作品，以及目录登记合并。执行证据位于计划旁的 `.state` 目录；文件阶段的 `status.json` 和最终索引阶段的 `completed.json` 分别记录，不以复制进程退出代替整个任务完成。

`subtitles_batch.mjs` 仅保留 `[A]` 作品的本地预检和历史回执读取，批量联网下载已停用，`--execute` 会直接拒绝执行。字幕由播放器中的“字幕 → 搜索字幕”手动选择和下载，保存到视频同目录，不覆盖已有文件。同番号不能保证字幕与影片的版本、剪辑和时间轴一致，需要实际试播确认。`data/subtitle-batches/` 保存历史批次与撤回记录，`check_subtitle_batch.mjs` 仅核对文件和播放器读取。整理清理继续保留字幕扩展名，包括 SRT、ASS、SSA、VTT、SUB、IDX 和 SUP。
