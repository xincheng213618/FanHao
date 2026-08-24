import {
  requestShortVideoDelete,
  shortVideoDeletePendingMessage,
  shortVideoDeleteRecoveryMessage
} from "./delete-contract.js?v=20260825-author-cleanup-01";
import { showShortVideoDeleteConfirm } from "./delete-actions.js?v=20260825-author-cleanup-01";

export function createShortVideoAuthorCleanup(options = {}) {
  const { api, recovery, showToast } = options;
  const confirmCleanup = options.confirmCleanup || showShortVideoDeleteConfirm;
  const onCompleted = options.onCompleted || (() => undefined);
  if (typeof api !== "function" || !recovery) throw new TypeError("author cleanup dependencies are required");
  let active = false;

  async function run(item = {}, trigger = null) {
    const secUid = String(item.secUid || item.authorSecUid || "").trim();
    if (!secUid) return null;
    if (active || recovery.hasPending()) {
      showToast?.("请先等待上一项删除恢复完成");
      return null;
    }
    active = true;
    setTriggerBusy(trigger, "正在预览…");
    try {
      const path = `/api/short-videos/authors/${encodeURIComponent(secUid)}/cleanup`;
      const proposal = await api(path);
      if (proposal?.manager?.available !== true) {
        throw new Error(proposal?.manager?.error || "8765 采集服务不可用，不能安全移除监听");
      }
      const preview = proposal.preview || {};
      const confirmed = await confirmCleanup(cleanupPrompt(preview, proposal.manager), {
        title: "确认清理作者",
        commitLabel: "删除并移除监听"
      });
      if (!confirmed) return null;
      if (recovery.hasPending()) {
        showToast?.("请先等待上一项删除恢复完成");
        return null;
      }
      setTriggerBusy(trigger, "正在清理…");
      const request = {
        method: "POST",
        body: {
          deleteCount: Number(preview.deleteCount || 0),
          likedCount: Number(preview.likedCount || 0),
          operationId: cleanupOperationId(secUid)
        }
      };
      const result = preview.deleteCount > 0
        ? await requestShortVideoDelete(api, path, request)
        : await api(path, request);
      if (preview.deleteCount > 0) recovery.track(result);
      if (result?.committed === false) {
        showToast?.(shortVideoDeleteRecoveryMessage(result));
        return result;
      }
      const summary = result?.payload?.authorCleanup || result?.authorCleanup || {};
      showToast?.(cleanupResultMessage(preview, result, summary));
      await onCompleted({ preview, result, summary, trigger });
      return result;
    } catch (error) {
      showToast?.(error?.message || "作者清理失败");
      return null;
    } finally {
      active = false;
      clearTriggerBusy(trigger);
    }
  }

  return { isActive: () => active, run };
}

function cleanupPrompt(preview, manager) {
  const monitoring = manager?.monitored
    ? `移除 8765 中的 ${Number(manager.profileCount || 0)} 条作者监听及排队任务`
    : "清除本地关注状态（8765 当前没有这个作者的监听记录）";
  return [
    `${preview.name || "未知作者"}`,
    `保留：${Number(preview.likedCount || 0)} 条明确点赞视频（${formatBytes(preview.likedBytes)}）`,
    `删除：${Number(preview.deleteCount || 0)} 条未点赞视频（${formatBytes(preview.deleteBytes)}）`,
    `随后取消关注，并${monitoring}。`,
    "只处理这个作者的本地视频；明确点赞视频和图文不会删除。删除后无法从资料库恢复。"
  ].join("\n\n");
}

function cleanupResultMessage(preview, result, summary) {
  if (summary.followRemoved !== true || summary.monitoringRemoved !== true) {
    const reason = summary.followError || summary.removal?.failed?.[0]?.message || "请稍后重试移除监听";
    return `已删除 ${Number(preview.deleteCount || 0)} 条未点赞视频，但取消关注/移除监听未完全完成：${reason}`;
  }
  if (result?.pending) return `${shortVideoDeletePendingMessage(result)}；已取消关注并移除监听`;
  return `已保留 ${Number(preview.likedCount || 0)} 条点赞视频，删除 ${Number(preview.deleteCount || 0)} 条未点赞视频，并移除监听`;
}

function cleanupOperationId(secUid) {
  const fallback = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (value) => {
    const random = Math.floor(Math.random() * 16);
    return (value === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
  return `sv-delete-op-${globalThis.crypto?.randomUUID?.() || fallback}`;
}

function setTriggerBusy(trigger, label) {
  if (!trigger) return;
  if (!trigger.dataset.idleLabel) trigger.dataset.idleLabel = trigger.textContent || "清理";
  trigger.textContent = label;
  trigger.disabled = true;
  trigger.setAttribute("aria-busy", "true");
}

function clearTriggerBusy(trigger) {
  if (!trigger?.isConnected) return;
  trigger.textContent = trigger.dataset.idleLabel || "清理";
  trigger.disabled = false;
  trigger.removeAttribute("aria-busy");
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value || 0));
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / (1024 ** index);
  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2)} ${units[index]}`;
}
