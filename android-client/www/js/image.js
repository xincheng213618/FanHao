import { readCachedImage, writeCachedImage } from "./cache.js?v=20260702-novel-local-manage-74";

const IMAGE_PREPARE_RETRY_DELAYS_MS = Object.freeze([700, 900, 1200, 1600, 2200, 3000]);

export function absoluteUrl(baseUrl, path) {
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function imageUrlForPerson(person) {
  return person?.avatarUrl || person?.actorProfile?.avatarUrl || (person?.coverId ? `/media/image/${encodeURIComponent(person.coverId)}` : "");
}

export function imageUrlForWork(work) {
  return work?.coverId ? `/media/image/${encodeURIComponent(work.coverId)}` : work?.cachedCover?.coverUrl || work?.remoteCoverUrl || "";
}

export async function loadPreviewImage(target, imageUrl, options = {}) {
  let currentNode = target;
  let renderedCache = false;
  let renderSequence = 0;
  const cacheReadTimeoutMs = Math.max(0, Number(options.cacheReadTimeoutMs ?? 140));

  const renderBlob = (blob, source = "network") => {
    if (!blob || !currentNode?.isConnected) return;

    renderSequence += 1;
    const sequence = renderSequence;
    const objectUrl = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = objectUrl;
    img.dataset.objectUrl = objectUrl;
    img.dataset.imageSource = source;
    img.addEventListener("load", () => {
      if (sequence !== renderSequence) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
      options.decorate?.(img);
      const previousObjectUrl = currentNode.dataset?.objectUrl || "";
      currentNode.replaceWith(img);
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
      currentNode = img;
    });
    img.addEventListener("error", () => {
      URL.revokeObjectURL(objectUrl);
    });
  };

  const renderDirect = () => {
    if (!imageUrl || !currentNode?.isConnected) return;

    renderSequence += 1;
    const sequence = renderSequence;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.src = imageUrl;
    img.dataset.imageSource = "direct";
    img.addEventListener("load", () => {
      if (sequence !== renderSequence) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
      }
      options.decorate?.(img);
      const previousObjectUrl = currentNode.dataset?.objectUrl || "";
      currentNode.replaceWith(img);
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
      currentNode = img;
    });
  };

  try {
    const cacheRead = readCachedImage(imageUrl, { baseUrl: options.cacheBaseUrl }).catch(() => null);
    const cached = cacheReadTimeoutMs > 0
      ? await Promise.race([cacheRead, delay(cacheReadTimeoutMs, null)])
      : await cacheRead;
    if (cached?.blob) {
      renderedCache = true;
      renderBlob(cached.blob, "cache");
      if (options.refresh !== true) return;
    }

    const response = await fetchPreparedImage(imageUrl, { mode: "cors" });
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    writeCachedImage(imageUrl, blob, { baseUrl: options.cacheBaseUrl }).catch(() => {});
    renderBlob(blob);
  } catch {
    // Keep the text fallback, or the cached image if one already rendered.
    if (renderedCache) return;
    if (/^https?:\/\//i.test(imageUrl)) renderDirect();
  }
}

function delay(ms, value = null) {
  return new Promise((resolve) => {
    window.setTimeout(() => resolve(value), ms);
  });
}

export async function fetchPreparedImage(imageUrl, fetchOptions = {}, options = {}) {
  const retryDelaysMs = Array.isArray(options.retryDelaysMs)
    ? options.retryDelaysMs
    : IMAGE_PREPARE_RETRY_DELAYS_MS;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(imageUrl, fetchOptions);
    if (!isPendingPreparedImage(response) || attempt >= retryDelaysMs.length) return response;

    await response.body?.cancel().catch(() => {});
    const retryAfterMs = preparedImageRetryAfterMs(response);
    const delayMs = Math.max(retryAfterMs, Math.max(0, Number(retryDelaysMs[attempt]) || 0));
    await waitForPreparedImage(delayMs, fetchOptions.signal);
  }
}

function isPendingPreparedImage(response) {
  return response?.status === 503
    && String(response.headers?.get("X-FanHao-Image-Prepare") || "").toLowerCase() === "pending";
}

function preparedImageRetryAfterMs(response) {
  const seconds = Number(response.headers?.get("Retry-After") || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(5000, Math.max(100, Math.round(seconds * 1000)));
}

function waitForPreparedImage(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());

  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, ms);
    signal?.addEventListener("abort", aborted, { once: true });

    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted() {
      globalThis.clearTimeout(timer);
      reject(abortError());
    }
  });
}

function abortError() {
  const error = new Error("Image preparation aborted");
  error.name = "AbortError";
  return error;
}

export async function precacheImage(imageUrl, options = {}) {
  if (!imageUrl) return null;

  const cached = await readCachedImage(imageUrl, { baseUrl: options.cacheBaseUrl }).catch(() => null);
  if (cached?.blob) return cached;

  const controller = new AbortController();
  const timeout = Number(options.timeoutMs || 0);
  const timer = timeout > 0 ? window.setTimeout(() => controller.abort(), timeout) : null;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetchPreparedImage(imageUrl, { mode: "cors", signal: controller.signal });
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    return await writeCachedImage(imageUrl, blob, { baseUrl: options.cacheBaseUrl });
  } catch {
    return null;
  } finally {
    if (timer) window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

export function createFallbackCover(name) {
  const fallback = document.createElement("div");
  fallback.className = "person-cover";
  fallback.textContent = String(name || "?").slice(0, 2);
  return fallback;
}







