// The panel owns its preview until the tab is replaced or the panel closes.
// A pending play request must not outlive that owner or a newer user action.
export function createShortVideoSoundPreviewController({
  audio,
  preview,
  cover,
  idleLabel = "试听原声",
  isCurrent = () => audio.isConnected,
  acquirePlayback = () => null,
  showError = () => {}
}) {
  let disposed = false;
  let wantsPlay = false;
  let pending = false;
  let failed = false;
  let generation = 0;
  let releasePlayback = null;

  const ownsPreview = () => !disposed && isCurrent();
  const release = (options) => {
    const callback = releasePlayback;
    releasePlayback = null;
    callback?.(options);
  };
  const sync = () => {
    if (disposed) return;
    const playing = wantsPlay && !audio.paused && !audio.ended;
    preview.textContent = failed ? "原声暂不可播放" : pending ? "取消试听" : playing ? "暂停原声" : idleLabel;
    preview.disabled = failed;
    preview.setAttribute("aria-pressed", String(wantsPlay));
    preview.setAttribute("aria-busy", String(pending));
    cover.classList.toggle("is-playing", playing);
  };
  const stop = (options = {}) => {
    generation += 1;
    wantsPlay = false;
    pending = false;
    audio.pause();
    release({ restorePlayback: options.restorePlayback !== false });
    sync();
  };
  const toggle = async () => {
    if (!ownsPreview() || failed) return;
    if (wantsPlay) {
      stop();
      return;
    }
    const attempt = ++generation;
    wantsPlay = true;
    pending = true;
    sync();
    try {
      releasePlayback = acquirePlayback();
      if (!ownsPreview() || attempt !== generation || !wantsPlay) {
        stop();
        return;
      }
      await audio.play();
      if (!ownsPreview() || attempt !== generation || !wantsPlay) return;
      pending = false;
      sync();
    } catch (error) {
      if (!ownsPreview() || attempt !== generation || !wantsPlay) return;
      stop();
      if (error?.name !== "AbortError") showError(error);
    }
  };
  const handlePlay = () => {
    if (!ownsPreview() || !wantsPlay) {
      audio.pause();
      return;
    }
    sync();
  };
  const handlePause = () => {
    // pause events can be delivered after a new play() has already started.
    if (!audio.paused && !audio.ended) return;
    if (wantsPlay) stop();
    else sync();
  };
  const handleError = () => {
    if (!ownsPreview()) return;
    failed = true;
    stop();
  };
  const listeners = [
    [preview, "click", toggle],
    [audio, "play", handlePlay],
    [audio, "pause", handlePause],
    [audio, "ended", handlePause],
    [audio, "error", handleError]
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  const dispose = (options = {}) => {
    if (disposed) return;
    disposed = true;
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    stop(options);
    cover.classList.remove("is-playing");
    audio.removeAttribute("src");
    audio.load();
  };
  audio.shortVideoStopSoundPreview = stop;
  audio.shortVideoDisposeSoundPreview = dispose;
  sync();
  return { toggle, stop, dispose };
}

export function disposeShortVideoSoundPreviews(root, options = {}) {
  root?.querySelectorAll?.(".short-video-sound-audio")?.forEach?.((audio) => {
    if (typeof audio.shortVideoDisposeSoundPreview === "function") {
      audio.shortVideoDisposeSoundPreview(options);
      return;
    }
    audio.pause?.();
    audio.removeAttribute?.("src");
    audio.load?.();
  });
}
