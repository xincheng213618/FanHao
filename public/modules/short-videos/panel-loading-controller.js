// Module downloads may be shared; the user's request to open a panel is not.
export function createShortVideoPanelLoadingController({
  captureContext = () => null,
  isCurrentContext = () => true,
  showError = () => {}
} = {}) {
  let active = null;
  const busyOwners = new WeakMap();
  const finishBusy = (owner) => {
    const trigger = owner.trigger;
    if (!trigger || busyOwners.get(trigger) !== owner) return;
    busyOwners.delete(trigger);
    if (trigger.getAttribute?.("aria-busy") !== "true") return;
    if (owner.previousBusy == null) trigger.removeAttribute?.("aria-busy");
    else trigger.setAttribute?.("aria-busy", owner.previousBusy);
  };
  const isCurrent = (owner) => Boolean(active === owner && owner.phase !== "cancelled"
    && (!owner.trigger || owner.trigger.isConnected !== false) && isCurrentContext(owner.context));
  const cancel = () => {
    // A panel synchronously closes the previous one and isolates itself while
    // mounting. Those lifecycle hooks must not dismiss their own request.
    if (!active || active.phase === "mounting") return false;
    const owner = active;
    active = null;
    owner.phase = "cancelled";
    finishBusy(owner);
    return true;
  };
  const open = ({ load, show, trigger = null, errorMessage = "面板加载失败" }) => {
    cancel();
    const owner = { context: captureContext(), trigger, phase: "pending", previousBusy: trigger?.getAttribute?.("aria-busy") };
    active = owner;
    if (trigger) {
      busyOwners.set(trigger, owner);
      trigger.setAttribute?.("aria-busy", "true");
    }
    return Promise.resolve().then(() => {
      if (!isCurrent(owner)) return null;
      return load();
    }).then((value) => {
      if (!isCurrent(owner)) return false;
      owner.phase = "mounting";
      try {
        return show(value, { isCurrent: () => isCurrent(owner) });
      } finally {
        owner.phase = "mounted";
        finishBusy(owner);
      }
    }).catch((error) => {
      if (isCurrent(owner)) showError(error, errorMessage);
      return false;
    }).finally(() => {
      finishBusy(owner);
      if (active === owner && owner.phase === "pending") active = null;
    });
  };
  return { open, cancel, isPending: () => active?.phase === "pending" };
}
