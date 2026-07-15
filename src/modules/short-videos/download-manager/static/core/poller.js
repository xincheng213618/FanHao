export function createSingleFlightPoller(task, intervalMs, options = {}) {
  const onError = options.onError || (() => {});
  let timer = null;
  let inFlight = null;

  function run() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(task)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  function start() {
    if (timer !== null) return;
    timer = window.setInterval(() => {
      run().catch(onError);
    }, intervalMs);
  }

  function stop() {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  }

  return { run, start, stop };
}
