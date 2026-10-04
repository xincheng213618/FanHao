function stopped() {
  return Object.assign(new Error("Local image reader is stopping"), { code: "LOCAL_IMAGE_STOPPED", statusCode: 503 });
}

export function localImageDiskIdentity(filePath, stat) {
  return JSON.stringify([String(filePath), Number(stat?.size), Number(stat?.mtimeMs ?? stat?.mtime?.getTime?.()), String(stat?.dev ?? ""), String(stat?.ino ?? "")]);
}

export function createLocalImageReadQueue({ concurrency, capacity = 128, sourceKey, sourceId, statFile, readFile, capture, current, persist, persistError, fallback, warn }) {
  concurrency = boundedInteger(concurrency, 4, 1, 16);
  capacity = boundedInteger(capacity, 128, concurrency, 512);
  const tasks = new Set(), shared = new Map(), owners = new Map(), queue = [];
  let active = 0, accepting = true, generation = 0, stopping = null;

  function observe(file) {
    const id = sourceId(file), key = sourceKey(file), owner = owners.get(id);
    if (owner) owner.key = key;
    return { id, key, owner };
  }

  function load(file, { signal } = {}) {
    if (!accepting || signal?.aborted) return Promise.reject(stopped());
    file = { ...file };
    const source = observe(file);
    let task = shared.get(source.key);
    if (task?.controller.signal.aborted) task = null;
    if (!task) {
      if (tasks.size >= capacity) return Promise.reject(Object.assign(new Error("Local image queue is full"), { code: "LOCAL_IMAGE_QUEUE_FULL", statusCode: 503 }));
      let resolve, reject;
      const context = capture(file);
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const owner = source.owner || { key: source.key, pending: 0 };
      owner.pending++; owners.set(source.id, owner);
      task = { file, key: source.key, id: source.id, owner, context, generation, controller: new AbortController(), consumers: new Set(), phase: "queued", promise, resolve, reject };
      // Cancelled reads still own their physical I/O and capacity. A fresh
      // consumer must wait for those reads, rather than inherit their abort.
      const predecessors = [...tasks].filter(value => value.key === task.key && value.phase === "reading" && value.controller.signal.aborted);
      task.blocked = predecessors.length > 0;
      tasks.add(task); shared.set(task.key, task); queue.push(task);
      if (task.blocked) Promise.allSettled(predecessors.map(value => value.promise)).then(() => { task.blocked = false; drain(); });
      const settled = () => {
        tasks.delete(task);
        if (shared.get(task.key) === task) shared.delete(task.key);
        owner.pending--;
        if (!owner.pending && owners.get(task.id) === owner) owners.delete(task.id);
        for (const consumer of task.consumers) consumer.signal?.removeEventListener("abort", consumer.abort);
        task.consumers.clear();
      };
      promise.then(settled, settled);
    }
    const consumer = { signal, aborted: false };
    consumer.abort = () => {
      consumer.aborted = true;
      if (![...task.consumers].some(value => !value.aborted)) cancel(task);
    };
    task.consumers.add(consumer);
    signal?.addEventListener("abort", consumer.abort, { once: true });
    if (signal?.aborted) consumer.abort();
    drain();
    return task.promise;
  }

  function cancel(task) {
    task.controller.abort();
    if (task.phase === "queued") {
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      task.phase = "settled"; task.reject(stopped());
    }
  }

  function canWrite(task) {
    return !task.controller.signal.aborted && task.generation === generation && task.owner.key === task.key && current(task.file, task.context);
  }

  async function diskStamp(file) {
    try { return localImageDiskIdentity(file.path, await statFile(file.path)); }
    catch (error) { return JSON.stringify([file.path, "missing", error.code || "unknown"]); }
  }

  async function run(task) {
    let before;
    try {
      let stat;
      try { stat = await statFile(task.file.path); before = localImageDiskIdentity(task.file.path, stat); }
      catch (error) { before = JSON.stringify([task.file.path, "missing", error.code || "unknown"]); throw error; }
      if (task.controller.signal.aborted) throw stopped();
      if (!stat?.isFile?.() || stat.size <= 0) throw Object.assign(new Error("empty or missing local image"), { statusCode: 404 });
      const buffer = await readFile(task.file.path, { signal: task.controller.signal });
      if (task.controller.signal.aborted) throw stopped();
      if (!buffer?.length) throw Object.assign(new Error("empty local image"), { statusCode: 404 });
      const row = fallback(task.file, buffer);
      const after = await diskStamp(task.file);
      // All authority checks follow the last asynchronous filesystem operation.
      if (before !== after || (task.file.diskIdentity && task.file.diskIdentity !== before) || !canWrite(task)) return row;
      try { return persist(task.file, stat, buffer, task.context); }
      catch (error) { warn(error); return row; }
    } catch (error) {
      if (!task.controller.signal.aborted && before !== undefined) {
        const after = await diskStamp(task.file);
        if (before === after && (!task.file.diskIdentity || task.file.diskIdentity === before) && canWrite(task)) persistError(task.file, error, task.context);
      }
      if (task.controller.signal.aborted) throw stopped();
      warn(error); throw error;
    }
  }

  function drain() {
    while (accepting && active < concurrency && queue.length) {
      const index = queue.findIndex(task => !task.blocked);
      if (index < 0) break;
      const [task] = queue.splice(index, 1); task.phase = "reading"; active++;
      // Keep ownership until the filesystem promise has actually settled,
      // even when its consumers have disconnected or requested shutdown.
      run(task).then(task.resolve, task.reject).finally(() => { active--; task.phase = "settled"; drain(); });
    }
  }

  function beginStop() {
    generation++; accepting = false;
    for (const task of tasks) cancel(task);
  }
  function stop() {
    beginStop();
    if (!stopping) stopping = Promise.allSettled([...tasks].map(task => task.promise));
    return stopping;
  }
  async function start() {
    const intent = ++generation;
    if (stopping) await stopping;
    if (intent !== generation) throw stopped();
    stopping = null; accepting = true;
  }
  return { observe, load, start, beginStop, stop, isAccepting: () => accepting, diagnostics: () => ({ accepting, active, pending: queue.length, tasks: tasks.size, owners: owners.size }) };
}

export function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Math.floor(Number.isFinite(number) ? number : fallback)));
}
