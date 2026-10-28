export function createSettingsDialogFocus({ overlay, panel, closeButton, confirmationOverlay, getOwner, isOwnerCurrent, isBlocked = () => false }) {
  let session = null;
  let generation = 0;

  function available(target) {
    if (!target?.isConnected || target.disabled || target.matches?.(":disabled") || !target.getClientRects().length) return false;
    if (["hidden", "collapse"].includes(window.getComputedStyle(target).visibility)) return false;
    for (let node = target; node; node = node.parentElement) {
      if (node.hidden || node.inert) return false;
      if (node.tagName === "DETAILS" && !node.open) {
        const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(target)) return false;
      }
    }
    return true;
  }

  function owns(candidate) {
    return Boolean(candidate) && candidate.generation === generation && isOwnerCurrent(candidate.owner);
  }

  function isMounted(candidate) {
    return candidate === session && owns(candidate) && !overlay.hidden && overlay.isConnected && panel.isConnected
      && overlay.contains(panel);
  }

  function hide() {
    const previous = session;
    session = null;
    if (!previous) return null;
    window.cancelAnimationFrame(previous.frame);
    previous.frame = 0;
    for (const state of previous.background) {
      if (state.element.isConnected) state.element.inert = state.inert;
    }
    return previous;
  }

  function open({ trigger = document.activeElement, focusTarget = () => closeButton } = {}) {
    hide();
    const current = { trigger, owner: getOwner(), generation: ++generation, frame: 0, background: [] };
    session = current;
    current.background = [...(overlay.parentElement?.children || [])]
      .filter((element) => element !== overlay && element !== confirmationOverlay)
      .map((element) => {
        const state = { element, inert: Boolean(element.inert) };
        element.inert = true;
        return state;
      });
    current.frame = window.requestAnimationFrame(() => {
      current.frame = 0;
      if (!isMounted(current) || isBlocked() || (confirmationOverlay && !confirmationOverlay.hidden)) return;
      const focused = document.activeElement;
      if (focused && focused !== document.body && focused !== trigger) return;
      const target = focusTarget() || closeButton;
      if (available(target)) target.focus({ preventScroll: true });
    });
    return current;
  }

  function restore(previous) {
    if (session || !owns(previous) || isBlocked() || (confirmationOverlay && !confirmationOverlay.hidden)
      || previous.trigger === document.body || !available(previous.trigger)) return false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== previous.trigger && !overlay.contains(active) && available(active)) return false;
    previous.trigger.focus({ preventScroll: true });
    return true;
  }

  function trap(event) {
    if (event.defaultPrevented || event.key !== "Tab" || !session || overlay.hidden || isBlocked()
      || (confirmationOverlay && !confirmationOverlay.hidden)) return;
    const controls = [...panel.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")]
      .filter((element) => element.tabIndex >= 0 && available(element));
    const first = controls[0];
    const last = controls.at(-1);
    const active = document.activeElement;
    if (!first) {
      event.preventDefault();
      panel.setAttribute("tabindex", "-1");
      panel.focus();
    } else if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || active === panel || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  return { open, hide, restore, owns, isMounted, available, trap, current: () => session };
}
