import fs from 'node:fs';
import path from 'node:path';
import { pages, walk, sourceRoot, repoRoot, inside, linksOf, resolveLocalLink, publishedFiles, tokensOf } from './content.mjs';

export function privacyIssues(text) {
  const checks = [
    [/\b[A-Z]:[\\/]/i, 'absolute Windows path'],
    [/\/(?:Users|home)\/[^\s/]+\//, 'personal home path'],
    [/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/, 'private network address'],
    [/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/, 'credential-shaped value'],
    [/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/, 'private key'],
    [/(?:cookie|password|token|secret)\s*[:=]\s*["'][^"'\s]{12,}["']/i, 'possible literal credential']
  ];
  return checks.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

export function publicationIssues(text) {
  const issues = [];
  if (/<!--\s*@include:/i.test(text)) issues.push('VitePress includes are forbidden in the curated publication');
  if (/^\s*<<</m.test(text)) issues.push('External code snippets are forbidden in the curated publication');
  if (/<script\b/i.test(text)) issues.push('Script blocks are forbidden in published Markdown');
  return issues;
}

export function checkSource() {
  const all = pages();
  const errors = [];
  const publicIds = new Set(all.map((page) => page.id + '.md'));
  const assets = new Set(['favicon.svg', ...publishedFiles]);
  if (publicIds.size !== all.length) errors.push('Duplicate page in navigation');
  for (const file of walk(sourceRoot)) {
    const relative = path.relative(sourceRoot, file).replaceAll('\\', '/');
    if (!publicIds.has(relative) && relative !== 'public/favicon.svg') errors.push('File is outside publish allowlist: ' + relative);
    if (relative === 'public/favicon.svg') {
      for (const issue of privacyIssues(fs.readFileSync(file, 'utf8'))) errors.push(relative + ': ' + issue);
    }
  }
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  for (const page of all) {
    const { meta, id, body } = page;
    for (const key of ['title', 'description', 'status', 'verified_at']) {
      if (typeof meta[key] !== 'string' || !meta[key].trim()) errors.push(id + ': missing ' + key);
    }
    if (!['maintained', 'draft', 'archived'].includes(meta.status)) errors.push(id + ': invalid status');
    if (meta.status !== 'maintained') errors.push(id + ': only maintained pages belong in the published collection');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.verified_at) || Number.isNaN(Date.parse(meta.verified_at)) || new Date(meta.verified_at).toISOString().slice(0, 10) !== meta.verified_at) errors.push(id + ': invalid verified_at');
    if (!Array.isArray(meta.sources) || meta.sources.length === 0) errors.push(id + ': sources must not be empty');
    for (const source of meta.sources || []) {
      if (typeof source !== 'string' || source.includes('\\') || !inside(repoRoot, path.resolve(repoRoot, source)) || !fs.existsSync(path.resolve(repoRoot, source))) errors.push(id + ': invalid source path ' + source);
    }
    const headings = tokensOf(body).filter((token) => token.type === 'heading_open' && token.tag === 'h1');
    if (headings.length !== 1) errors.push(id + ': exactly one H1 is required');
    if (body.split('\n').length > 180) errors.push(id + ': split pages longer than 180 body lines');
    for (const issue of privacyIssues(page.raw)) errors.push(id + ': ' + issue);
    for (const issue of publicationIssues(page.raw)) errors.push(id + ': ' + issue);
    for (const match of body.matchAll(/npm run (verify(?::[\w-]+)?)/g)) {
      if (!scripts[match[1]]) errors.push(id + ': unknown root npm script ' + match[1]);
    }
    for (const href of linksOf(body)) {
      try {
        const link = resolveLocalLink(id, href);
        if (link && !publicIds.has(link.target) && !assets.has(link.target)) errors.push(id + ': broken local link ' + href);
      } catch (error) { errors.push(id + ': ' + error.message); }
    }
  }
  if (errors.length) throw new Error('Documentation checks failed:\n' + errors.map((error) => '- ' + error).join('\n'));
  console.log('docs:check ok (' + all.length + ' pages; metadata, navigation, sources, links, commands, privacy patterns)');
  return all;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) checkSource();
