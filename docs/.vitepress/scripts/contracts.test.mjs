import test from 'node:test';
import assert from 'node:assert/strict';
import { deployment, sections } from '../site.mjs';
import { privacyIssues, publicationIssues } from './check.mjs';
import { resolveLocalLink, resolvePublishedLink, chunksOf, markdownText, readPage, linksOf } from './content.mjs';
import { buildArtifacts, verifyArtifacts } from './artifacts.mjs';

test('GitHub project, root domain, and renamed repository deployments', () => {
  assert.equal(deployment({}).url, 'https://xincheng213618.github.io/FanHao/');
  assert.equal(deployment({ DOCS_BASE: '/', DOCS_ORIGIN: 'https://docs.example.org' }).url, 'https://docs.example.org/');
  assert.equal(deployment({ DOCS_BASE: '/renamed/' }).base, '/renamed/');
  for (const base of ['FanHao', '//evil/', '/foo/../bar/', '/./', '/../', '/foo/./bar/', '/foo?bar/']) assert.throws(() => deployment({ DOCS_BASE: base }));
  for (const origin of ['file:///tmp', 'https://example.org/path', 'https://user:pass@example.org']) assert.throws(() => deployment({ DOCS_ORIGIN: origin }));
});

test('nested Markdown, fragments and static resources resolve separately', () => {
  assert.deepEqual(resolveLocalLink('ai/context', '../guide/quick-start.md#准备'), { target: 'guide/quick-start.md', hash: '准备' });
  assert.deepEqual(resolveLocalLink('ai/context', '#边界'), { target: 'ai/context.md', hash: '边界' });
  assert.deepEqual(resolveLocalLink('ai/context', '/llms.txt'), { target: 'llms.txt', hash: '' });
  assert.equal(resolveLocalLink('ai/context', 'https://example.org/'), null);
  assert.throws(() => resolveLocalLink('ai/context', 'file:///private'));
});

test('publication guard rejects representative local data and credentials', () => {
  assert.ok(privacyIssues('D:' + '\\' + 'PrivateMedia').length);
  assert.ok(privacyIssues('https://192.168.12.34:29998').length);
  assert.ok(privacyIssues('ghp_' + 'a'.repeat(32)).length);
  assert.deepEqual(privacyIssues('http://127.0.0.1:29998; $env:FANHAO_WEB_PASSWORD'), []);
});

test('chunking ignores headings inside code fences and preserves code', () => {
  const page = { id: 'test', meta: { title: 'Test', description: 'Summary', status: 'maintained', verified_at: '2026-08-30', sources: ['package.json'] }, body: '# Test\n\n## Command\n\n~~~powershell\n# Not a section\nnpm run verify\n~~~\n\n## Next\nText' };
  const chunks = chunksOf(page);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[1].text.includes('# Not a section'));
  assert.ok(markdownText(page).includes('源码依据：'));
});

test('published links stay within the configured project or root deployment', () => {
  const site = deployment({});
  assert.deepEqual(resolvePublishedLink('ai/context.html', '../guide/quick-start.html#准备', site), { target: 'guide/quick-start.html', hash: '准备' });
  assert.deepEqual(resolvePublishedLink('ai/context.html', '/FanHao/', site), { target: 'index.html', hash: '' });
  assert.equal(resolvePublishedLink('index.html', 'https://github.com/example/repo', site), null);
  for (const link of ['/guide/quick-start.html', '/Other/index.html', '/FanHao/%2e%2e/private', '/FanHao/%5c..%5cprivate', 'javascript:alert(1)']) {
    assert.throws(() => resolvePublishedLink('index.html', link, site), undefined, link);
  }
  assert.deepEqual(resolvePublishedLink('ai/context.html', '/guide/quick-start.html', deployment({ DOCS_BASE: '/' })), { target: 'guide/quick-start.html', hash: '' });
});

test('publication cannot import files outside its curated Markdown', () => {
  for (const value of ['<!-- @include: ../../private.md -->', '<<< ../../private.txt', '<script setup>import value from "../../private.json"</script>']) {
    assert.ok(publicationIssues(value).length, value);
  }
  assert.deepEqual(publicationIssues('# Plain docs\n\n```powershell\nnpm run verify\n```'), []);
  for (const id of ['../private', 'ai/../../private', '/private', 'ai\\private', 'ai/./private']) assert.throws(() => readPage(id), /Invalid published page ID/);
});

function artifactFixture() {
  const pages = ['index', ...sections.flatMap((section) => section.pages)].map((id) => ({
    id,
    meta: { title: id, description: 'Current description', status: 'maintained', verified_at: '2026-08-30', sources: ['package.json'] },
    body: '# Current content\n\n## Contract\nStable text.'
  }));
  return { pages, site: deployment({}), provenance: { revision: 'a'.repeat(40), working_tree_dirty: false } };
}

test('dist verification rejects stale full text, metadata, URLs, schema and Markdown', () => {
  const { pages, site, provenance } = artifactFixture();
  const expected = buildArtifacts(pages, site, provenance);
  assert.deepEqual(verifyArtifacts(expected, (name) => expected.get(name)), []);
  const mutations = [
    ['llms-full.txt', (text) => text.replace('Stable text.', 'Obsolete instruction.')],
    ['llms.txt', (text) => text.replace('Current description', 'Outdated description')],
    ['ai-context.json', (text) => text.replace('Current description', 'Outdated metadata')],
    ['ai-context.json', (text) => text.replace('"markdown_url": "' + site.url, '"markdown_url": "https://example.org/old/')],
    ['search-index.json', (text) => text.replace('"schema_version": 1', '"schema_version": 2')],
    ['ai/context.md', (text) => text.replace('Stable text.', 'Stale export.')]
  ];
  for (const [name, mutate] of mutations) {
    const actual = new Map(expected);
    actual.set(name, mutate(actual.get(name)));
    assert.deepEqual(verifyArtifacts(expected, (file) => actual.get(file)), ['Stale or modified generated artifact: ' + name]);
  }
  assert.ok(verifyArtifacts(expected, (name) => { if (name === 'llms-full.txt') throw new Error('missing'); return expected.get(name); }).includes('Missing generated artifact: llms-full.txt'));
});

test('metadata-only source changes and alternate deployment cannot reuse an old index', () => {
  const { pages, site, provenance } = artifactFixture();
  const old = buildArtifacts(pages, site, provenance);
  pages[1].meta.description = 'Reviewed description';
  const current = buildArtifacts(pages, site, provenance);
  assert.equal(current.get(pages[1].id + '.md'), old.get(pages[1].id + '.md'));
  assert.ok(verifyArtifacts(current, (name) => old.get(name)).some((error) => error.endsWith('ai-context.json')));
  const alternate = buildArtifacts(pages, deployment({ DOCS_BASE: '/renamed/', DOCS_ORIGIN: 'https://docs.example.org' }), provenance);
  for (const name of ['llms.txt', 'llms-full.txt', 'ai-context.json', 'search-index.json']) {
    assert.ok(verifyArtifacts(alternate, (file) => current.get(file)).some((error) => error.endsWith(name)), name);
  }
});

test('Markdown exports resolve project assets, page fragments and reference links without changing code', () => {
  const { pages, site } = artifactFixture();
  const page = { ...pages[0], id: 'ai/context', body: [
    '# Links',
    '[page](../guide/quick-start.md#准备)',
    '[html](../guide/quick-start.html?download=1#ready)',
    '[asset](/llms.txt)',
    '[self](#这里)',
    '[reference][guide]',
    '[![icon](/favicon.svg)](../index.md)',
    '[external](https://example.org/path)',
    '`[inline](/unchanged.txt)`',
    '```markdown',
    '[fenced](/unchanged.txt)',
    '```',
    '',
    '    [indented](/unchanged.txt)',
    '',
    '[guide]: ../guide/development.md "Guide"'
  ].join('\n') };
  const exported = markdownText(page, site);
  const links = linksOf(exported);
  for (const href of [site.url + 'guide/quick-start.md#%E5%87%86%E5%A4%87', site.url + 'guide/quick-start.md?download=1#ready', site.url + 'llms.txt', site.url + 'ai/context.md#%E8%BF%99%E9%87%8C', site.url + 'guide/development.md', site.url + 'favicon.svg', site.url + 'index.md', 'https://example.org/path']) assert.ok(links.includes(href), href);
  for (const snippet of ['`[inline](/unchanged.txt)`', '```markdown\n[fenced](/unchanged.txt)\n```', '    [indented](/unchanged.txt)', '[guide]: ../guide/development.md "Guide"']) assert.ok(exported.includes(snippet), snippet);
  assert.ok(links.every((href) => /^https:\/\//.test(href)));
});

test('Markdown exports use a custom root origin in aggregate text and search chunks', () => {
  const { pages, provenance } = artifactFixture();
  const site = deployment({ DOCS_BASE: '/', DOCS_ORIGIN: 'https://docs.example.org' });
  pages[0].body += '\n\n[AI](ai/context.md#边界)\n[raw](/llms.txt)';
  const artifacts = buildArtifacts(pages, site, provenance);
  for (const name of ['index.md', 'llms-full.txt', 'search-index.json']) {
    assert.ok(artifacts.get(name).includes('https://docs.example.org/ai/context.md#%E8%BE%B9%E7%95%8C'), name);
    assert.ok(artifacts.get(name).includes('https://docs.example.org/llms.txt'), name);
    assert.ok(!artifacts.get(name).includes('/FanHao/'), name);
  }
});
