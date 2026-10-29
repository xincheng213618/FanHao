export function createShortVideoSeekController({
  progress, progressWrap, time, seekPreview, getPlayer, formatSeconds, onChange = () => {},
  requestFrame = (callback) => window.requestAnimationFrame(callback),
  cancelFrame = (handle) => window.cancelAnimationFrame(handle)
}) {
  let session = null, hoverState = null, frame = 0, frameToken = 0, disposed = false, disposing = false;
  const listeners = [];
  const durationOf = (player) => {
    const value = Number(player?.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const identityOf = (player) => player && ({
    player, id: String(player.dataset?.videoId || ""),
    source: String(player.getAttribute?.("src") || player.currentSrc || ""),
    generation: String(player.dataset?.shortVideoSourceGeneration || "0"),
    slot: String(player.dataset?.shortVideoSlot || ""),
    promotion: String(player.dataset?.shortVideoPromotedAt || ""),
    warm: String(player.dataset?.shortVideoWarmScheduleToken || ""),
    intent: String(player.dataset?.shortVideoPlaybackIntentGeneration || "0")
  });
  const owns = (owner) => {
    const player = getPlayer();
    if (disposed || !owner || player !== owner.player || !player?.isConnected
      || !progress.isConnected || player.classList?.contains("is-ghost")) return false;
    const current = identityOf(player);
    return ["id", "source", "generation", "slot", "promotion", "warm", "intent"]
      .every((key) => current[key] === owner[key]);
  };
  const clamp = (value, max) => Math.max(0, Math.min(max, value));
  const currentTimeOf = (player) => Number.isFinite(Number(player?.currentTime)) ? Number(player.currentTime) : 0;
  const write = (element, property, value) => { if (element[property] !== value) element[property] = value; };
  const style = (element, property, value) => {
    const previous = element.style.getPropertyValue?.(property) ?? element.style[property];
    if (previous !== value) element.style.setProperty(property, value);
  };
  const measure = () => {
    const rect = progress.getBoundingClientRect();
    return { left: Number(rect.left), width: Number(rect.width) };
  };
  const targetAt = (x, player, geometry, sampledDuration = durationOf(player)) => {
    const duration = sampledDuration;
    if (!duration || !Number.isFinite(x) || !Number.isFinite(geometry?.left)
      || !Number.isFinite(geometry.width) || geometry.width <= 0) return null;
    return clamp((x - geometry.left) / geometry.width, 1) * duration;
  };
  const preview = (target, ratio, geometry) => {
    const safeRatio = clamp(Number.isFinite(ratio) ? ratio : 0, 1);
    const measuredWidth = Number(geometry?.width || 0);
    const width = Number.isFinite(measuredWidth) ? Math.max(0, measuredWidth) : 0;
    const half = Math.min(30, Math.max(0, width) / 2);
    write(seekPreview, "textContent", formatSeconds(Math.max(0, target)));
    write(seekPreview.style, "left", width > 0 ? `${clamp(safeRatio * width - half, width - half * 2) + half}px` : "0px");
  };
  const render = (target, duration) => {
    const safeTarget = duration ? clamp(target, duration) : 0;
    const ratio = duration ? safeTarget / duration : 0;
    const text = `${formatSeconds(safeTarget)} / ${formatSeconds(duration)}`;
    write(progress, "value", String(Math.round(ratio * 1000)));
    style(progress, "--short-video-progress", `${ratio * 100}%`);
    if (progress.getAttribute("aria-valuetext") !== text) progress.setAttribute("aria-valuetext", text);
    write(time, "textContent", text);
    if (session) preview(safeTarget, ratio, session.geometry);
    else if (hoverState && owns(hoverState.owner)) preview(hoverState.ratio * duration, hoverState.ratio, hoverState.geometry);
    else write(seekPreview, "textContent", formatSeconds(safeTarget));
  };
  const clearFrame = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
    frameToken += 1;
  };
  const seek = (owner, target, exact) => {
    const duration = durationOf(owner?.player);
    if (!owns(owner) || !duration || !Number.isFinite(target)) return;
    const value = clamp(target, duration);
    try {
      if (!exact && typeof owner.player.fastSeek === "function") owner.player.fastSeek(value);
      else owner.player.currentTime = value;
    } catch {
      try { if (owns(owner)) owner.player.currentTime = value; } catch {}
    }
  };
  const pointerX = (event) => event?.clientX == null ? NaN : Number(event.clientX);
  const consumePointer = (owner, geometry) => {
    const player = owner.player || owner.owner.player;
    const target = targetAt(owner.latestX, player, geometry, owner.sampleDuration ?? durationOf(player));
    owner.geometry = geometry;
    if (target == null) return;
    if (owner === session) owner.target = clamp(target, durationOf(player));
    else owner.ratio = target / durationOf(player);
  };
  const scheduleFrame = () => {
    if (frame) return;
    const owner = session || hoverState, token = ++frameToken;
    if (!owner) return;
    frame = requestFrame(() => {
      if (token !== frameToken || disposed || disposing) return;
      frame = 0;
      if (session === owner) {
        if (!owns(owner)) { finish({ commit: false, restore: false, notify: false }); return; }
        // Each frame measures once before any visual writes; pointer events
        // share its geometry instead of forcing layout on every sample.
        consumePointer(owner, measure());
        render(owner.target, durationOf(owner.player));
        seek(owner, owner.target, false);
      } else if (!session && hoverState === owner) {
        if (!owns(owner.owner)) { hoverState = null; progressWrap.classList.remove("is-hovering"); return; }
        consumePointer(owner, measure());
        preview(owner.ratio * durationOf(owner.owner.player), owner.ratio, owner.geometry);
      }
    });
  };
  const finish = ({ commit = true, restore = true, notify = true, renderAfter = true, geometry = null } = {}) => {
    const owner = session;
    if (!owner) return;
    const owned = owns(owner);
    if (commit && owned) consumePointer(owner, geometry || measure());
    clearFrame();
    session = null;
    if (commit && owned) seek(owner, owner.target, true);
    progressWrap.classList.remove("is-scrubbing");
    // Releasing capture may synchronously emit lostpointercapture. Clear the
    // session first, so the same drag cannot seek or resume twice.
    try { if (progress.hasPointerCapture?.(owner.pointerId)) progress.releasePointerCapture?.(owner.pointerId); } catch {}
    if (restore && owned && owns(owner) && owner.wasPlaying) {
      owner.player.shortVideoSetPlaybackIntent?.(true);
      owner.player.play?.().catch(() => {});
    }
    if (renderAfter) sync();
    if (notify && owned) onChange();
  };
  function sync(player = getPlayer()) {
    if (disposed) return;
    if (session && !owns(session)) finish({ commit: false, restore: false, notify: false, renderAfter: false });
    if (hoverState && !owns(hoverState.owner)) {
      hoverState = null;
      progressWrap.classList.remove("is-hovering");
      if (!session) clearFrame();
    }
    const duration = durationOf(player);
    write(progress, "disabled", !duration);
    if (session) render(session.target, durationOf(session.player));
    else render(currentTimeOf(player), duration);
  }
  const listen = (name, listener, target = progress) => {
    if (typeof target?.addEventListener !== "function") return;
    target.addEventListener(name, listener); listeners.push([target, name, listener]);
  };
  const hover = (event, immediate = false) => {
    if (disposed || disposing || session) return;
    const player = getPlayer();
    if (!player?.isConnected || player.classList?.contains("is-ghost")) return;
    const owner = hoverState && owns(hoverState.owner) ? hoverState : null;
    const geometry = immediate || !owner ? measure() : owner.geometry;
    const x = pointerX(event), target = targetAt(x, player, geometry);
    if (target == null) return;
    if (!owner) clearFrame();
    hoverState = owner || { owner: identityOf(player) };
    Object.assign(hoverState, { ratio: target / durationOf(player), latestX: x, geometry });
    if (!progressWrap.classList.contains("is-hovering")) progressWrap.classList.add("is-hovering");
    if (immediate) preview(target, hoverState.ratio, geometry);
    else scheduleFrame();
  };
  listen("pointerenter", (event) => hover(event, true));
  listen("pointermove", (event) => {
    if (!session) { hover(event); return; }
    if (event.pointerId !== session.pointerId) return;
    if (!owns(session)) { finish({ commit: false, restore: false, notify: false }); return; }
    const x = pointerX(event), target = targetAt(x, session.player, session.geometry);
    if (target != null) { session.latestX = x; session.target = target; session.sampleDuration = durationOf(session.player); scheduleFrame(); }
    event.preventDefault();
  });
  listen("pointerleave", () => {
    hoverState = null; progressWrap.classList.remove("is-hovering");
    if (!session) { clearFrame(); sync(); }
  });
  listen("pointerdown", (event) => {
    if (session) { event.preventDefault(); return; }
    if (disposed || disposing || event.isPrimary === false || (event.button != null && event.button !== 0) || !Number.isFinite(event.pointerId)) return;
    const player = getPlayer(), geometry = measure(), x = pointerX(event), target = targetAt(x, player, geometry);
    if (!player?.isConnected || target == null || player.classList?.contains("is-ghost")) return;
    event.preventDefault();
    const wasPlaying = !player.paused && !player.ended;
    player.shortVideoSetPlaybackIntent?.(false);
    clearFrame(); hoverState = null;
    session = { ...identityOf(player), pointerId: event.pointerId, wasPlaying, target, latestX: x, geometry, sampleDuration: durationOf(player) };
    player.pause?.();
    progressWrap.classList.add("is-scrubbing");
    progress.focus?.({ preventScroll: true });
    try { progress.setPointerCapture?.(event.pointerId); } catch { finish({ commit: false }); return; }
    render(target, durationOf(player));
    scheduleFrame();
    onChange();
  });
  listen("pointerup", (event) => {
    if (!session || event.pointerId !== session.pointerId) return;
    const geometry = measure(), x = pointerX(event), target = targetAt(x, session.player, geometry);
    if (target != null) { session.latestX = x; session.target = target; session.sampleDuration = durationOf(session.player); }
    finish({ geometry });
    event.preventDefault();
  });
  for (const name of ["pointercancel", "lostpointercapture"]) listen(name, (event) => {
    if (session && event.pointerId === session.pointerId) finish();
  });
  listen("focus", () => sync());
  listen("input", () => {
    if (session || disposed || disposing) return;
    const player = getPlayer(), duration = durationOf(player), ratio = Number(progress.value) / 1000;
    if (!duration || !Number.isFinite(ratio)) { sync(); return; }
    seek(identityOf(player), clamp(ratio, 1) * duration, true);
    sync(); onChange();
  });
  listen("keydown", (event) => {
    if (disposed || disposing || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (session) finish();
    const player = getPlayer(), duration = durationOf(player), current = currentTimeOf(player);
    const step = event.shiftKey ? 1 : 5;
    const target = {
      ArrowLeft: current - step, ArrowDown: current - step,
      ArrowRight: current + step, ArrowUp: current + step,
      PageDown: current - duration / 10, PageUp: current + duration / 10,
      Home: 0, End: duration
    }[event.key];
    if (duration) seek(identityOf(player), target, true);
    sync(); onChange();
  });
  const layoutChanged = () => { if (!disposed && !disposing && (session || hoverState)) scheduleFrame(); };
  listen("resize", layoutChanged, globalThis.window);
  listen("fullscreenchange", layoutChanged, globalThis.document);
  const cancel = () => {
    if (disposed || disposing) return;
    finish({ commit: false, restore: false, notify: false, renderAfter: false });
    hoverState = null;
    clearFrame();
    progressWrap.classList.remove("is-hovering", "is-scrubbing");
    sync();
  };
  return {
    sync, cancel, isScrubbing: () => Boolean(session),
    dispose({ restorePlayback = false } = {}) {
      if (disposed || disposing) return;
      disposing = true;
      finish({ commit: restorePlayback, restore: restorePlayback, notify: false, renderAfter: false });
      disposed = true;
      hoverState = null;
      clearFrame();
      listeners.forEach(([target, name, listener]) => target.removeEventListener(name, listener));
      progressWrap.classList.remove("is-hovering", "is-scrubbing");
    }
  };
}
