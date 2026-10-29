let nextHoldToken = 0;

export function createShortVideoHoldSpeedController({
  player, stage, getActivePlayer, getBaseRate, normalizeRate = (value) => value,
  onArm = () => {}, onActivate = () => {}, onFinish = () => {},
  armDelay = 360, armTolerance = 12, activeTolerance = 32,
  windowTarget = window, documentTarget = document,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (handle) => window.clearTimeout(handle)
}) {
  let gesture = null, timer = null, disposed = false, consumedClick = false;
  const listeners = [], globalListeners = [], blockedDownEvents = new WeakSet();
  const identity = () => [String(player.dataset.videoId || ""), player.getAttribute?.("src") || player.currentSrc || "",
    String(player.dataset.shortVideoSourceGeneration || "0"), player.dataset.shortVideoSlot || "",
    player.dataset.shortVideoPromotedAt || "", player.dataset.shortVideoWarmScheduleToken || "",
    String(player.dataset.shortVideoPlaybackIntentGeneration || "0")];
  const owns = (owner) => Boolean(!disposed && owner && player.isConnected && stage.isConnected
    && getActivePlayer() === player && !player.classList?.contains("is-ghost")
    && identity().every((value, index) => value === owner.identity[index]));
  const clearPending = () => { if (timer != null) clearTimer(timer); timer = null; };
  const detachGlobals = () => {
    globalListeners.splice(0).forEach(([target, name, listener]) => target.removeEventListener(name, listener, true));
  };
  const stop = ({ suppressClick = false } = {}) => {
    const owner = gesture;
    if (!owner) return;
    const stillCurrent = owns(owner);
    gesture = null;
    clearPending();
    detachGlobals();
    const active = owner.active && player.dataset.shortVideoHoldSpeedToken === owner.token;
    if (active) {
      delete player.dataset.holdSpeedActive;
      delete player.dataset.shortVideoHoldSpeedToken;
      // The temporary rate belongs to this token, but its restoration always
      // uses the latest user preference. Source/role cancellation must not
      // write an older captured base rate over a more recent speed choice.
      if (player.playbackRate === 2) player.playbackRate = normalizeRate(getBaseRate());
      onFinish({ active: true, suppressClick: Boolean(suppressClick && stillCurrent) });
    }
    try { if (player.hasPointerCapture?.(owner.pointerId)) player.releasePointerCapture?.(owner.pointerId); } catch {}
  };
  const finishPointer = (event, suppressClick = true) => {
    if (gesture && event.pointerId === gesture.pointerId) stop({ suppressClick });
  };
  const move = (event) => {
    const owner = gesture;
    if (!owner || event.pointerId !== owner.pointerId) return;
    if (!owns(owner) || player.paused || player.ended || player.error) { stop(); return; }
    const x = Number(event.clientX), y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)
      || Math.hypot(x - owner.x, y - owner.y) > (owner.active ? activeTolerance : armTolerance)) {
      stop({ suppressClick: owner.active });
    }
  };
  const anotherPointer = (event) => {
    if (!gesture || event.pointerId === gesture.pointerId) return;
    if ([gesture.pointerType, event.pointerType].some((type) => type === "touch" || type === "pen")) {
      blockedDownEvents.add(event);
      stop();
    }
  };
  const addGlobal = (target, name, listener) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, listener, true);
    globalListeners.push([target, name, listener]);
  };
  const activate = (owner) => {
    if (gesture !== owner) return;
    timer = null;
    if (!owns(owner) || player.paused || player.ended || player.error) { stop(); return; }
    owner.active = true;
    owner.token = String(++nextHoldToken);
    consumedClick = true;
    player.dataset.shortVideoHoldSpeedToken = owner.token;
    player.dataset.holdSpeedActive = "1";
    const baseRate = normalizeRate(getBaseRate());
    player.playbackRate = 2;
    onActivate(baseRate);
  };
  const down = (event) => {
    if (disposed || blockedDownEvents.has(event)) return;
    if (gesture) { anotherPointer(event); return; }
    if (event.button !== 0 || event.isPrimary === false || !Number.isFinite(event.pointerId)
      || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    consumedClick = false;
    const owner = { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY,
      identity: identity(), active: false, token: "" };
    if (!owns(owner) || player.paused || player.ended || player.error) return;
    onArm();
    gesture = owner;
    const guarded = (listener) => (event) => { if (gesture === owner) listener(event); };
    addGlobal(windowTarget, "pointerup", guarded(finishPointer));
    addGlobal(windowTarget, "pointercancel", guarded((event) => finishPointer(event, false)));
    addGlobal(windowTarget, "pointermove", guarded(move));
    addGlobal(windowTarget, "pointerdown", guarded(anotherPointer));
    addGlobal(windowTarget, "blur", guarded((event) => { if (event.target === windowTarget) stop(); }));
    addGlobal(documentTarget, "visibilitychange", guarded(() => { if (documentTarget.hidden) stop(); }));
    try { player.setPointerCapture?.(event.pointerId); } catch { /* Window listeners still own the eventual release. */ }
    timer = setTimer(() => activate(owner), armDelay);
  };
  const listen = (name, listener, capture = false) => {
    player.addEventListener(name, listener, capture);
    listeners.push([name, listener, capture]);
  };
  listen("pointerdown", down);
  listen("pointermove", move);
  listen("pointerup", finishPointer);
  listen("pointercancel", (event) => finishPointer(event, false));
  listen("lostpointercapture", finishPointer);
  listen("pointerleave", (event) => {
    if (gesture && !player.hasPointerCapture?.(gesture.pointerId)) finishPointer(event);
  });
  ["pause", "emptied", "loadstart"].forEach((name) => listen(name, () => stop()));
  listen("contextmenu", (event) => { if (gesture) event.preventDefault(); });
  // A hold can be cancelled by keyboard pause long before the pointer is
  // released. Consume that pointer's eventual click without a short timer;
  // the next real pointerdown clears this marker, and keyboard clicks remain
  // native (detail === 0).
  listen("click", (event) => {
    if (!consumedClick || Number(event.detail || 0) === 0) return;
    consumedClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  const cancel = (options) => stop(options);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stop();
    consumedClick = false;
    clearPending();
    detachGlobals();
    listeners.splice(0).forEach(([name, listener, capture]) => player.removeEventListener(name, listener, capture));
    if (player.shortVideoCancelHoldSpeed === cancel) delete player.shortVideoCancelHoldSpeed;
    if (player.shortVideoDisposeHoldSpeed === dispose) {
      delete player.shortVideoDisposeHoldSpeed;
      delete player.dataset.holdSpeedBound;
    }
  };
  return { cancel, dispose };
}
