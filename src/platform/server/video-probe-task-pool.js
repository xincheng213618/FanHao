// The pool owns the entire cold operation, including filesystem waits. A task
// that owns a child must not settle until that child's close event is observed.
export function createVideoProbeTaskPool({ concurrency = 2, capacity = 48 } = {}) {
  concurrency = Math.max(1, Math.min(4, Math.floor(Number(concurrency) || 2)));
  capacity = Math.max(concurrency, Math.min(96, Math.floor(Number(capacity) || 48)));
  const tasks = new Set(), queue = [];
  let active = 0;

  function pump() {
    while (active < concurrency && queue.length) {
      const index = Math.max(0, queue.findIndex((task) => !task.background));
      const task = queue.splice(index, 1)[0];
      task.started = true;
      active++;
      let operation;
      try { operation = task.run(task.controller.signal); }
      catch (error) { operation = Promise.reject(error); }
      const finish = (value, error) => {
        active--;
        tasks.delete(task);
        if (error) task.reject(error); else task.resolve(value);
        pump();
      };
      Promise.resolve(operation).then((value) => finish(value), (error) => finish(null, error));
    }
  }

  function submit(run, { background = false } = {}) {
    if (tasks.size >= capacity) {
      throw Object.assign(new Error("Video probe queue is full"), { code: "PROBE_BUSY" });
    }
    const task = { run, background, started: false, controller: new AbortController() };
    task.promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
    task.promote = () => { task.background = false; };
    task.cancel = () => {
      task.controller.abort();
      if (task.started) return;
      const index = queue.indexOf(task);
      if (index >= 0) queue.splice(index, 1);
      tasks.delete(task);
      task.resolve(null);
    };
    tasks.add(task);
    queue.push(task);
    pump();
    return task;
  }

  return {
    submit,
    hasCapacity: () => tasks.size < capacity,
    cancelAll: () => { for (const task of [...tasks]) task.cancel(); },
    drain: async () => { await Promise.allSettled([...tasks].map((task) => task.promise)); },
    diagnostics: () => ({ active, queued: queue.length, capacity, concurrency })
  };
}
