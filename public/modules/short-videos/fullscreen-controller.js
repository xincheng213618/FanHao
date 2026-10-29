// The native fullscreen target outlives individual reels. Keep the latest
// viewer intent separate from the browser's asynchronous enter/exit request.
export function createShortVideoFullscreenController({
  document,
  getTarget = () => null,
  onChange = () => {},
  onError = () => {}
} = {}) {
  let desiredTarget = null;
  let ownedTarget = null;
  let cleanupTarget = null;
  let operation = null;
  let blockedExitTarget = null;
  let generation = 0;
  let lastNativeElement = document?.fullscreenElement || null;

  const targetNow = () => {
    const target = getTarget();
    return target?.isConnected === false ? null : target || null;
  };
  const nativeElement = () => document?.fullscreenElement || null;
  const isActive = () => {
    const target = targetNow();
    return Boolean(target && nativeElement() === target);
  };
  const unsupported = (message) => Object.assign(new Error(message), { name: "NotSupportedError" });
  const notify = () => onChange();

  function start(kind, target, cleanup = false) {
    const owner = { kind, target, cleanup, generation, seenActive: nativeElement() === target, promise: null };
    operation = owner;
    notify();
    let nativeRequest;
    try {
      // The initial enter must happen on the user's call stack: deferring the
      // API invocation to a promise loses transient browser activation.
      if (kind === "enter") {
        if (typeof target.requestFullscreen !== "function") throw unsupported("当前浏览器不支持网页全屏");
        nativeRequest = target.requestFullscreen();
      } else {
        if (typeof document?.exitFullscreen !== "function") throw unsupported("当前浏览器无法退出网页全屏");
        nativeRequest = document.exitFullscreen();
      }
    } catch (error) {
      nativeRequest = Promise.reject(error);
    }
    owner.promise = Promise.resolve(nativeRequest).then(() => {
      const native = nativeElement();
      if (kind === "enter") {
        if (native === target) {
          ownedTarget = target;
          if (owner.generation !== generation || desiredTarget !== target || targetNow() !== target) cleanupTarget = target;
        } else if (owner.generation === generation && desiredTarget === target) {
          // Escape or another native surface already took ownership. A
          // fulfilled old promise must not reopen our fullscreen view.
          desiredTarget = null;
        }
      } else {
        if (cleanupTarget === target) cleanupTarget = null;
        if (native !== target && ownedTarget === target) ownedTarget = null;
        if (native === target) {
          blockedExitTarget = target;
          // Do not spin if a browser resolves without changing native state.
          if (targetNow() === target) desiredTarget = target;
          else desiredTarget = null;
        }
      }
    }, (error) => {
      const current = owner.generation === generation && targetNow() === target;
      if (kind === "enter") {
        if (current && desiredTarget === target) {
          desiredTarget = null;
          onError(error, "enter");
        }
      } else {
        blockedExitTarget = target;
        if (cleanupTarget === target) cleanupTarget = null;
        if (!cleanup && current && desiredTarget === null && nativeElement() === target) {
          desiredTarget = target;
          onError(error, "exit");
        }
      }
    }).then(() => {
      if (operation === owner) operation = null;
      notify();
      return drive();
    });
    return owner.promise;
  }

  function drive() {
    if (operation) return operation.promise || Promise.resolve(false);
    const native = nativeElement();
    if (cleanupTarget) {
      const target = cleanupTarget;
      if (native === target && blockedExitTarget !== target) return start("exit", target, true);
      cleanupTarget = null;
      if (ownedTarget === target) ownedTarget = null;
    }
    if (desiredTarget && targetNow() !== desiredTarget) desiredTarget = null;
    if (ownedTarget && native !== ownedTarget) ownedTarget = null;
    if (ownedTarget && !desiredTarget && native === ownedTarget && blockedExitTarget !== ownedTarget) return start("exit", ownedTarget);
    if (desiredTarget) {
      if (native === desiredTarget) {
        ownedTarget = desiredTarget;
        return Promise.resolve(true);
      }
      return start("enter", desiredTarget);
    }
    return Promise.resolve(false);
  }

  function toggle() {
    const target = targetNow();
    if (!target) return Promise.resolve(false);
    blockedExitTarget = null;
    if (operation && operation.target !== target) generation += 1;
    const wanted = operation ? desiredTarget === target : nativeElement() === target;
    desiredTarget = wanted ? null : target;
    if (nativeElement() === target) ownedTarget = target;
    notify();
    return drive();
  }

  function cancel() {
    blockedExitTarget = null;
    generation += 1;
    desiredTarget = null;
    if (ownedTarget && nativeElement() === ownedTarget) cleanupTarget = ownedTarget;
    notify();
    return drive();
  }

  function changed() {
    const native = nativeElement();
    if (native !== blockedExitTarget) blockedExitTarget = null;
    const target = targetNow();
    if (!target || (operation?.kind === "enter" && target !== operation.target)) {
      if (desiredTarget || operation?.generation === generation) generation += 1;
      desiredTarget = null;
    }
    if (operation?.kind === "enter") {
      if (native === operation.target) operation.seenActive = true;
      else if (operation.seenActive || (native && native !== lastNativeElement && native !== operation.target)) {
        generation += 1;
        desiredTarget = null;
      }
    } else if (!operation) {
      if (native && native === target) {
        ownedTarget = target;
        desiredTarget = target;
      } else {
        desiredTarget = null;
        if (ownedTarget && native !== ownedTarget) ownedTarget = null;
      }
    } else if (native && native !== operation.target && native !== lastNativeElement) {
      generation += 1;
      desiredTarget = null;
    }
    lastNativeElement = native;
    if (!target && native && native === ownedTarget) cleanupTarget = ownedTarget;
    notify();
    return drive();
  }

  return { toggle, cancel, changed, isActive, isPending: () => Boolean(operation) };
}
