import path from "node:path";
import { DEFAULT_MAX_COVER_BYTES } from "./cover-frame.js";

const MAX_GENERATED_COVER_BYTES = DEFAULT_MAX_COVER_BYTES;

const ADMIN_SCRIPT_SOURCE_FIELDS = [
  {
    name: "sourcePrefixes",
    label: "来源前缀",
    type: "textarea-list",
    flag: "--source-prefix",
    default: "G:/",
    placeholder: "G:/\nF:/\nO:/[珍藏]",
    help: "每行一个路径前缀；勾选“全部来源”后会被脚本忽略。"
  },
  { name: "allSources", label: "全部来源", type: "checkbox", flag: "--all-sources", default: false },
  { name: "includeSpecial", label: "包含特殊目录", type: "checkbox", flag: "--include-special", default: false }
];
const ADMIN_SCRIPT_BROWSER_FIELDS = [
  { name: "noProxy", label: "不用代理", type: "checkbox", flag: "--no-proxy", default: false },
  { name: "headless", label: "无头浏览器", type: "checkbox", flag: "--headless", default: false },
  { name: "fast", label: "允许快跑", type: "checkbox", flag: "--fast", default: true },
  { name: "sleep", label: "基础等待秒", type: "number", flag: "--sleep", default: 2, min: 0, max: 120, step: 0.5 },
  { name: "jitter", label: "随机等待秒", type: "number", flag: "--jitter", default: 0.5, min: 0, max: 60, step: 0.5 }
];
const ADMIN_SCRIPT_MODE_FIELD = {
  name: "mode",
  label: "补全模式",
  type: "select",
  flag: "--mode",
  default: "missing",
  options: [
    { value: "missing", label: "只补缺失" },
    { value: "info", label: "只补资料" },
    { value: "cover", label: "只补封面" },
    { value: "both", label: "资料和封面" }
  ]
};
const ADMIN_SCRIPT_PERSON_FIELD = {
  name: "personId",
  label: "限定人物",
  type: "person",
  flag: "--person-id",
  default: "",
  placeholder: "不限定人物"
};
export const ADMIN_SCRIPT_DEFINITIONS = [
  {
    id: "javdb-source-pipeline",
    title: "JavDB 全流程管线",
    category: "JavDB",
    runtime: "python",
    script: path.join("tools", "run_javdb_source_pipeline.py"),
    description: "批量执行演员映射、资料/封面补全、sidecar 同步，适合一次性维护整个来源盘。",
    refreshHints: ["library", "current-view", "rankings"],
    invalidates: ["actorProfiles", "actorMovies", "workInfo", "workCovers", "rankings"],
    fields: [
      ADMIN_SCRIPT_MODE_FIELD,
      ...ADMIN_SCRIPT_SOURCE_FIELDS,
      { name: "limit", label: "每人作品上限", type: "number", flag: "--limit", default: 0, min: 0, max: 100000, step: 1 },
      { name: "limitPeople", label: "人物上限", type: "number", flag: "--limit-people", default: 0, min: 0, max: 100000, step: 1 },
      { name: "maxPages", label: "Actor 页数上限", type: "number", flag: "--max-pages", default: 0, min: 0, max: 1000, step: 1 },
      { name: "refresh", label: "刷新已有作品缓存", type: "checkbox", flag: "--refresh", default: false },
      { name: "refreshActor", label: "刷新演员映射", type: "checkbox", flag: "--refresh-actor", default: false },
      { name: "cacheCoversDuringActorImport", label: "演员导入时缓存封面", type: "checkbox", flag: "--cache-covers-during-actor-import", default: false },
      { name: "noCacheImages", label: "不缓存远端图片", type: "checkbox", flag: "--no-cache-images", default: false },
      { name: "noWriteFiles", label: "不回写本地文件", type: "checkbox", flag: "--no-write-files", default: false },
      { name: "overwriteFiles", label: "允许覆盖 sidecar", type: "checkbox", flag: "--overwrite-files", default: false },
      { name: "noImportActors", label: "跳过演员导入", type: "checkbox", flag: "--no-import-actors", default: false },
      { name: "noBackfill", label: "跳过资料补全", type: "checkbox", flag: "--no-backfill", default: false },
      { name: "noSync", label: "跳过 sidecar 同步", type: "checkbox", flag: "--no-sync", default: false },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "actor-page-backfill",
    title: "Actor 页缺失检测",
    category: "JavDB",
    runtime: "python",
    script: path.join("tools", "backfill_javdb_actor_page.py"),
    description: "刷新演员页作品列表，也可以进一步抓取作品资料和封面。",
    refreshHints: ["current-view"],
    invalidates: ["actorProfiles", "actorMovies", "workInfo", "workCovers"],
    fields: [
      ADMIN_SCRIPT_PERSON_FIELD,
      ADMIN_SCRIPT_MODE_FIELD,
      ...ADMIN_SCRIPT_SOURCE_FIELDS,
      { name: "write", label: "写入 SQLite", type: "checkbox", flag: "--write", default: true },
      { name: "actorMoviesOnly", label: "只做缺失检测", type: "checkbox", flag: "--actor-movies-only", default: true },
      { name: "listTargets", label: "只列出目标", type: "checkbox", flag: "--list-targets", default: false },
      { name: "refresh", label: "刷新作品缓存", type: "checkbox", flag: "--refresh", default: false },
      { name: "refreshActor", label: "刷新演员映射", type: "checkbox", flag: "--refresh-actor", default: false },
      { name: "noCacheImages", label: "不缓存远端图片", type: "checkbox", flag: "--no-cache-images", default: false },
      { name: "noWriteFiles", label: "不回写本地文件", type: "checkbox", flag: "--no-write-files", default: true },
      { name: "overwriteFiles", label: "允许覆盖 sidecar", type: "checkbox", flag: "--overwrite-files", default: false },
      { name: "limit", label: "每人作品上限", type: "number", flag: "--limit", default: 0, min: 0, max: 100000, step: 1 },
      { name: "limitPeople", label: "人物上限", type: "number", flag: "--limit-people", default: 0, min: 0, max: 100000, step: 1 },
      { name: "maxPages", label: "Actor 页数上限", type: "number", flag: "--max-pages", default: 0, min: 0, max: 1000, step: 1 },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "metadata-backfill",
    title: "作品资料/封面补全",
    category: "JavDB",
    runtime: "python",
    script: path.join("tools", "backfill_javdb_metadata.py"),
    description: "对已有本地作品补 JavDB 资料、评分、封面和远端图片缓存。",
    refreshHints: ["current-view"],
    invalidates: ["workInfo", "workCovers"],
    fields: [
      ADMIN_SCRIPT_PERSON_FIELD,
      ADMIN_SCRIPT_MODE_FIELD,
      ...ADMIN_SCRIPT_SOURCE_FIELDS,
      { name: "write", label: "写入 SQLite", type: "checkbox", flag: "--write", default: true },
      { name: "listMissing", label: "只统计缺失", type: "checkbox", flag: "--list-missing", default: false },
      { name: "refresh", label: "刷新已有缓存", type: "checkbox", flag: "--refresh", default: false },
      { name: "noCacheImages", label: "不缓存远端图片", type: "checkbox", flag: "--no-cache-images", default: false },
      { name: "limit", label: "作品上限", type: "number", flag: "--limit", default: 20, min: 0, max: 100000, step: 1 },
      { name: "codes", label: "限定番号", type: "textarea-list", flag: "--code", default: "", placeholder: "JUQ-123\nSONE-456" },
      { name: "workIds", label: "限定 work_id", type: "textarea-list", flag: "--work-id", default: "" },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "batch-import-actors",
    title: "批量导入演员资料",
    category: "JavDB",
    runtime: "python",
    script: path.join("tools", "batch_import_javdb_actors.py"),
    description: "按本地人物批量搜索并缓存 JavDB 演员头像、别名和页面映射。",
    refreshHints: ["library"],
    invalidates: ["actorProfiles", "workCovers"],
    fields: [
      ...ADMIN_SCRIPT_SOURCE_FIELDS,
      { name: "max", label: "人物上限", type: "number", flag: "--max", default: 0, min: 0, max: 100000, step: 1 },
      { name: "minWorkCount", label: "最少作品数", type: "number", flag: "--min-work-count", default: 1, min: 0, max: 100000, step: 1 },
      { name: "refresh", label: "刷新已有演员", type: "checkbox", flag: "--refresh", default: false },
      { name: "cacheCovers", label: "顺手缓存封面", type: "checkbox", flag: "--cache-covers", default: false },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "ranking-cache",
    title: "排行榜缓存",
    category: "缓存",
    runtime: "python",
    script: path.join("tools", "cache_javdb_rankings.py"),
    description: "抓取 JavDB 排行榜并写入本地缓存，供排行榜页面和缺失作品卡片使用。",
    refreshHints: ["rankings", "current-view"],
    invalidates: ["rankings", "actorMovies"],
    fields: [
      { name: "write", label: "写入缓存", type: "checkbox", flag: "--write", default: true },
      { name: "lists", label: "榜单 key", type: "textarea-list", flag: "--list", default: "y2025", placeholder: "y2025\nall\ncensored\nfc2" },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "generate-missing-covers",
    title: "批量补本地封面",
    category: "缓存",
    runtime: "node",
    script: path.join("tools", "generate_missing_covers.mjs"),
    description: "从本地视频抽帧，生成缺失的作品封面缓存。",
    refreshHints: ["covers", "current-view"],
    invalidates: ["workCovers"],
    fields: [
      { name: "write", label: "写入封面缓存", type: "checkbox", flag: "--write", default: true },
      { name: "limit", label: "生成数量", type: "number", flag: "--limit", default: 20, min: 0, max: 10000, step: 1 },
      { name: "overwrite", label: "覆盖已有封面", type: "checkbox", flag: "--overwrite", default: false },
      { name: "maxBytes", label: "单张最大字节", type: "number", flag: "--max-bytes", default: MAX_GENERATED_COVER_BYTES, min: 65536, max: 16 * 1024 * 1024, step: 65536 }
    ]
  },
  {
    id: "sync-sidecars",
    title: "同步 sidecar 文件",
    category: "文件",
    runtime: "python",
    script: path.join("tools", "sync_javdb_sidecars.py"),
    description: "把 SQLite 里的 JavDB 资料/封面回写到本地作品目录。",
    refreshHints: ["library", "current-view"],
    invalidates: ["workInfo", "workCovers"],
    fields: [
      ADMIN_SCRIPT_PERSON_FIELD,
      ...ADMIN_SCRIPT_SOURCE_FIELDS,
      { name: "write", label: "实际写文件", type: "checkbox", flag: "--write", default: false },
      { name: "overwrite", label: "覆盖已有文件", type: "checkbox", flag: "--overwrite", default: false }
    ]
  },
  {
    id: "cache-local-images",
    title: "本地图片缓存",
    category: "缓存",
    runtime: "python",
    script: path.join("tools", "cache_local_images.py"),
    description: "把本地头像、封面等图片写入 local_image_cache，提升手机端加载稳定性。",
    refreshHints: ["library", "current-view"],
    invalidates: ["localImages"],
    fields: [
      { name: "write", label: "写入缓存", type: "checkbox", flag: "--write", default: true },
      { name: "force", label: "强制重写", type: "checkbox", flag: "--force", default: false },
      { name: "deleteZeroByte", label: "删除 0 字节图片", type: "checkbox", flag: "--delete-zero-byte", default: false },
      { name: "limit", label: "处理数量", type: "number", flag: "--limit", default: 0, min: 0, max: 100000, step: 1 },
      { name: "batchSize", label: "批量提交数", type: "number", flag: "--batch-size", default: 100, min: 1, max: 5000, step: 1 }
    ]
  },
  {
    id: "cache-remote-images",
    title: "远端图片缓存",
    category: "缓存",
    runtime: "python",
    script: path.join("tools", "cache_remote_images.py"),
    description: "下载已知 JavDB 图片 URL 到 remote_image_cache。",
    refreshHints: ["current-view", "rankings"],
    invalidates: ["remoteImages"],
    fields: [
      { name: "write", label: "写入缓存", type: "checkbox", flag: "--write", default: true },
      { name: "sources", label: "图片来源", type: "textarea-list", flag: "--source", default: "rankings\nactor-movies\nwork-info\npreview-images" },
      { name: "limit", label: "下载数量", type: "number", flag: "--limit", default: 0, min: 0, max: 100000, step: 1 },
      { name: "batchSize", label: "批量提交数", type: "number", flag: "--batch-size", default: 100, min: 1, max: 5000, step: 1 },
      { name: "concurrency", label: "并发数", type: "number", flag: "--concurrency", default: 8, min: 1, max: 64, step: 1 },
      { name: "timeout", label: "超时秒", type: "number", flag: "--timeout", default: 30, min: 3, max: 300, step: 1 }
    ]
  },
  {
    id: "cleanup-metadata-cache",
    title: "清理资料缓存",
    category: "维护",
    runtime: "node",
    script: path.join("tools", "cleanup_metadata_cache.mjs"),
    description: "清理 SQLite 中已经不属于当前资料库的孤儿资料、封面和演员缓存。",
    refreshHints: ["current-view", "rankings"],
    invalidates: ["actorProfiles", "actorMovies", "workInfo", "workCovers", "rankings"],
    fields: [{ name: "write", label: "实际清理", type: "checkbox", flag: "--write", default: false }]
  },
  {
    id: "cleanup-user-state",
    title: "清理用户状态",
    category: "维护",
    runtime: "node",
    script: path.join("tools", "cleanup_user_state.mjs"),
    description: "修复收藏夹、收藏、播放进度中已经失效的记录。",
    refreshHints: ["library", "current-view"],
    invalidates: ["userState"],
    fields: [
      { name: "write", label: "实际清理", type: "checkbox", flag: "--write", default: false },
      { name: "dropZeroProgress", label: "删除 0 进度", type: "checkbox", flag: "--drop-zero-progress", default: false },
      { name: "historyDays", label: "保留历史天数", type: "number", flag: "--history-days", default: "", min: 1, max: 3650, step: 1 },
      { name: "maxHistory", label: "最多历史条数", type: "number", flag: "--max-history", default: "", min: 1, max: 100000, step: 1 }
    ]
  },
  {
    id: "metadata-quality-report",
    title: "资料质量报告",
    category: "报表",
    runtime: "node",
    script: path.join("tools", "report_metadata_quality.mjs"),
    description: "统计缺资料、缺封面、错误行等质量问题。",
    refreshHints: [],
    invalidates: [],
    fields: [
      { name: "limit", label: "样本数量", type: "number", flag: "--limit", default: 20, min: 0, max: 1000, step: 1 },
      { name: "json", label: "JSON 输出", type: "checkbox", flag: "--json", default: false }
    ]
  },
  {
    id: "scan-noise-report",
    title: "扫描噪声报告",
    category: "报表",
    runtime: "node",
    script: path.join("tools", "report_scan_noise.mjs"),
    description: "找出疑似 sample、preview、trailer 等噪声视频。",
    refreshHints: [],
    invalidates: [],
    fields: [
      { name: "minVideoMb", label: "小视频阈值 MB", type: "number", flag: "--min-video-mb", default: 50, min: 0, max: 100000, step: 1 },
      { name: "limit", label: "样本数量", type: "number", flag: "--limit", default: 20, min: 0, max: 1000, step: 1 },
      { name: "patterns", label: "文件名模式", type: "textarea-list", flag: "--pattern", default: "" },
      { name: "json", label: "JSON 输出", type: "checkbox", flag: "--json", default: false }
    ]
  },
  {
    id: "missing-local-report",
    title: "演员缺失报告",
    category: "报表",
    runtime: "python",
    script: path.join("tools", "report_missing_local_by_actor.py"),
    description: "按 actor_movies 缓存统计演员作品中本地还没下载的项目。",
    refreshHints: [],
    invalidates: [],
    fields: [{ name: "limit", label: "输出数量", type: "number", flag: "--limit", default: 30, min: 1, max: 5000, step: 1 }]
  },
  {
    id: "import-info-metadata",
    title: "导入本地 info 元数据",
    category: "文件",
    runtime: "node",
    script: path.join("tools", "import_info_metadata.mjs"),
    description: "从本地 info/nfo/txt/json 等 sidecar 文件导入作品资料缓存。",
    refreshHints: ["current-view"],
    invalidates: ["workInfo"],
    fields: [
      { name: "dryRun", label: "只预览", type: "checkbox", flag: "--dry-run", default: false },
      { name: "force", label: "强制重导", type: "checkbox", flag: "--force", default: false },
      { name: "verbose", label: "详细输出", type: "checkbox", flag: "--verbose", default: false },
      { name: "limit", label: "处理数量", type: "number", flag: "--limit", default: 0, min: 0, max: 100000, step: 1 },
      { name: "workId", label: "限定 work_id", type: "text", flag: "--work-id", default: "" }
    ]
  },
  {
    id: "import-single-actor",
    title: "导入单个演员",
    category: "JavDB",
    runtime: "python",
    script: path.join("tools", "import_javdb_actor.py"),
    description: "手动为单个人物导入或修正 JavDB 演员资料。",
    refreshHints: ["library"],
    invalidates: ["actorProfiles"],
    fields: [
      ADMIN_SCRIPT_PERSON_FIELD,
      { name: "name", label: "演员名", type: "text", flag: "--name", default: "", placeholder: "可留空，优先使用限定人物" },
      ...ADMIN_SCRIPT_BROWSER_FIELDS
    ]
  },
  {
    id: "verify-code-parsers",
    title: "验证番号解析",
    category: "验证",
    runtime: "node",
    script: path.join("tools", "verify_code_parsers.mjs"),
    description: "运行番号解析器测试。",
    refreshHints: [],
    invalidates: [],
    fields: []
  },
  {
    id: "verify-metadata-parsers",
    title: "验证资料解析",
    category: "验证",
    runtime: "node",
    script: path.join("tools", "verify_metadata_parsers.mjs"),
    description: "运行 info/nfo 元数据解析器测试。",
    refreshHints: [],
    invalidates: [],
    fields: []
  },
  {
    id: "format-txt-document",
    title: "格式化 TXT 文档",
    category: "文本",
    runtime: "python",
    script: path.join("tools", "novel_text_formatter.py"),
    risk: "write",
    description: "把本地小说/长文本 txt 整理成 UTF-8、章节分隔、段落空行和中文首行缩进的标准格式。",
    refreshHints: [],
    invalidates: [],
    fields: [
      { name: "inputPath", label: "输入 TXT 路径", type: "text", positional: true, required: true, default: "", placeholder: "C:\\Users\\17917\\Desktop\\novel.txt" },
      { name: "outputPath", label: "输出路径", type: "text", flag: "--output", default: "", placeholder: "留空则生成 *_格式化.txt" },
      { name: "suffix", label: "默认输出后缀", type: "text", flag: "--suffix", default: "_格式化" },
      { name: "inplace", label: "覆盖原文件并备份", type: "checkbox", flag: "--inplace", default: false },
      { name: "noIndent", label: "不加首行缩进", type: "checkbox", flag: "--no-indent", default: false },
      { name: "noCleanJunk", label: "不清理分页噪声", type: "checkbox", flag: "--no-clean-junk", default: false },
      { name: "quiet", label: "安静模式", type: "checkbox", flag: "--quiet", default: false }
    ]
  },
  {
    id: "verify-txt-formatter",
    title: "验证 TXT 格式化器",
    category: "验证",
    runtime: "python",
    script: path.join("tools", "verify_novel_text_formatter.py"),
    description: "运行 TXT 格式化模块的基础用例。",
    refreshHints: [],
    invalidates: [],
    fields: []
  },
  {
    id: "diyibanzhu-novel-probe",
    title: "第一版主小说探测",
    category: "小说",
    runtime: "python",
    script: path.join("tools", "diyibanzhu_novel_probe.py"),
    description: "抓取目录页并生成章节诊断 JSON。",
    refreshHints: [],
    invalidates: [],
    fields: [
      { name: "url", label: "目录 URL", type: "text", positional: true, required: true, default: "" },
      { name: "maxChapters", label: "章节上限", type: "number", flag: "--max-chapters", default: 0, min: 0, max: 100000, step: 1 },
      { name: "delay", label: "间隔秒", type: "number", flag: "--delay", default: 0.5, min: 0, max: 120, step: 0.5 },
      { name: "timeout", label: "超时秒", type: "number", flag: "--timeout", default: 30, min: 3, max: 300, step: 1 },
      { name: "previewChars", label: "预览字符数", type: "number", flag: "--preview-chars", default: 0, min: 0, max: 10000, step: 1 },
      { name: "useEnvProxy", label: "使用环境代理", type: "checkbox", flag: "--use-env-proxy", default: false },
      { name: "keepCovered", label: "保留被覆盖目录项", type: "checkbox", flag: "--keep-covered", default: false }
    ]
  },
  {
    id: "cool18-thread-to-novel",
    title: "Cool18 帖子转小说",
    category: "小说",
    runtime: "python",
    script: path.join("tools", "cool18_thread_to_novel.py"),
    description: "从 threadview 链路抓取正文并整理为本地 txt。",
    refreshHints: [],
    invalidates: [],
    fields: [
      { name: "url", label: "起始 URL", type: "text", positional: true, required: true, default: "" },
      { name: "dryRun", label: "只预览", type: "checkbox", flag: "--dry-run", default: false },
      { name: "noRecursive", label: "不递归跟随", type: "checkbox", flag: "--no-recursive", default: false },
      { name: "maxPages", label: "页面上限", type: "number", flag: "--max-pages", default: 30, min: 1, max: 1000, step: 1 },
      { name: "delay", label: "间隔秒", type: "number", flag: "--delay", default: 1, min: 0, max: 120, step: 0.5 },
      { name: "timeout", label: "超时秒", type: "number", flag: "--timeout", default: 30, min: 3, max: 300, step: 1 },
      { name: "previewLines", label: "预览行数", type: "number", flag: "--preview-lines", default: 24, min: 0, max: 1000, step: 1 }
    ]
  }
];
