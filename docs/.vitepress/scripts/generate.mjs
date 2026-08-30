import fs from 'node:fs';
import path from 'node:path';
import { generatedRoot, sourceRoot, walk, inside } from './content.mjs';
import { deployment } from '../site.mjs';
import { buildArtifacts, readProvenance } from './artifacts.mjs';
import { checkSource } from './check.mjs';

const all = checkSource();
const artifacts = buildArtifacts(all, deployment(), readProvenance());
artifacts.set('favicon.svg', fs.readFileSync(path.join(sourceRoot, 'public', 'favicon.svg'), 'utf8'));
artifacts.set('.nojekyll', '');
fs.mkdirSync(generatedRoot, { recursive: true });
// Remove only obsolete generated files, never a recursive directory or a source tree.
for (const file of walk(generatedRoot)) {
  if (!artifacts.has(path.relative(generatedRoot, file).replaceAll('\\', '/'))) fs.unlinkSync(file);
}
for (const [name, content] of artifacts) {
  const target = path.resolve(generatedRoot, name);
  if (!inside(generatedRoot, target)) throw new Error('Generated path escapes output directory: ' + name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
console.log('docs:generate ok (' + all.length + ' Markdown exports, llms.txt, llms-full.txt, ai-context.json, search-index.json)');
