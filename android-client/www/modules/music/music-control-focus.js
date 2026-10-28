import { captureAccountOwner, isAccountOwnerCurrent } from "../../js/account-owner.js";

export function createMusicControlFocus({ getActiveUrl, getStateKey, isActive, resolveTarget }) {
  let activeIntent = null;

  function cancel(intent = activeIntent) {
    if (!intent) return;
    if (activeIntent === intent) activeIntent = null;
    intent.cancelled = true;
    if (intent.frame) intent.window.cancelAnimationFrame?.(intent.frame);
    intent.frame = 0;
    for (const remove of intent.listeners.splice(0)) remove();
  }

  function begin(origin, targetKind) {
    if (!isActive() || !origin?.isConnected || origin.disabled || !document.body.contains(origin)) return null;
    cancel();
    const sourceUrl = getActiveUrl();
    const intent = {
      origin, targetKind, sourceUrl,
      accountOwner: captureAccountOwner(sourceUrl),
      document, window, listeners: [], frame: 0,
      cancelled: false, finishing: false, requestCurrent: null, stateKey: null
    };
    activeIntent = intent;
    const listen = (target, type, shouldRetire = () => true) => {
      const retire = () => {
        if (shouldRetire()) cancel(intent);
      };
      target.addEventListener?.(type, retire, true);
      intent.listeners.push(() => target.removeEventListener?.(type, retire, true));
    };
    for (const type of ["pointerdown", "keydown", "input", "compositionstart", "focusin", "wheel"]) listen(document, type);
    listen(window, "pagehide");
    for (const type of ["fanhaoAccountOwnerChanged", "fanhaoAccountOwnerConfirmed"]) {
      listen(window, type, () => !isAccountOwnerCurrent(intent.accountOwner));
    }
    return intent;
  }

  function retain(intent) {
    if (activeIntent !== intent) cancel();
  }

  function bind(intent, requestCurrent) {
    if (!intent || activeIntent !== intent || intent.cancelled) return;
    intent.stateKey = getStateKey();
    intent.requestCurrent = requestCurrent;
  }

  function isCurrent(intent) {
    return Boolean(intent) && activeIntent === intent && !intent.cancelled && isActive()
      && intent.document === document && intent.window === window
      && getActiveUrl() === intent.sourceUrl && isAccountOwnerCurrent(intent.accountOwner)
      && intent.stateKey === getStateKey() && Boolean(intent.requestCurrent?.());
  }

  function available(target) {
    if (!target?.isConnected || target.disabled) return false;
    for (let node = target; node; node = node.parentElement || node.parentNode) {
      if (node.hidden || node.inert) return false;
    }
    return true;
  }

  function finish(intent) {
    if (!isCurrent(intent)) {
      cancel(intent);
      return;
    }
    if (intent.finishing) return;
    const target = resolveTarget(intent.targetKind);
    if (!available(target)) {
      cancel(intent);
      return;
    }
    intent.finishing = true;
    intent.frame = window.requestAnimationFrame(() => {
      intent.frame = 0;
      const focused = document.activeElement;
      if (!isCurrent(intent) || !available(target) || resolveTarget(intent.targetKind) !== target
        || (focused && focused !== document.body && focused !== intent.origin && focused !== target)) {
        cancel(intent);
        return;
      }
      cancel(intent);
      target.focus({ preventScroll: true });
    });
  }

  return { begin, bind, cancel, finish, retain, current: () => activeIntent };
}
