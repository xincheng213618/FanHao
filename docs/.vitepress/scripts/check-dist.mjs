import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'parse5';
import { walk, distRoot, sourceRoot, publishedFiles, inside, resolvePublishedLink, sha256 } from './content.mjs';
import { deployment } from '../site.mjs';
import { privacyIssues, checkSource } from './check.mjs';
import { buildArtifacts, readProvenance, verifyArtifacts } from './artifacts.mjs';

const site = deployment();
const all = checkSource();
const expected = new Set([...all.flatMap((page) => [page.id + '.html', page.id + '.md']), ...publishedFiles, 'favicon.svg', '.nojekyll', '404.html', 'hashmap.json', 'sitemap.xml', 'vp-icons.css']);
const errors = [];
const domCache = new Map();
function documentInfo(file) {
  if (domCache.has(file)) return domCache.get(file);
  const info = { ids: new Set(), links: [], alternates: [], describedby: [], sourceHashes: [] };
  function visit(node) {
    const attrs = Object.fromEntries((node.attrs || []).map((attr) => [attr.name, attr.value]));
    if (attrs.id) info.ids.add(attrs.id);
    if (node.tagName === 'meta' && attrs.name === 'fanhao:source-sha256') info.sourceHashes.push(attrs.content);
    for (const attr of ['href', 'src']) if (attrs[attr]) info.links.push(attrs[attr]);
    if (node.tagName === 'link' && attrs.rel === 'alternate' && attrs.type === 'text/markdown') info.alternates.push(attrs.href);
    if (node.tagName === 'link' && attrs.rel === 'describedby') info.describedby.push(attrs.href);
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(fs.readFileSync(file, 'utf8')));
  domCache.set(file, info);
  return info;
}

for (const file of walk(distRoot)) {
  const relative = path.relative(distRoot, file).replaceAll('\\', '/');
  if (!expected.has(relative) && !relative.startsWith('assets/')) errors.push('Unexpected published file: ' + relative);
  if (/\.(?:html|md|txt|json)$/.test(relative) && !relative.startsWith('assets/')) {
    for (const issue of privacyIssues(fs.readFileSync(file, 'utf8'))) errors.push(relative + ': ' + issue);
  }
  if (!relative.endsWith('.html')) continue;
  const info = documentInfo(file);
  for (const href of info.links) {
    try {
      const link = resolvePublishedLink(relative, href, site);
      if (!link) continue;
      const target = path.resolve(distRoot, link.target);
      if (!inside(distRoot, target) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { errors.push(relative + ': missing target: ' + href); continue; }
      if (link.hash && link.target.endsWith('.html') && !documentInfo(target).ids.has(link.hash)) errors.push(relative + ': missing anchor: ' + href);
    } catch (error) { errors.push(relative + ': ' + error.message); }
  }
}
for (const name of expected) if (!fs.existsSync(path.join(distRoot, name))) errors.push('Missing artifact: ' + name);
const artifacts = buildArtifacts(all, site, readProvenance());
artifacts.set('favicon.svg', fs.readFileSync(path.join(sourceRoot, 'public', 'favicon.svg'), 'utf8'));
artifacts.set('.nojekyll', '');
errors.push(...verifyArtifacts(artifacts, (name) => fs.readFileSync(path.join(distRoot, name), 'utf8')));
const chunks = JSON.parse(artifacts.get('search-index.json')).chunks;
assert.ok(new Set(chunks.map((chunk) => chunk.id)).size === chunks.length, 'Duplicate chunk IDs');
for (const page of all) {
  const info = documentInfo(path.join(distRoot, page.id + '.html'));
  assert.deepEqual(info.sourceHashes, [sha256(page.raw)], 'Stale HTML page: ' + page.id);
  assert.ok(info.alternates.includes(site.base + page.id + '.md'), 'Missing Markdown discovery link: ' + page.id);
  assert.ok(info.describedby.includes(site.base + 'llms.txt'), 'Missing llms discovery link: ' + page.id);
}
if (errors.length) throw new Error('Distribution checks failed:\n' + errors.map((error) => '- ' + error).join('\n'));
console.log('docs:dist ok (' + all.length + ' HTML/Markdown pairs, ' + chunks.length + ' chunks; links, anchors, base paths, hashes, discovery and publish allowlist)');
