import { putJson } from "../../../../js/api.js?v=20260706-mobile-web-sync-01";
import { readCachedJson, writeCachedJson } from "../../../../js/cache.js?v=20260705-mobile-actions-01";
import { createDetailSectionTitle } from "../../../../js/detail-ui.js";
import { formatNumber } from "../../../../js/format.js";
import { absoluteUrl } from "../../../../js/image.js";

export function createWorkPreviewMedia(deps) {
  const { detailErrorMessage, getActiveUrl, mediaViewer, renderMessage, renderWorkDetail } = deps;

  function render(work) {
    const info = work.infoMetadata || work.infoSummary || {};
    const activeUrl = getActiveUrl();
    const images = uniqueItems([
      ...localItems(work).map((item) => ({ ...item, url: absoluteUrl(activeUrl, item.url) })),
      ...remoteItems(info.previewImages || [])
    ]).slice(0, 12);
    const videoUrl = cleanRemoteUrl(info.previewVideoUrl);
    if (!images.length && !videoUrl) return null;

    const section = document.createElement("div");
    section.className = "detail-block work-preview-media-block";
    const titleRow = document.createElement("div");
    titleRow.className = "work-preview-title-row";
    titleRow.append(createDetailSectionTitle("预览媒体", images.length ? `${formatNumber(images.length)} 张` : ""));
    if (work.manualCoverId) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "work-preview-cover-reset";
      reset.textContent = "恢复默认封面";
      reset.addEventListener("click", () => setCover(work, "", reset));
      titleRow.append(reset);
    }
    section.append(titleRow);

    if (images.length) {
      const strip = document.createElement("div");
      strip.className = "work-preview-strip";
      for (const item of images) strip.append(createImageFrame(work, item));
      section.append(strip);
    }
    if (videoUrl) {
      const actions = document.createElement("div");
      actions.className = "work-preview-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "work-preview-video";
      button.textContent = "打开预览视频";
      button.addEventListener("click", () => window.open(videoUrl, "_blank", "noreferrer"));
      actions.append(button);
      section.append(actions);
    }
    return section;
  }

  function createImageFrame(work, item) {
    const frame = document.createElement("div");
    frame.className = `work-preview-item${item.imageId && item.imageId === work.manualCoverId ? " selected" : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "work-preview-thumb";
    button.setAttribute("aria-label", "打开预览图");
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = item.url;
    button.append(img);
    button.addEventListener("click", () => mediaViewer?.openImage?.(item.url, work.title || work.directoryName || "预览图"));
    frame.append(button);
    if (item.imageId) {
      const coverButton = document.createElement("button");
      coverButton.type = "button";
      coverButton.className = "work-preview-cover-action";
      if (item.imageId === work.manualCoverId) {
        coverButton.textContent = "当前封面";
        coverButton.disabled = true;
      } else if (!work.manualCoverId && item.imageId === work.coverId) {
        coverButton.textContent = "默认封面";
        coverButton.disabled = true;
      } else {
        coverButton.textContent = "设为封面";
        coverButton.addEventListener("click", () => setCover(work, item.imageId, coverButton));
      }
      frame.append(coverButton);
    }
    return frame;
  }

  async function setCover(work, imageId, button) {
    if (!work?.id) return;
    const previousText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = imageId ? "设置中" : "恢复中";
    }
    try {
      const data = await putJson(getActiveUrl(), `/api/works/${encodeURIComponent(work.id)}/cover`, { imageId });
      if (data.work) Object.assign(work, data.work);
      await updateCache(work).catch(() => null);
      renderMessage(imageId ? "封面已更新。" : "已恢复默认封面。", "quiet", false);
      renderWorkDetail(work.id);
    } catch (error) {
      if (button) {
        button.disabled = false;
        button.textContent = previousText;
      }
      renderMessage(detailErrorMessage(error, "封面设置失败，请稍后重试"), "error", false);
    }
  }

  async function updateCache(work) {
    const activeUrl = getActiveUrl();
    const path = `/api/works/${encodeURIComponent(work.id)}`;
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    return writeCachedJson(activeUrl, path, { ...(cached?.payload || {}), work });
  }

  return { render };
}

function localItems(work) {
  return [...(work.images || [])]
    .filter((image) => image?.id)
    .sort((a, b) => rank(a) - rank(b) || String(a.relativePath || a.name || "").localeCompare(String(b.relativePath || b.name || "")))
    .map((image) => ({ imageId: image.id, url: `/media/image/${encodeURIComponent(image.id)}` }));
}

function rank(image) {
  const text = `${image?.relativePath || ""} ${image?.name || ""}`.toLowerCase();
  if (/(?:extra[-_ ]?fanart|sample|screenshot|preview|fanart)/.test(text)) return 0;
  if (/(?:poster|cover|folder|front|thumb|thumbnail)/.test(text)) return 2;
  return 1;
}

function cleanRemoteUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function remoteItems(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const url = cleanRemoteUrl(value);
    const key = url.toLowerCase();
    if (!url || seen.has(key)) return [];
    seen.add(key);
    return [{ imageId: "", url }];
  });
}

function uniqueItems(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const imageId = String(item?.imageId || "");
    const url = cleanRemoteUrl(item?.url);
    const key = imageId ? `image:${imageId}` : `url:${url.toLowerCase()}`;
    if (!url || seen.has(key)) return [];
    seen.add(key);
    return [{ imageId, url }];
  });
}
