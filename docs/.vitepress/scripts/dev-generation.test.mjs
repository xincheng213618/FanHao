import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createGenerationScheduler, devGenerationPlugin } from './dev-generation.mjs';
import { docsRoot, sourceRoot, generatedRoot } from './content.mjs';

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, time: now + delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, { callback, time }] of [...timers]) {
        if (time <= now && timers.delete(id)) callback();
      }
    },
    get pending() { return timers.size; }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

function schedulerFixture() {
  const timers = clock();
  const runs = [];
  const errors = [];
  const scheduler = createGenerationScheduler({
    ...timers,
    debounceMs: 100,
    run(signal) {
      const current = { ...deferred(), signal };
      runs.push(current);
      return current.promise;
    },
    onError: (error) => errors.push(error)
  });
  return { scheduler, timers, runs, errors };
}

test('dev generation debounces successive changes and only runs after quiet time', async () => {
  const { scheduler, timers, runs } = schedulerFixture();
  scheduler.request();
  timers.advance(80);
  scheduler.request();
  timers.advance(99);
  assert.equal(runs.length, 0);
  timers.advance(1);
  assert.equal(runs.length, 1);
  runs[0].resolve();
  await settle();
  assert.equal(timers.pending, 0);
  scheduler.close();
});

test('changes during generation collapse into one serialized follow-up', async () => {
  const { scheduler, timers, runs } = schedulerFixture();
  scheduler.request();
  timers.advance(100);
  scheduler.request();
  scheduler.request();
  timers.advance(100);
  assert.equal(runs.length, 1);
  runs[0].resolve();
  await settle();
  assert.equal(runs.length, 2);
  runs[1].resolve();
  await settle();
  assert.equal(runs.length, 2);
  scheduler.close();
});

test('a fast generation still waits for the next change debounce', async () => {
  const { scheduler, timers, runs } = schedulerFixture();
  scheduler.request();
  timers.advance(100);
  scheduler.request();
  runs[0].resolve();
  await settle();
  assert.equal(runs.length, 1);
  timers.advance(100);
  assert.equal(runs.length, 2);
  runs[1].resolve();
  await settle();
  scheduler.close();
});

test('generation failures are reported and later edits can recover', async () => {
  const { scheduler, timers, runs, errors } = schedulerFixture();
  scheduler.request();
  timers.advance(100);
  const failure = new Error('invalid frontmatter');
  runs[0].reject(failure);
  await settle();
  assert.deepEqual(errors, [failure]);
  scheduler.request();
  timers.advance(100);
  assert.equal(runs.length, 2);
  runs[1].resolve();
  await settle();
  assert.deepEqual(errors, [failure]);
  scheduler.close();
});

test('shutdown cancels timers, aborts an active run, and ignores queued changes', async () => {
  const { scheduler, timers, runs, errors } = schedulerFixture();
  scheduler.request();
  timers.advance(100);
  scheduler.request();
  scheduler.close();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(timers.pending, 0);
  scheduler.request();
  timers.advance(100);
  runs[0].reject(new Error('aborted'));
  await settle();
  assert.equal(runs.length, 1);
  assert.deepEqual(errors, []);
});

function pluginFixture({ httpServer = new EventEmitter() } = {}) {
  const timers = clock();
  const children = [];
  const errors = [];
  const watched = [];
  const watcher = new EventEmitter();
  watcher.add = (file) => watched.push(file);
  const plugin = devGenerationPlugin({
    ...timers,
    debounceMs: 100,
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => {};
      children.push({ child, command, args, options });
      return child;
    }
  });
  plugin.configureServer({ watcher, httpServer, config: { logger: { error: (message) => errors.push(message) } } });
  return { timers, children, errors, watched, watcher, httpServer, plugin };
}

test('Vite plugin watches sources only and launches the generator with a hidden Node process', async () => {
  const { timers, children, watched, watcher, plugin } = pluginFixture();
  assert.deepEqual(watched, [sourceRoot]);
  for (const file of [path.join(generatedRoot, 'llms.txt'), path.join(docsRoot, 'old.md'), sourceRoot + '-private/hidden.md']) {
    watcher.emit('all', 'change', file);
  }
  watcher.emit('all', 'ready', sourceRoot);
  timers.advance(100);
  assert.equal(children.length, 0);
  for (const event of ['add', 'change', 'unlink']) watcher.emit('all', event, path.join(sourceRoot, 'ai', 'context.md'));
  timers.advance(100);
  assert.equal(children.length, 1);
  const { child, command, args, options } = children[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [path.join(docsRoot, '.vitepress', 'scripts', 'generate.mjs')]);
  assert.equal(options.cwd, docsRoot);
  assert.equal(options.windowsHide, true);
  assert.equal(options.signal.aborted, false);
  child.emit('close', 0, null);
  await settle();
  plugin.closeBundle();
});

test('Vite logs generator diagnostics and remains usable after failure', async () => {
  const { timers, children, errors, watcher, plugin } = pluginFixture();
  watcher.emit('all', 'change', path.join(sourceRoot, 'index.md'));
  timers.advance(100);
  children[0].child.stderr.emit('data', 'frontmatter validation failed');
  children[0].child.emit('close', 1, null);
  await settle();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /exit 1/);
  assert.match(errors[0], /frontmatter validation failed/);
  watcher.emit('all', 'change', path.join(sourceRoot, 'index.md'));
  timers.advance(100);
  assert.equal(children.length, 2);
  children[1].child.emit('close', 0, null);
  await settle();
  plugin.closeBundle();
});

test('HTTP close removes only the plugin listener and aborts the child process', async () => {
  const { timers, children, errors, watcher, httpServer, plugin } = pluginFixture();
  const otherListener = () => {};
  watcher.on('all', otherListener);
  watcher.emit('all', 'change', path.join(sourceRoot, 'index.md'));
  timers.advance(100);
  watcher.emit('all', 'change', path.join(sourceRoot, 'index.md'));
  httpServer.emit('close');
  assert.deepEqual(watcher.listeners('all'), [otherListener]);
  assert.equal(httpServer.listenerCount('close'), 0);
  assert.equal(timers.pending, 0);
  assert.equal(children[0].options.signal.aborted, true);
  children[0].child.emit('error', new Error('aborted'));
  children[0].child.emit('close', null, 'SIGTERM');
  await settle();
  timers.advance(100);
  assert.equal(children.length, 1);
  assert.deepEqual(errors, []);
  plugin.closeBundle();
});

test('Vite shutdown also cleans up when running without an HTTP server', () => {
  const { timers, children, watcher, plugin } = pluginFixture({ httpServer: null });
  watcher.emit('all', 'change', path.join(sourceRoot, 'index.md'));
  plugin.closeBundle();
  timers.advance(100);
  assert.equal(watcher.listenerCount('all'), 0);
  assert.equal(children.length, 0);
  assert.equal(timers.pending, 0);
});
