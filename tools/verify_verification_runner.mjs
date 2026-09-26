import assert from 'node:assert/strict';
import { expandCommands, isGeneratedCacheOnlyChange, parseNullTerminatedPaths, selectScripts } from './run_verification.mjs';

const commands = expandCommands(
  ['verify:first', 'verify:second'],
  {
    'verify:first': 'node one.mjs && npm run verify:shared',
    'verify:second': 'npm run verify:shared && node two.mjs',
    'verify:shared': 'node shared.mjs',
  },
);
assert.deepEqual(commands, ['node one.mjs', 'node shared.mjs', 'node two.mjs']);

const lifecycleCommands = expandCommands(
  ['verify:android-one', 'verify:android-two'],
  {
    'preverify:android-one': 'npm --prefix android-client run sync:cache',
    'verify:android-one': 'node android-one.mjs',
    'preverify:android-two': 'npm --prefix android-client run sync:cache',
    'verify:android-two': 'node android-two.mjs',
  },
);
assert.deepEqual(lifecycleCommands, [
  'npm --prefix android-client run sync:cache',
  'node android-one.mjs',
  'node android-two.mjs',
]);

assert.deepEqual(
  parseNullTerminatedPaths(Buffer.from('public/空 格.js\0android-client/www/modules/novels/小说.css\0')),
  ['public/空 格.js', 'android-client/www/modules/novels/小说.css'],
);

const cacheAppBefore = 'import "./cache.js?v=assets-111111111111";\nconst ready = true;\n';
const cacheAppAfter = 'import "./cache.js?v=assets-222222222222";\nconst ready = true;\n';
assert(isGeneratedCacheOnlyChange('android-client/www/app.js', cacheAppBefore, cacheAppAfter));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/app.js',
  cacheAppBefore,
  'import "./cache.js?v=assets-222222222222";\nconst ready = false;\n',
));
const cacheConfigBefore = 'export const CLIENT_VERSION = "assets-111111111111";\n';
const cacheConfigAfter = 'export const CLIENT_VERSION = "assets-222222222222";\n';
assert(isGeneratedCacheOnlyChange('android-client/www/js/config.js', cacheConfigBefore, cacheConfigAfter));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/images/icon.png',
  Buffer.from([0x00, 0x11]).toString('latin1'),
  Buffer.from([0x00, 0x22]).toString('latin1'),
));
assert(!isGeneratedCacheOnlyChange(
  'android-client/www/app.js',
  'const unchanged = true;\r\n',
  'const unchanged = true;\n',
));

const discoveredChanges = [
  { file: 'android-client/www/modules/novels/styles.css', before: '.reader { color: red; }', after: '.reader { color: blue; }' },
  { file: 'android-client/www/app.js', before: cacheAppBefore, after: cacheAppAfter },
  { file: 'android-client/www/js/cache.js', before: 'import "../app.js?v=assets-111111111111";\n', after: 'import "../app.js?v=assets-222222222222";\n' },
];
const meaningfulFiles = discoveredChanges
  .filter(({ file, before, after }) => !isGeneratedCacheOnlyChange(file, before, after))
  .map(({ file }) => file);
assert.deepEqual(meaningfulFiles, ['android-client/www/modules/novels/styles.css']);
const novelWithFilteredCacheNoise = selectScripts(meaningfulFiles);
assert(novelWithFilteredCacheNoise.scripts.includes('verify:android-novels'));
assert(!novelWithFilteredCacheNoise.scripts.includes('verify:android-client'));

const android = selectScripts(['android-client/www/app.js']);
assert(android.scripts.includes('verify:android-client'));
assert(android.scripts.includes('verify:android-security'));
assert.equal(android.unknownSourceFiles.length, 0);

const androidNovel = selectScripts(['android-client/www/modules/novels/mobile-refinements.css']);
assert(androidNovel.scripts.includes('verify:android-novels'));
assert(!androidNovel.scripts.includes('verify:android-client'));

const nativeShortVideo = selectScripts([
  'android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java',
]);
assert(nativeShortVideo.scripts.includes('verify:short-video-client'));
assert(!nativeShortVideo.scripts.includes('verify:android-media'));

assert(selectScripts(['public/modules/market-dashboard/app.js']).scripts.includes('verify:market-dashboard'));
assert(selectScripts(['public/games/gomoku/gomoku.js']).scripts.includes('verify:gomoku'));
assert(selectScripts(['public/games/jump/integration.js']).scripts.includes('verify:jump'));

const androidUpdate = selectScripts(['src/modules/system/server/android-update/service.js']);
assert(androidUpdate.scripts.includes('verify:android-release-workflow'));
assert(androidUpdate.scripts.includes('verify:android-security'));

const sharedPublicShell = selectScripts(['public/app.js']);
assert(sharedPublicShell.scripts.includes('verify:startup'));
assert.deepEqual(sharedPublicShell.unknownSourceFiles, ['public/app.js']);

const docs = selectScripts(['docs/site/reference/verification.md']);
assert.deepEqual(docs.scripts, ['command:npm --prefix docs test', 'command:npm --prefix docs run build']);

const unknown = selectScripts(['tools/new_unclassified_source.mjs']);
assert(unknown.scripts.includes('verify:startup'));
assert.deepEqual(unknown.unknownSourceFiles, ['tools/new_unclassified_source.mjs']);

console.log('Verification runner fixtures passed.');
