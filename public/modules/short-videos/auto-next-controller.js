// Own one ended request until navigation is known. No polling timer is needed:
// detail completion and explicit navigation updates both flush the same request.
export function createShortVideoAutoNextController({ capture, owns, getNavigation, loadNavigation,
  advance, boundary, waiting = () => {}, failed = () => {}, onStateChange = () => {} }) {
  let pending = null, completed = null, submitting = false, disposed = false;
  const notify = () => onStateChange({
    waiting: pending?.phase === "waiting", error: completed?.phase === "failed",
    owner: pending?.owner || completed?.owner || null
  });
  const current = (entry) => !disposed && pending === entry && owns(entry.owner);
  function cancel() {
    const changed = Boolean(pending || (!submitting && completed));
    pending = null;
    // A synchronous navigation/boundary callback can itself cancel playback
    // work. Retain this completion during that call to deduplicate repeated
    // ended delivery; a later explicit user action clears it normally.
    if (!submitting) completed = null;
    if (changed) notify();
  }
  const fail = (entry, error) => {
    if (!current(entry)) { if (pending === entry) cancel(); return; }
    pending = null;
    entry.phase = "failed";
    completed = entry;
    failed(error, entry.owner);
    notify();
  };
  function drive(entry, settled = false) {
    if (!current(entry)) { if (pending === entry) cancel(); return; }
    let navigation;
    try { navigation = getNavigation(entry.owner); } catch (error) { fail(entry, error); return; }
    if (navigation?.nextId) {
      if (String(navigation.nextId) === String(entry.owner.id)) { fail(entry, new Error("相邻作品信息无效，请重试")); return; }
      pending = null;
      completed = entry;
      entry.phase = "advanced";
      notify();
      if (completed !== entry || !owns(entry.owner)) return;
      submitting = true;
      try {
        Promise.resolve(advance(entry.owner, navigation.nextId)).catch((error) => {
          if (completed === entry && owns(entry.owner)) {
            entry.phase = "failed"; failed(error, entry.owner); notify();
          }
        });
      } catch (error) {
        if (completed === entry && owns(entry.owner)) { entry.phase = "failed"; failed(error, entry.owner); notify(); }
      } finally { submitting = false; }
      return;
    }
    if (navigation?.known) {
      pending = null;
      completed = entry;
      entry.phase = "boundary";
      submitting = true;
      try { boundary(entry.owner); } finally { submitting = false; }
      notify();
      return;
    }
    if (navigation?.error || settled) { fail(entry, new Error("相邻作品读取失败，请再次切换重试")); return; }
    if (entry.phase !== "waiting") {
      entry.phase = "waiting";
      waiting(entry.owner);
      if (!current(entry)) return;
      notify();
      if (!current(entry)) return;
    }
    if (entry.loading) return;
    entry.loading = true;
    let request;
    try { request = loadNavigation(entry.owner); } catch (error) { fail(entry, error); return; }
    Promise.resolve(request).then(() => {
      if (!current(entry)) { if (pending === entry) cancel(); return; }
      entry.loading = false;
      drive(entry, true);
    }, (error) => fail(entry, error));
  }
  function ended(kind, target) {
    if (disposed) return false;
    const owner = capture(kind, target);
    if (!owner) return false;
    if ((pending && pending.owner.kind === kind && pending.owner.target === target && owns(pending.owner))
      || (completed && completed.owner.kind === kind && completed.owner.target === target && owns(completed.owner))) return true;
    cancel();
    pending = { owner, phase: "new", loading: false };
    drive(pending);
    return true;
  }
  function flush() {
    if (pending) drive(pending);
    else if (completed && !owns(completed.owner)) { completed = null; notify(); }
  }
  return Object.freeze({ ended, flush, cancel, isPending: () => Boolean(pending?.phase === "waiting"),
    dispose() { disposed = true; cancel(); } });
}
