export async function fetchMusicAudioSource(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const createObjectURL = options.createObjectURL || ((blob) => URL.createObjectURL(blob));
  if (typeof fetchImpl !== "function") throw new Error("当前环境无法读取音频");

  const response = await fetchImpl(url, {
    cache: "no-store",
    signal: options.signal
  });
  if (!response?.ok) {
    const status = Number(response?.status || 0);
    throw new Error(status ? `音频加载失败（${status}）` : "音频加载失败");
  }

  const blob = await response.blob();
  if (options.signal?.aborted) throw abortError();
  if (!blob || !Number.isFinite(blob.size) || blob.size <= 0) throw new Error("音频文件为空");
  return {
    objectUrl: createObjectURL(blob),
    size: blob.size,
    type: String(blob.type || "")
  };
}

export function releaseMusicAudioSource(source, options = {}) {
  const objectUrl = String(source?.objectUrl || source || "").trim();
  if (!objectUrl) return;
  const revokeObjectURL = options.revokeObjectURL || ((url) => URL.revokeObjectURL(url));
  revokeObjectURL(objectUrl);
}

export function createMusicAudioSourceStore(options = {}) {
  const sources = new WeakMap();
  const requests = new Map();
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const revokeObjectURL = options.revokeObjectURL;

  function cancel(slot) {
    requests.get(slot)?.controller.abort();
    requests.delete(slot);
  }

  async function load(slot, target, url, loadOptions = {}) {
    cancel(slot);
    const record = { controller: new AbortController() };
    requests.set(slot, record);
    if (loadOptions.clearBefore) release(target);
    try {
      const source = await fetchMusicAudioSource(url, { signal: record.controller.signal, fetchImpl });
      if (requests.get(slot) !== record || record.controller.signal.aborted || loadOptions.guard?.() === false) {
        releaseMusicAudioSource(source, { revokeObjectURL });
        return false;
      }
      const previous = sources.get(target);
      target.src = source.objectUrl;
      sources.set(target, source.objectUrl);
      target.load();
      if (previous && previous !== source.objectUrl) releaseMusicAudioSource(previous, { revokeObjectURL });
      return true;
    } catch (error) {
      if (requests.get(slot) !== record || record.controller.signal.aborted || error?.name === "AbortError") return false;
      throw error;
    } finally {
      if (requests.get(slot) === record) requests.delete(slot);
    }
  }

  function release(target) {
    if (!target) return;
    const source = sources.get(target);
    sources.delete(target);
    try {
      target.pause();
      target.removeAttribute("src");
      target.load();
    } catch {}
    if (source) releaseMusicAudioSource(source, { revokeObjectURL });
  }

  return { cancel, load, release };
}

function abortError() {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
