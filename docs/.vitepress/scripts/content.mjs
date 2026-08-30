import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import MarkdownIt from 'markdown-it';
import { sections } from '../site.mjs';
import { normalizeMarkdownLinks } from './markdown-export.mjs';

export const docsRoot = fileURLToPath(new URL('../../', import.meta.url));
export const repoRoot = path.resolve(docsRoot, '..');
export const sourceRoot = path.join(docsRoot, 'site');
export const generatedRoot = path.join(docsRoot, '.vitepress', 'generated');
export const distRoot = path.join(docsRoot, '.vitepress', 'dist');
export const markdown = new MarkdownIt({ html: false });
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const publishedFiles = ['llms.txt', 'llms-full.txt', 'ai-context.json', 'search-index.json'];

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function walk(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Symlink is not publishable: ' + root);
  return fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlink is not publishable: ' + target);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

export function readPage(id) {
  if (typeof id !== 'string' || !/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('Invalid published page ID: ' + id);
  }
  const file = path.join(sourceRoot, id + '.md');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlink is not publishable: ' + file);
  const raw = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(id + ': YAML frontmatter is required');
  return { id, file, raw, meta: parse(match[1], { maxAliasCount: 0 }), body: match[2].trim() };
}

export function pages() {
  return ['index', ...sections.flatMap((section) => section.pages)].map(readPage);
}

export function tokensOf(body) {
  const tokens = markdown.parse(body, {});
  return tokens.flatMap((token) => [token, ...(token.children || [])]);
}

export function linksOf(body) {
  return tokensOf(body).filter((token) => token.type === 'link_open' || token.type === 'image')
    .map((token) => token.attrGet(token.type === 'image' ? 'src' : 'href'));
}

export function chunksOf(page, site) {
  const body = markdownBody(page, site);
  const lines = body.split('\n');
  const headings = markdown.parse(body, {}).filter((token) => token.type === 'heading_open');
  return headings.map((heading, index) => {
    const start = heading.map[0];
    const end = headings[index + 1]?.map[0] ?? lines.length;
    const headingText = lines[start].replace(/^#+\s+/, '').trim();
    const text = lines.slice(start, end).join('\n').trim();
    return { id: page.id + ':' + index, heading: headingText, text, sha256: sha256(text) };
  });
}

export function resolveLocalLink(id, href) {
  if (/^(?:https?:|mailto:)/i.test(href)) return null;
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) throw new Error('Unsupported link protocol: ' + href);
  const url = new URL(href, 'https://docs.invalid/' + id + '.md');
  let target = decodeURIComponent(url.pathname).replace(/^\//, '');
  if (!target || target.endsWith('/')) target += 'index.md';
  if (target.endsWith('.html')) target = target.slice(0, -5) + '.md';
  if (!path.posix.extname(target)) target += '.md';
  return { target, hash: decodeURIComponent(url.hash.slice(1)) };
}

export function resolvePublishedLink(relative, href, site) {
  if (/^(?:data:|mailto:|tel:)/i.test(href)) return null;
  const url = new URL(href, site.url + relative);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported published link protocol: ' + href);
  if (url.origin !== site.origin) return null;
  if (!url.pathname.startsWith(site.base)) throw new Error('URL escapes deployment base: ' + href);
  let local = decodeURIComponent(url.pathname.slice(site.base.length));
  if (!local || local.endsWith('/')) local += 'index.html';
  local = path.posix.normalize(local);
  if (local.includes('\\') || /^[A-Za-z]:/.test(local) || local === '..' || local.startsWith('../') || path.posix.isAbsolute(local)) {
    throw new Error('URL escapes publication directory: ' + href);
  }
  return { target: local, hash: decodeURIComponent(url.hash.slice(1)) };
}

export function absoluteMarkdownLink(id, href, site) {
  const link = resolveLocalLink(id, href);
  if (!link) return href;
  const url = new URL(link.target, site.url);
  url.search = new URL(href, 'https://docs.invalid/' + id + '.md').search;
  url.hash = link.hash;
  return url.href;
}

export function markdownBody(page, site) {
  return site ? normalizeMarkdownLinks(page.body, (href) => absoluteMarkdownLink(page.id, href, site)) : page.body;
}

export function markdownText(page, site) {
  const content = markdownBody(page, site);
  const body = /^# /m.test(content) ? content : '# ' + page.meta.title + '\n\n' + page.meta.description + '\n\n' + content;
  return body + '\n\n---\n\n文档来源：docs/site/' + page.id + '.md\n\n核对日期：' + page.meta.verified_at + '；状态：' + page.meta.status + '\n\n源码依据：\n' + page.meta.sources.map((source) => '- ' + source).join('\n') + '\n';
}
