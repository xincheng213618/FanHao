import path from 'node:path';
import { spawn } from 'node:child_process';
import { docsRoot, sourceRoot, inside } from './content.mjs';

// A change during a run is retained, but never starts a concurrent generator.
export function createGenerationScheduler({
  run,
  onError,
  debounceMs = 150,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let timer;
  let active;
  let pending = false;
  let closed = false;

  async function start() {
    if (closed || active || !pending) return;
    pending = false;
    active = new AbortController();
    try {
      await run(active.signal);
    } catch (error) {
      if (!closed) onError(error);
    } finally {
      active = undefined;
      if (!closed && pending && timer === undefined) void start();
    }
  }

  return {
    request() {
      if (closed) return;
      pending = true;
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(() => {
        timer = undefined;
        void start();
      }, debounceMs);
    },
    close() {
      closed = true;
      pending = false;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      active?.abort();
    }
  };
}

function runGeneration(signal, spawnProcess) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [path.join(docsRoot, '.vitepress', 'scripts', 'generate.mjs')], {
      cwd: docsRoot,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      signal
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once('error', reject);
    child.once('close', (code, terminationSignal) => {
      if (code === 0) resolve();
      else reject(new Error('docs:generate failed (' + (terminationSignal || 'exit ' + code) + ')' + (stderr ? '\n' + stderr.trim() : '')));
    });
  });
}

export function devGenerationPlugin({
  debounceMs = 150,
  spawnProcess = spawn,
  setTimer,
  clearTimer
} = {}) {
  let cleanup;
  return {
    name: 'fanhao-docs-dev-generation',
    apply: 'serve',
    configureServer(server) {
      cleanup?.();
      const scheduler = createGenerationScheduler({
        debounceMs,
        setTimer,
        clearTimer,
        run: (signal) => runGeneration(signal, spawnProcess),
        onError: (error) => server.config.logger.error('[docs:generate] ' + (error.stack || error.message || String(error)))
      });
      const onChange = (event, file) => {
        if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) return;
        if (inside(sourceRoot, path.resolve(docsRoot, file))) scheduler.request();
      };
      cleanup = () => {
        server.watcher.off('all', onChange);
        server.httpServer?.off('close', cleanup);
        scheduler.close();
      };
      // Keep Vite's shared watcher intact: remove our listener, not its watched paths.
      server.watcher.add(sourceRoot);
      server.watcher.on('all', onChange);
      server.httpServer?.once('close', cleanup);
    },
    closeBundle() {
      cleanup?.();
    }
  };
}
