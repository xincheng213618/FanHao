export function createLatestRequestLifecycle() {
  let generation = 0;
  let activeRequest = null;

  return {
    get inFlight() {
      return activeRequest !== null;
    },

    begin(snapshot) {
      activeRequest?.controller.abort();
      const controller = new AbortController();
      const request = {
        controller,
        generation: ++generation,
        signal: controller.signal,
        snapshot: String(snapshot),
      };
      activeRequest = request;
      return request;
    },

    canCommit(request, snapshot) {
      return activeRequest === request
        && request.generation === generation
        && request.snapshot === String(snapshot);
    },

    finish(request) {
      if (activeRequest !== request) return false;
      activeRequest = null;
      return true;
    },
  };
}
