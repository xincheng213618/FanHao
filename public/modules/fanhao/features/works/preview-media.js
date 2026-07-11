export function createWorkPreviewMedia(deps) {
  const { api, coverRetryDelays, retryCoverUrl, onWorkUpdated } = deps;

  function render(work) {
    const info = work.infoMetadata || work.infoSummary || {};
    const images = uniqueItems([...localItems(work), ...remoteItems(info.previewImages || [])]).slice(0, 12);
    const videoUrl = cleanRemoteUrl(info.previewVideoUrl);
    if (!images.length && !videoUrl) return null;

    const section = document.createElement("section");
    section.className = "preview-media-section";
    const header = document.createElement("div");
    header.className = "preview-media-header";
    const heading = document.createElement("h4");
    heading.className = "section-title";
    heading.textContent = "预览媒体";
    header.append(heading);

    if (work.manualCoverId) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "text-button preview-cover-reset";
      reset.textContent = "恢复默认封面";
      reset.addEventListener("click", () => setCover(work, "", reset));
      header.append(reset);
    }
    section.append(header);

    if (images.length) {
      const grid = document.createElement("div");
      grid.className = "preview-media-grid";
      for (const item of images) grid.append(createImageFrame(work, item));
      section.append(grid);
    }
    if (videoUrl) {
      const actions = document.createElement("div");
      actions.className = "preview-media-actions";
      const link = document.createElement("a");
      link.className = "text-button preview-media-link";
      link.href = videoUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "打开预览视频";
      actions.append(link);
      section.append(actions);
    }
    return section;
  }

  function createImageFrame(work, item) {
    const frame = document.createElement("div");
    frame.className = `preview-media-item${item.imageId && item.imageId === work.manualCoverId ? " selected" : ""}`;
    const link = document.createElement("a");
    link.className = "preview-media-thumb";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.addEventListener("load", () => { img.dataset.loaded = "1"; });
    img.addEventListener("error", () => retryImage(img, item.url));
    img.src = item.url;
    link.append(img);
    frame.append(link);

    if (item.imageId) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "text-button preview-cover-button";
      if (item.imageId === work.manualCoverId) {
        button.textContent = "当前封面";
        button.disabled = true;
      } else if (!work.manualCoverId && item.imageId === work.coverId) {
        button.textContent = "默认封面";
        button.disabled = true;
      } else {
        button.textContent = "设为封面";
        button.addEventListener("click", () => setCover(work, item.imageId, button));
      }
      frame.append(button);
    }
    return frame;
  }

  async function setCover(work, imageId, button) {
    const originalText = button?.textContent || "";
    if (button) {
      button.disabled = true;
      button.textContent = imageId ? "设置中" : "恢复中";
    }
    try {
      const data = await api(`/api/works/${encodeURIComponent(work.id)}/cover`, {
        method: "PUT",
        body: { imageId }
      });
      if (data.work) onWorkUpdated(data.work, data.user);
    } catch (error) {
      alert(error.message);
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  function retryImage(img, src) {
    if (!img?.isConnected || img.dataset.loaded === "1") return;
    const retryCount = Number(img.dataset.retryCount || 0);
    if (retryCount >= coverRetryDelays.length) return;
    const delay = coverRetryDelays[Math.min(retryCount, coverRetryDelays.length - 1)];
    img.dataset.retryCount = String(retryCount + 1);
    window.setTimeout(() => {
      if (!img.isConnected || img.dataset.loaded === "1") return;
      img.src = retryCoverUrl(src, retryCount + 1);
    }, delay);
  }

  return { render };
}

function localItems(work) {
  return [...(work.images || [])]
    .filter((image) => image?.id)
    .sort((a, b) => previewRank(a) - previewRank(b) || String(a.relativePath || a.name || "").localeCompare(String(b.relativePath || b.name || "")))
    .map((image) => ({ imageId: image.id, url: `/media/image/${encodeURIComponent(image.id)}` }));
}

function previewRank(image) {
  const text = `${image?.relativePath || ""} ${image?.name || ""}`.toLowerCase();
  if (/(?:extra[-_ ]?fanart|sample|screenshot|preview|fanart)/.test(text)) return 0;
  if (/(?:poster|cover|folder|front|thumb|thumbnail)/.test(text)) return 2;
  return 1;
}

function cleanRemoteUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text : "";
}

function cleanImageUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) || /^\/media\/(?:image|remote-image)\b/i.test(text) ? text : "";
}

function remoteItems(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const url = cleanImageUrl(value);
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    result.push({ imageId: "", url });
  }
  return result;
}

function uniqueItems(items) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const imageId = String(item?.imageId || "");
    const url = cleanImageUrl(item?.url);
    const key = imageId ? `image:${imageId}` : `url:${url.toLowerCase()}`;
    if (!url || seen.has(key)) continue;
    seen.add(key);
    result.push({ imageId, url });
  }
  return result;
}
