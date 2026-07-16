export function createLatestRequestGate() {
  let controller = null;
  let sequence = 0;

  function begin() {
    controller?.abort();
    const requestController = new AbortController();
    const requestSequence = ++sequence;
    controller = requestController;
    return {
      signal: requestController.signal,
      isCurrent: () => controller === requestController && sequence === requestSequence,
      finish: () => {
        if (controller === requestController) controller = null;
      }
    };
  }

  function cancel() {
    sequence += 1;
    controller?.abort();
    controller = null;
  }

  return { begin, cancel };
}
