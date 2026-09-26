import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeAndroidCacheSource } from '../android-client/scripts/android-cache-version.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const DAILY_SCRIPTS = [
  'verify:repo-hygiene',
  'verify:auth',
  'verify:mutation-auth',
  'verify:modules',
  'verify:imports',
  'verify:verification-runner',
];

export const FULL_SCRIPTS = [
  'verify:repo-hygiene', 'verify:auth', 'verify:accounts', 'verify:mutation-auth',
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:codes', 'verify:metadata',
  'verify:javdb-card-facts', 'verify:library-merge', 'verify:core-images',
  'verify:gallery-db', 'verify:image-library', 'verify:photo-reader', 'verify:manga',
  'verify:archive-images', 'verify:photo-search', 'verify:music-rescan-worker',
  'verify:music-scale', 'verify:video-playback', 'verify:person-work-associations',
  'verify:person-identity',
  'verify:work-move-jobs', 'verify:android-work-move', 'verify:access-log',
  'verify:access-analytics', 'verify:novels', 'verify:short-video-collections',
  'verify:short-video-delete-jobs', 'verify:short-video-store',
  'verify:short-video-actions', 'verify:short-video-watch-write',
  'verify:short-video-runtime', 'verify:short-video-stats-performance',
  'verify:short-video-like-distribution-worker', 'verify:short-video-build',
  'verify:short-video-client', 'verify:browser-behavior', 'verify:douyin-manager',
  'verify:settings', 'verify:system-control', 'verify:market-dashboard',
  'verify:gomoku', 'verify:jump', 'verify:modules', 'verify:disk-usage',
  'verify:code-prefixes', 'verify:startup', 'verify:fanhao',
  'verify:works-performance', 'verify:cover-cache-status', 'verify:imports',
  'verify:android-novel-ui', 'verify:verification-runner',
];

export const ANDROID_SCRIPTS = [
  'verify:android-security', 'verify:android-gradle-config', 'verify:android-client',
  'verify:android-system-control', 'verify:android-work-move', 'verify:android-novel-ui',
  'verify:short-video-client', 'verify:auth', 'verify:mutation-auth', 'verify:imports',
];

const ANDROID_DOMAIN_BASE = ['verify:android-security', 'verify:auth', 'verify:mutation-auth', 'verify:imports'];

const RULES = [
  [/^(\.codex-artifacts|\.codex-remote-attachments|data\/design-audits)\//, []],
  [/^docs\//, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']],
  [/^android-client\/www\/modules\/novels\//, [...ANDROID_DOMAIN_BASE, 'verify:android-novels']],
  [/^android-client\/www\/modules\/music\//, [...ANDROID_DOMAIN_BASE, 'verify:android-music']],
  [/^android-client\/www\/modules\/(media|anime)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-media']],
  [/^android-client\/www\/modules\/(photos|vision)\//, [...ANDROID_DOMAIN_BASE, 'verify:android-photos']],
  [/^android-client\/www\/modules\/short-videos\//, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Novel/i, [...ANDROID_DOMAIN_BASE, 'verify:android-novels']],
  [/^android-client\/android\/app\/src\/main\/java\/.*Music/i, [...ANDROID_DOMAIN_BASE, 'verify:android-music']],
  [/^android-client\/android\/app\/src\/main\/java\/.*ShortVideo/i, [...ANDROID_DOMAIN_BASE, 'verify:short-video-client']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Media|Video|Anime)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-media']],
  [/^android-client\/android\/app\/src\/main\/java\/.*(Photo|Gallery|Vision|Camera)/i, [...ANDROID_DOMAIN_BASE, 'verify:android-photos']],
  [/^android-client\//, ANDROID_SCRIPTS],
  [/^(src\/modules\/short-videos\/|public\/modules\/short-videos\/)/, [
    'verify:short-video-collections', 'verify:short-video-delete-jobs',
    'verify:short-video-store', 'verify:short-video-actions',
    'verify:short-video-watch-write', 'verify:short-video-runtime',
    'verify:short-video-stats-performance', 'verify:short-video-like-distribution-worker',
    'verify:short-video-build', 'verify:short-video-client', 'verify:douyin-manager',
    'verify:imports',
  ]],
  [/^(src\/modules\/novels\/|public\/modules\/novels\/)/, ['verify:novels', 'verify:imports']],
  [/^(src\/modules\/music\/|public\/modules\/music\/)/, ['verify:music-rescan-worker', 'verify:music-scale', 'verify:imports']],
  [/^(src\/modules\/(photos|content-index)\/|public\/modules\/(photos|content-index)\/)/, [
    'verify:image-library', 'verify:photo-reader', 'verify:photo-search', 'verify:imports',
  ]],
  [/^(src\/modules\/fanhao\/|public\/modules\/fanhao\/)/, [
    'verify:fanhao', 'verify:person-work-associations', 'verify:person-identity', 'verify:work-move-jobs',
    'verify:works-performance', 'verify:imports',
  ]],
  [/^(src\/modules\/market-dashboard\/|public\/modules\/market-dashboard\/)/, ['verify:market-dashboard', 'verify:imports']],
  [/^public\/games\/gomoku\//, ['verify:gomoku', 'verify:imports']],
  [/^public\/games\/jump\//, ['verify:jump', 'verify:imports']],
  [/^src\/modules\/system\/server\/android-update\//, [
    'verify:android-release-workflow', 'verify:android-security', 'verify:auth',
    'verify:mutation-auth', 'verify:system-control', 'verify:imports',
  ]],
  [/^(src\/modules\/system\/|public\/modules\/system\/)/, ['verify:system-control', 'verify:settings', 'verify:imports']],
  [/^(src\/platform\/server\/|server\.js$)/, ['verify:auth', 'verify:mutation-auth', 'verify:startup', 'verify:imports']],
  [/^(package(-lock)?\.json|tools\/run_verification\.mjs|tools\/verify_verification_runner\.mjs)$/, FULL_SCRIPTS],
];

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function selectScripts(files) {
  const selected = new Set();
  const unknownSourceFiles = [];
  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    const matching = RULES.find(([pattern]) => pattern.test(file));
    if (!matching) {
      if (/^(src|public|android-client|tools)\//.test(file) || /\.(mjs|js|cjs|ts|java|py|ps1)$/.test(file)) {
        unknownSourceFiles.push(file);
        FULL_SCRIPTS.forEach((script) => selected.add(script));
      } else {
        DAILY_SCRIPTS.forEach((script) => selected.add(script));
      }
      continue;
    }
    matching[1].forEach((script) => selected.add(script));
  }
  if (files.length === 0) DAILY_SCRIPTS.forEach((script) => selected.add(script));
  return { scripts: [...selected], unknownSourceFiles };
}

function splitScript(command) {
  return command.split(/\s+&&\s+/).map((part) => part.trim()).filter(Boolean);
}

export function expandCommands(entries, scripts) {
  const commands = [];
  const seen = new Set();
  const active = new Set();
  function add(command) {
    const npmScript = command.match(/^npm run ([\w:-]+)$/);
    if (npmScript && scripts[npmScript[1]]) {
      expand(npmScript[1]);
      return;
    }
    if (!seen.has(command)) {
      seen.add(command);
      commands.push(command);
    }
  }
  function expand(name) {
    if (active.has(name)) throw new Error(`Circular npm script reference: ${name}`);
    const command = scripts[name];
    if (!command) throw new Error(`Missing npm script: ${name}`);
    active.add(name);
    if (scripts[`pre${name}`]) expand(`pre${name}`);
    splitScript(command).forEach(add);
    if (scripts[`post${name}`]) expand(`post${name}`);
    active.delete(name);
  }
  for (const entry of entries) {
    if (entry.startsWith('command:')) add(entry.slice('command:'.length));
    else expand(entry);
  }
  return commands;
}

export function parseNullTerminatedPaths(output) {
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizePath);
}

export function isGeneratedCacheOnlyChange(file, before, after) {
  const prefix = 'android-client/www/';
  if (!file.startsWith(prefix) || !/\.(?:js|mjs|css|html)$/i.test(file) || before === after) return false;
  const relativePath = file.slice(prefix.length);
  const beforeLf = before.replace(/\r\n/g, '\n');
  const afterLf = after.replace(/\r\n/g, '\n');
  return beforeLf !== afterLf
    && normalizeAndroidCacheSource(relativePath, before) === normalizeAndroidCacheSource(relativePath, after);
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT });
  if (result.status !== 0) throw new Error(result.stderr.toString('utf8').trim() || `git ${args.join(' ')} failed`);
  return result.stdout;
}

function gitFile(ref) {
  const result = spawnSync('git', ['show', ref], { cwd: REPO_ROOT });
  if (result.status !== 0) return null;
  return result.stdout.toString('utf8');
}

function gitChangedFiles() {
  const unstaged = parseNullTerminatedPaths(runGit(['diff', '--name-only', '-z']));
  const staged = parseNullTerminatedPaths(runGit(['diff', '--cached', '--name-only', '-z']));
  const untracked = parseNullTerminatedPaths(runGit(['ls-files', '--others', '--exclude-standard', '-z']));
  const unstagedModified = new Set(parseNullTerminatedPaths(runGit(['diff', '--name-only', '--diff-filter=M', '-z'])));
  const stagedModified = new Set(parseNullTerminatedPaths(runGit(['diff', '--cached', '--name-only', '--diff-filter=M', '-z'])));
  const files = new Set([...unstaged, ...staged, ...untracked]);
  const filteredCacheFiles = [];
  for (const file of files) {
    if (!file.startsWith('android-client/www/') || untracked.includes(file)) continue;
    let cacheOnly = true;
    if (unstaged.includes(file)) {
      if (!unstagedModified.has(file)) cacheOnly = false;
      else {
        const before = gitFile(`:${file}`);
        const after = readFileSync(path.join(REPO_ROOT, ...file.split('/')), 'utf8');
        cacheOnly &&= before !== null && isGeneratedCacheOnlyChange(file, before, after);
      }
    }
    if (staged.includes(file)) {
      if (!stagedModified.has(file)) cacheOnly = false;
      else {
        const before = gitFile(`HEAD:${file}`);
        const after = gitFile(`:${file}`);
        cacheOnly &&= before !== null && after !== null && isGeneratedCacheOnlyChange(file, before, after);
      }
    }
    if (cacheOnly) {
      files.delete(file);
      filteredCacheFiles.push(file);
    }
  }
  return { files: [...files], filteredCacheFiles };
}

function parseArgs(argv) {
  const mode = argv[0] || 'daily';
  let plan = false;
  let explicitFiles = null;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') plan = true;
    else if (argument === '--files') {
      explicitFiles = [];
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) explicitFiles.push(argv[++index]);
      if (explicitFiles.length === 0) throw new Error('--files requires at least one path');
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (explicitFiles && mode !== 'changed') throw new Error('--files is only valid in changed mode');
  return { mode, plan, explicitFiles };
}

function printPlan(mode, files, entries, commands, unknownSourceFiles, filteredCacheFiles = []) {
  console.log(`Verification mode: ${mode}`);
  if (files) {
    console.log(`Changed files (${files.length}):`);
    files.forEach((file) => console.log(`  - ${file}`));
  }
  if (filteredCacheFiles.length > 0) {
    console.log(`Filtered generated Android cache-version changes (${filteredCacheFiles.length}); explicit --files still includes them.`);
  }
  console.log(`Checks (${entries.length} entry points, ${commands.length} unique commands):`);
  entries.forEach((entry) => console.log(`  - ${entry.replace(/^command:/, '')}`));
  const cacheSync = commands.find((command) => command === 'npm --prefix android-client run sync:cache');
  if (cacheSync) console.log(`Planned generated-file write before Android checks: ${cacheSync}`);
  if (unknownSourceFiles.length > 0) {
    console.warn('Unknown source scope detected; the plan conservatively includes the full verification suite:');
    unknownSourceFiles.forEach((file) => console.warn(`  - ${file}`));
  }
}

export function main(argv = process.argv.slice(2)) {
  const { mode, plan, explicitFiles } = parseArgs(argv);
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let files = null;
  let entries;
  let unknownSourceFiles = [];
  let filteredCacheFiles = [];
  if (mode === 'daily') entries = DAILY_SCRIPTS;
  else if (mode === 'android') entries = ANDROID_SCRIPTS;
  else if (mode === 'full') entries = FULL_SCRIPTS;
  else if (mode === 'changed') {
    if (explicitFiles) files = explicitFiles;
    else ({ files, filteredCacheFiles } = gitChangedFiles());
    ({ scripts: entries, unknownSourceFiles } = selectScripts(files));
  } else throw new Error(`Unknown verification mode: ${mode}`);

  const commands = expandCommands(entries, packageJson.scripts);
  printPlan(mode, files, entries, commands, unknownSourceFiles, filteredCacheFiles);
  if (plan) return;
  for (const command of commands) {
    console.log(`\n> ${command}`);
    const result = spawnSync(command, { cwd: REPO_ROOT, shell: true, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
