export function normalizeShortVideoWheelDelta(event, { lineHeight = 16, pageHeight = 720 } = {}) {
  if (!event || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return 0;
  const x = Number(event.deltaX ?? 0), y = Number(event.deltaY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) >= Math.abs(y)) return 0;
  const mode = Number(event.deltaMode ?? 0);
  const scale = mode === 1 ? lineHeight : mode === 2 ? pageHeight : mode === 0 ? 1 : 0;
  const delta = y * scale;
  return Number.isFinite(delta) ? delta : 0;
}

export function createShortVideoWheelController({
  captureOwner, ownsOwner, clearOwner, onDrag, onSnap, onCancelDrag, onFlushDrag,
  onNavigate, queueDirection, isLocked, getIgnoreUntil, getScope, hasPointerSession = () => false,
  now = Date.now, setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (handle) => window.clearTimeout(handle), pageHeight = () => 720,
  distance = 82, idleMs = 220, newGestureGapMs = 160, onError = () => {}
}) {
  let delta = 0, lastAt = null, startedAt = null, consumed = false, visualOwner = null;
  let timer = null, timerToken = 0, lifecycle = 0, scope = null, disposed = false;
  const clearPending = () => { timerToken += 1; if (timer != null) clearTimer(timer); timer = null; };
  const schedule = (callback, delay) => {
    clearPending();
    const token = timerToken;
    timer = setTimer(() => { if (token !== timerToken || disposed) return; timer = null; callback(); }, delay);
  };
  const clearVisual = () => {
    const owner = visualOwner;
    visualOwner = null; delta = 0;
    if (owner) { onCancelDrag(owner); clearOwner(owner); }
  };
  const settleVisual = (owner) => {
    if (owner && ownsOwner(owner) && !hasPointerSession()) onSnap(owner);
    else if (owner) clearOwner(owner);
  };
  const cancelVisual = () => { clearPending(); clearVisual(); };
  const cancel = ({ preserveConsumed = false } = {}) => {
    cancelVisual();
    if (!preserveConsumed) {
      lifecycle += 1;
      consumed = false; startedAt = null; lastAt = null; scope = null;
    }
  };
  const release = () => {
    clearPending();
    if (disposed || !consumed) return;
    const owner = visualOwner;
    const finish = () => {
      if (isLocked()) return; // The navigation completion calls release again.
      const remaining = idleMs - (now() - (lastAt ?? now()));
      if (remaining > 0) { schedule(finish, Math.max(16, remaining)); return; }
      consumed = false; startedAt = null; delta = 0;
      if (visualOwner === owner) visualOwner = null;
      settleVisual(owner);
    };
    const remaining = idleMs - (now() - (lastAt ?? now()));
    if (!isLocked() && remaining <= 0) finish();
    else schedule(finish, Math.max(16, remaining));
  };
  const handle = (event) => {
    if (disposed) return false;
    const amount = normalizeShortVideoWheelDelta(event, { pageHeight: Number(pageHeight()) || 720 });
    if (Math.abs(amount) < 2) return false;
    if (hasPointerSession()) { cancelVisual(); return false; }
    const owner = captureOwner();
    if (!owner || !ownsOwner(owner)) { cancel(); return false; }
    const currentScope = getScope();
    if (scope !== currentScope) cancel();
    scope = currentScope;
    if (visualOwner && !ownsOwner(visualOwner)) clearVisual();
    const timestamp = now(), gap = lastAt == null ? Infinity : timestamp - lastAt;
    if (consumed && gap >= idleMs && !isLocked()) { consumed = false; startedAt = null; }
    lastAt = timestamp;
    const age = startedAt == null ? 0 : timestamp - startedAt;
    const explicit = Math.abs(amount) >= 70 && (gap >= newGestureGapMs || age >= 400);
    if (isLocked() && timestamp >= getIgnoreUntil() && explicit) {
      queueDirection(amount > 0 ? 1 : -1, owner);
      consumed = true; startedAt = timestamp;
      clearVisual(); release(); return true;
    }
    if (consumed && !isLocked() && timestamp >= getIgnoreUntil() && explicit) {
      consumed = false; delta = 0;
    }
    if (isLocked() || consumed || timestamp < getIgnoreUntil()) {
      consumed = true; clearVisual(); release(); return true;
    }
    if (gap > 260 || Math.sign(delta) !== Math.sign(amount)) delta = 0;
    visualOwner = owner;
    delta = Math.max(-180, Math.min(180, delta + amount));
    const visual = delta * -0.55;
    onDrag(owner, visual);
    schedule(() => {
      if (visualOwner !== owner) return;
      visualOwner = null; delta = 0;
      settleVisual(owner);
    }, 160);
    if (Math.abs(delta) < distance) return true;
    const direction = delta > 0 ? 1 : -1;
    const motion = { dragDistance: Math.abs(visual), velocity: Math.min(1.4, Math.abs(amount) / 80) };
    delta = 0; consumed = true; startedAt = timestamp;
    onFlushDrag(owner);
    release();
    const navigationLifecycle = lifecycle;
    try {
      Promise.resolve(onNavigate(direction, motion, owner)).catch((error) => {
        if (!disposed && lifecycle === navigationLifecycle) onError(error);
      }).finally(() => { if (!disposed && lifecycle === navigationLifecycle) release(); });
    } catch (error) {
      if (!disposed && lifecycle === navigationLifecycle) { release(); onError(error); }
    }
    return true;
  };
  return { handle, release, cancelVisual, cancel, dispose() { if (!disposed) { cancel(); disposed = true; clearPending(); } } };
}
