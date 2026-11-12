import { normalizePhotoSourceUrl } from "./photo-catalog-source.js";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

export function photoCatalogError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function publicPhotoSourceUrl(value, base) {
  let url;
  try {
    url = new URL(value, base);
  } catch {
    throw photoCatalogError("请输入有效的 5280k 公开目录地址");
  }
  url.hash = "";
  if (url.hostname === "5280k.com") url.hostname = "www.5280k.com";
  if (!normalizePhotoSourceUrl(url.href)) {
    throw photoCatalogError("只支持 5280k 的 HTTPS 公开分类或帖子地址");
  }
  return url;
}

export async function fetchPublicPhotoSource(value, { fetchImpl = fetch, signal: requestSignal } = {}) {
  let url = publicPhotoSourceUrl(value);
  const timeout = AbortSignal.timeout(12_000);
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout;
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      signal.throwIfAborted();
      const response = await fetchImpl(url, { redirect: "manual", signal, headers: { Accept: "text/html" } });
      if (signal.aborted) {
        await response.body?.cancel(signal.reason).catch(() => {});
        signal.throwIfAborted();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location && redirects < 2) {
          url = publicPhotoSourceUrl(location, url);
          continue;
        }
        break;
      }
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/html") || !response.body) {
        await response.body?.cancel();
        throw photoCatalogError(`公开来源未返回可读取的目录（HTTP ${response.status}）`, 502);
      }
      const html = await readSourceHtml(response.body, signal);
      signal.throwIfAborted();
      return { url: url.href, html };
    }
  } catch (error) {
    requestSignal?.throwIfAborted();
    if (error?.statusCode) throw error;
    throw photoCatalogError("公开来源暂时无法访问，请稍后重试", 502);
  }
  throw photoCatalogError("公开来源重定向次数过多", 502);
}

async function readSourceHtml(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  let cancellation;
  const cancel = () => cancellation ||= reader.cancel(signal.aborted ? signal.reason : undefined).catch(() => {});
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value: chunk, done } = await reader.read();
      signal.throwIfAborted();
      if (done) return html + decoder.decode();
      bytes += chunk.byteLength;
      if (bytes > MAX_HTML_BYTES) throw photoCatalogError("公开目录页面超过读取上限", 502);
      html += decoder.decode(chunk, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await cancel();
    reader.releaseLock();
  }
}
