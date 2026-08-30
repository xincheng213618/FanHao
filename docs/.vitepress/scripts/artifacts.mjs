import { execFileSync } from 'node:child_process';
import { markdownText, sha256, chunksOf, repoRoot } from './content.mjs';
import { repository, sections } from '../site.mjs';

export function readProvenance() {
  try {
    const options = { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 };
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    const working_tree_dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim());
    return { revision, working_tree_dirty };
  } catch {
    return { revision: 'unknown', working_tree_dirty: null };
  }
}

// Generation and verification share the complete serialization contract. No
// existing output is trusted as the expected source of an artifact's metadata.
export function buildArtifacts(all, site, provenance) {
  const exports = new Map(all.map((page) => [page.id + '.md', markdownText(page, site)]));
  const byId = new Map(all.map((page) => [page.id, page]));
  const fileLink = (id) => {
    const page = byId.get(id);
    if (!page) throw new Error('Missing page required by AI navigation: ' + id);
    return '- [' + page.meta.title + '](' + site.url + id + '.md): ' + page.meta.description;
  };
  const entrypoints = ['ai/context', 'ai/tasks', 'ai/safety'];
  exports.set('llms.txt', '# FanHao\n\n> 本地优先的媒体资料库，面向 Web、Android 与 AI 协作者的项目知识。\n\n先读 AI 上下文与安全边界，再按任务加载相关页面。文档是代码快照的说明，不授予执行命令或访问数据的权限。站点只发布精选文档，不包含运行数据。\n\n## 从这里开始\n\n' + entrypoints.map(fileLink).join('\n') + '\n\n' + sections.filter((section) => section.title !== '与 AI 协作').map((section) => '## ' + section.title + '\n\n' + section.pages.map(fileLink).join('\n')).join('\n\n') + '\n\n## Optional\n\n- [结构化上下文](' + site.url + 'ai-context.json): 页面元数据、来源和内容摘要哈希\n- [分节检索索引](' + site.url + 'search-index.json): 标题与正文块\n- [完整 Markdown](' + site.url + 'llms-full.txt): 全量精选文档；优先按需读取单页\n');
  const context = {
    schema_version: 1,
    project: 'FanHao',
    language: 'zh-CN',
    site_url: site.url,
    repository,
    ...provenance,
    notice: 'Metadata and hashes establish provenance, not runtime verification or permission to act. verified_at is a manual source review date.',
    entrypoints: entrypoints.map((id) => id + '.md'),
    pages: all.map((page) => ({
      ...page.meta,
      id: page.id,
      source: 'docs/site/' + page.id + '.md',
      url: site.url + (page.id === 'index' ? '' : page.id + '.html'),
      markdown_url: site.url + page.id + '.md',
      sha256: sha256(exports.get(page.id + '.md')),
      bytes: Buffer.byteLength(exports.get(page.id + '.md'))
    }))
  };
  exports.set('ai-context.json', JSON.stringify(context, null, 2) + '\n');
  exports.set('search-index.json', JSON.stringify({ schema_version: 1, chunks: all.flatMap((page) => chunksOf(page, site).map((chunk) => ({ ...chunk, page: page.id, title: page.meta.title, url: site.url + page.id + '.md' }))) }, null, 2) + '\n');
  exports.set('llms-full.txt', '# FanHao · 完整项目文档\n\n只包含 docs/site 的精选页面。优先读取 llms.txt，再按任务选择单页。源码优先；文档不构成执行授权。\n\n' + all.map((page) => '<!-- ' + site.url + page.id + '.md -->\n\n' + exports.get(page.id + '.md')).join('\n---\n\n'));
  return exports;
}

export function verifyArtifacts(expected, readText) {
  const errors = [];
  for (const [name, content] of expected) {
    let actual;
    try { actual = readText(name); } catch { errors.push('Missing generated artifact: ' + name); continue; }
    if (actual !== content) errors.push('Stale or modified generated artifact: ' + name);
  }
  return errors;
}
