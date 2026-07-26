# 小说采集模块

这里是 FanHao 小说模块唯一的生产采集入口。旧 `novel/` 目录中的下载、探测和格式化脚本已按职责归并：

| 旧脚本能力 | 现在的位置 |
| --- | --- |
| `diyibanzhu_downloader.py` / `diyibanzhu_novel_probe.py` | `adapters.py` 的 `diyibanzhu` 内置适配器 |
| `cool18_thread_to_novel.py` | `adapters.py` 的 `cool18` 内置适配器 |
| `alicesw_downloader.py` | `adapters.py` 的 `alicesw` 内置适配器 |
| `fix_novel_format.py` / `clean_and_format.py` | 统一复用 `tools/novel_text_formatter.py` |
| `check_*` / `verify_*` / `probe_*` | 开发诊断资料，不进入后台运行链 |

## 后台工作流

1. 在 `/novels/manage` 输入网页地址。
2. 选择“自动识别”或指定适配器。
3. 先运行“测试适配”；测试只采集第一章，不写入书库。
4. 运行“开始采集”；成功后按书籍和章节结构导入 `data/novels.sqlite`。
5. 同一来源 URL 再次采集会更新原书，不重复建书，并保留阅读进度和人工校正。

任务、适配器和日志分别保存在：

- `data/novel-collection.sqlite`
- `data/novel-collection/<task-id>/`

## 命令行

PowerShell 中可直接运行内置适配器：

```powershell
python tools\collect_novel.py "https://www.diyibanzhu.me/wap.php?action=list&id=14370"
python tools\collect_novel.py "https://www.cool18.com/bbs4/index.php?app=forum&act=threadview&tid=123" --adapter cool18
python tools\collect_novel.py "https://www.alicesw.com/novel/28090.html" --adapter alicesw
```

自定义站点使用 JSON 配置：

```json
{
  "name": "示例小说站",
  "bookTitleSelector": "h1.book-title",
  "authorSelector": ".book-author",
  "catalogSelector": ".chapter-list",
  "chapterLinkSelector": "a.chapter",
  "chapterTitleSelector": "h1.chapter-title",
  "contentSelector": "article.content",
  "removeSelectors": [".advert", ".chapter-nav"],
  "catalogNextSelector": "a.next",
  "chapterNextSelector": "a.next-page",
  "delayMs": 800,
  "timeoutMs": 30000
}
```

```powershell
python tools\collect_novel.py "https://example.com/book/123" --adapter generic --adapter-config .\adapter.json --test
```

## 自定义适配边界

当前通用适配器抓取服务端返回的静态 HTML，支持目录分页、章节分页、元素移除和行级正则过滤。纯 JavaScript 渲染、登录态、验证码或浏览器交互页面需要新增专用驱动，不应把站点特例继续堆进通用选择器。
