import { postJson } from "../../../../js/api.js?v=20260706-mobile-web-sync-01";
import { readCachedJson, writeCachedJson } from "../../../../js/cache.js?v=20260705-mobile-actions-01";
import { openFanhaoSheet } from "../../sheet.js?v=20260731-mobile-action-sheet-01";

export function createWorkActions(deps) {
  const {
    detailErrorMessage,
    extractWorkCode,
    formatNumber,
    getActiveUrl,
    onUserStateChange,
    renderMessage,
    renderWorkDetail
  } = deps;

  function createActionRow(work) {
    const actions = document.createElement("div");
    actions.className = "detail-action-row";
    const markerButton = actionButton("local-marker-action", "", () => toggleLocalMarker(work, "A", markerButton));
    syncMarkerButton(markerButton, work, "A");
    const favoriteButton = actionButton("favorite-action", "", () => toggleFavorite(work, favoriteButton));
    syncFavoriteButton(favoriteButton, work.favorite);
    const moreButton = actionButton("work-more-action", "更多", () => openMoreActions(work));
    actions.append(markerButton, favoriteButton, moreButton);
    return actions;
  }

  function openMoreActions(work) {
    const code = extractWorkCode(work);
    openFanhaoSheet({
      title: "更多操作",
      options: [
        {
          label: "复制番号",
          hidden: !code,
          select: () => copyWorkCode(code)
        },
        {
          label: "打开资料来源",
          hidden: !work.javdbUrl,
          select: () => window.open(work.javdbUrl, "_blank", "noreferrer")
        },
        {
          label: "删除本地文件",
          variant: "danger wide",
          hidden: !work?.id || work.missingLocal,
          select: (_value, button) => deleteLocalFiles(work, button)
        }
      ]
    });
  }

  async function copyWorkCode(code) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      renderMessage(`番号 ${code} 已复制。`, "quiet", false);
    } catch {
      renderMessage("复制番号失败，请长按番号手动复制。", "error", false);
    }
  }

  function actionButton(className, text, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  }

  function syncFavoriteButton(button, favorite) {
    button.textContent = favorite ? "已收藏" : "收藏";
    button.classList.toggle("active", Boolean(favorite));
  }

  function syncMarkerButton(button, work, marker = "A") {
    const key = String(marker || "A").toUpperCase();
    const active = (work.localMarkers || []).includes(key);
    button.hidden = Boolean(work.missingLocal);
    button.textContent = active ? `${key} 已标记` : `标记 ${key}`;
    button.title = active ? `移除 ${key} 标记` : `添加 ${key} 标记`;
    button.classList.toggle("active", active);
  }

  function syncDeleteButton(button, work) {
    const available = Boolean(work?.id && !work.missingLocal);
    button.hidden = !available;
    button.disabled = !available;
    button.textContent = "删除文件";
    button.title = available ? "删除这个作品的本地文件夹，数据库资料会保留" : "";
  }

  async function toggleLocalMarker(work, marker, button) {
    const key = String(marker || "A").toUpperCase();
    const markers = new Set(work.localMarkers || []);
    const nextEnabled = !markers.has(key);
    const previousMarkers = [...markers];
    button.disabled = true;
    button.textContent = nextEnabled ? "标记中" : "移除中";
    try {
      const data = await postJson(getActiveUrl(), `/api/works/${encodeURIComponent(work.id)}/local-marker`, { marker: key, enabled: nextEnabled });
      if (data.work) Object.assign(work, data.work);
      else {
        if (nextEnabled) markers.add(key);
        else markers.delete(key);
        work.localMarkers = [...markers];
      }
      syncMarkerButton(button, work, key);
      updateCachedDetail(work).catch(() => {});
      renderMessage(nextEnabled ? `${key} 标记已添加。` : `${key} 标记已移除。`, "quiet", false);
    } catch (error) {
      work.localMarkers = previousMarkers;
      syncMarkerButton(button, work, key);
      renderMessage(detailErrorMessage(error, "更新作品标记失败，请稍后重试"), "error", false);
    } finally {
      button.disabled = false;
      syncMarkerButton(button, work, key);
    }
  }

  async function deleteLocalFiles(work, button) {
    if (!work?.id || work.missingLocal) return;
    const title = work.title || work.directoryName || extractWorkCode(work) || "这个作品";
    if (!window.confirm(`确认删除「${title}」的本地文件夹？\n\n数据库资料会保留，删除后会显示为未下载。`)) return;
    button.disabled = true;
    button.textContent = "删除中";
    try {
      const data = await postJson(getActiveUrl(), `/api/works/${encodeURIComponent(work.id)}/local-files/delete`);
      if (data.work) Object.assign(work, data.work);
      else work.missingLocal = true;
      await updateCachedDetail(work).catch(() => null);
      const removedEmpty = data.emptyRemovedPaths?.length ? `，并清理 ${formatNumber(data.emptyRemovedPaths.length)} 个空目录` : "";
      renderMessage(`本地文件已删除${removedEmpty}。`, "quiet", false);
      renderWorkDetail(work.id);
    } catch (error) {
      button.disabled = false;
      button.textContent = "删除失败";
      renderMessage(detailErrorMessage(error, "删除本地文件失败，请稍后重试"), "error", false);
      window.setTimeout(() => syncDeleteButton(button, work), 1400);
    }
  }

  async function toggleFavorite(work, button) {
    const previous = Boolean(work.favorite);
    button.disabled = true;
    button.textContent = previous ? "取消中" : "收藏中";
    try {
      const data = await postJson(getActiveUrl(), `/api/favorites/${encodeURIComponent(work.id)}`);
      work.favorite = Boolean(data.favorite);
      syncFavoriteButton(button, work.favorite);
      if (data.user) onUserStateChange?.(data.user);
    } catch (error) {
      syncFavoriteButton(button, previous);
      renderMessage(detailErrorMessage(error, "收藏状态更新失败，请稍后重试"), "error", false);
    } finally {
      button.disabled = false;
    }
  }

  async function updateCachedDetail(work) {
    if (!work?.id) return null;
    const activeUrl = getActiveUrl();
    const path = `/api/works/${encodeURIComponent(work.id)}`;
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    return writeCachedJson(activeUrl, path, { ...(cached?.payload || {}), work });
  }

  return { createActionRow };
}
