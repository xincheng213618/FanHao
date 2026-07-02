import { readCachedImage, writeCachedImage } from "./cache.js?v=20260702-novel-local-manage-74";

export function absoluteUrl(baseUrl, path) {
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function imageUrlForPerson(person) {
  return person?.actorProfile?.avatarUrl || (person?.coverId ? `/media/image/${encodeURIComponent(person.coverId)}` : "");
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

    const response = await fetch(imageUrl, { mode: "cors" });
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
    const response = await fetch(imageUrl, { mode: "cors", signal: controller.signal });
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







