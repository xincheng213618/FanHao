// Native PiP requests cannot be aborted. Keep their media owner until they
// settle, so a late window can be closed without touching a newer window.
export function createShortVideoPictureInPictureController({
  document,
  getPlayer,
  isCurrentPlayer = player => player === getPlayer(),
  onChange = () => {},
  onError = () => {}
}) {
  let current = null;
  let unsupported = false;
  const knownOwners = new WeakMap();
  const exits = new Map();
  const source = player => String(player?.getAttribute?.("src") || player?.currentSrc || player?.src || "");
  const mediaIdentity = player => JSON.stringify([
    source(player), player?.dataset?.shortVideoSourceGeneration || "0", player?.dataset?.videoId || "",
    player?.dataset?.shortVideoSlot || "", player?.dataset?.shortVideoPromotedAt || ""
  ]);
  const isUsablePlayer = player => Boolean(player && player.isConnected !== false && player === getPlayer()
    && isCurrentPlayer(player) && !player.classList?.contains?.("is-ghost"));
  const owns = owner => Boolean(owner && isUsablePlayer(owner.player) && mediaIdentity(owner.player) === owner.identity);
  const isSupported = () => Boolean(!unsupported && document.pictureInPictureEnabled && typeof getPlayer()?.requestPictureInPicture === "function");
  const isActive = () => Boolean(isUsablePlayer(getPlayer()) && document.pictureInPictureElement === getPlayer());
  const isClosing = () => exits.size > 0;
  const isPending = () => Boolean(current?.pending || isClosing());
  const notify = () => onChange();
  const stopStalePlayer = owner => {
    if (isUsablePlayer(owner.player)) return;
    owner.player.muted = true;
    owner.player.pause?.();
  };
  const exitVisibleOwner = (owner, reportError = false) => {
    if (document.pictureInPictureElement !== owner.player || typeof document.exitPictureInPicture !== "function") return Promise.resolve(false);
    const previous = exits.get(owner.player);
    if (previous) return previous;
    // exitPictureInPicture operates on the document's element when its native
    // algorithm runs, rather than retaining the element checked above.
    if (isClosing()) return exits.values().next().value;
    let finish;
    const completion = new Promise(resolve => { finish = resolve; });
    exits.set(owner.player, completion);
    const settled = (result, error) => {
      if (exits.get(owner.player) === completion) exits.delete(owner.player);
      if (error && reportError && current === owner && owns(owner) && error.name !== "AbortError") onError(error);
      finish(result);
      notify();
    };
    let nativeResult;
    notify();
    try {
      nativeResult = document.exitPictureInPicture();
    } catch (error) {
      settled(false, error);
      return completion;
    }
    Promise.resolve(nativeResult).then(() => settled(true), error => settled(false, error));
    return completion;
  };
  const cleanLateEntry = owner => {
    // A newer request for this same element can adopt the native window.
    if (current !== owner && current?.desired && current.player === owner.player && owns(current)) return Promise.resolve(false);
    stopStalePlayer(owner);
    return exitVisibleOwner(owner);
  };
  const cancel = expectedPlayer => {
    let owner = expectedPlayer
      ? (current?.player === expectedPlayer ? current : knownOwners.get(expectedPlayer))
      : current;
    if (!owner && expectedPlayer && document.pictureInPictureElement === expectedPlayer) {
      owner = { player: expectedPlayer, identity: mediaIdentity(expectedPlayer), desired: false, pending: false };
      knownOwners.set(expectedPlayer, owner);
    }
    if (!owner) return Promise.resolve(false);
    if (current === owner) current = null;
    owner.desired = false;
    owner.cancelled = true;
    const completion = cleanLateEntry(owner);
    notify();
    return completion;
  };
  const toggle = (expectedPlayer = getPlayer()) => {
    if (!isUsablePlayer(expectedPlayer)) return Promise.resolve(false);
    const exiting = document.pictureInPictureElement === expectedPlayer;
    if (!exiting && (unsupported || !document.pictureInPictureEnabled
      || typeof expectedPlayer.requestPictureInPicture !== "function")) return Promise.resolve(false);
    if (current && !owns(current)) void cancel();
    // A new entry during an outstanding document-wide exit could be closed by
    // that old exit. Do not queue a reopen outside this real user gesture.
    if (isClosing()) return Promise.resolve(false);
    if (current?.pending && current.player === expectedPlayer) {
      if (current.mode === "enter") current.desired = !current.desired;
      notify();
      return current.promise;
    }
    const owner = {
      player: expectedPlayer, identity: mediaIdentity(expectedPlayer), mode: exiting ? "exit" : "enter",
      desired: !exiting, pending: true, cancelled: false, promise: null
    };
    current = owner;
    knownOwners.set(expectedPlayer, owner);
    if (exiting) {
      owner.promise = exitVisibleOwner(owner, true).then(result => {
        owner.pending = false;
        if (current === owner && document.pictureInPictureElement !== owner.player) current = null;
        notify();
        return result;
      });
      notify();
      return owner.promise;
    }
    let nativeResult;
    try {
      // Keep this call in the original click stack to preserve activation.
      nativeResult = expectedPlayer.requestPictureInPicture();
    } catch (error) {
      owner.pending = false;
      const showError = current === owner && !owner.cancelled && owner.desired && owns(owner);
      if (showError && error?.name === "NotSupportedError") unsupported = true;
      if (current === owner) current = null;
      if (showError && error?.name !== "AbortError") onError(error);
      notify();
      return Promise.resolve(false);
    }
    owner.promise = Promise.resolve(nativeResult).then(async () => {
      owner.pending = false;
      if (current !== owner || owner.cancelled || !owner.desired || !owns(owner)) {
        await cleanLateEntry(owner);
        if (current === owner) current = null;
        notify();
        return false;
      }
      const active = document.pictureInPictureElement === owner.player;
      if (!active && current === owner) current = null;
      notify();
      return active;
    }, error => {
      owner.pending = false;
      const showError = current === owner && !owner.cancelled && owner.desired && owns(owner);
      if (showError && error?.name === "NotSupportedError") unsupported = true;
      if (current === owner) current = null;
      if (showError && error?.name !== "AbortError") onError(error);
      notify();
      return false;
    });
    notify();
    return owner.promise;
  };
  const changed = event => {
    if (event?.type === "leavepictureinpicture" && current?.player === event.target) {
      current.desired = false;
      if (!current.pending) current = null;
    }
    if (current && !owns(current)) void cancel();
    const visible = document.pictureInPictureElement;
    let owner = visible && knownOwners.get(visible);
    if (event?.type === "enterpictureinpicture" && event.target === visible && isUsablePlayer(visible)
      && (!owner || !owner.pending) && (current !== owner || !owner?.desired || owner?.cancelled)) {
      // Browser-native menus are also an explicit user entry intent. A late
      // event for a still-pending cancelled request must remain cancelled.
      owner = { player: visible, identity: mediaIdentity(visible), mode: "enter", desired: true,
        pending: false, cancelled: false, promise: Promise.resolve(true) };
      current = owner;
      knownOwners.set(visible, owner);
    }
    if (owner && (current !== owner || owner.cancelled || !owner.desired || !owns(owner))) void cleanLateEntry(owner);
    notify();
  };
  return { toggle, cancel, changed, isActive, isPending, isClosing, isSupported };
}
