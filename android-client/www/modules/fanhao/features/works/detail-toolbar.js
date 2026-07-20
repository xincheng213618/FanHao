import { formatNumber } from "../../../../js/format.js";

export function createWorkDetailToolbar(options = {}) {
  const work = options.work || {};
  const videos = Array.isArray(work.videos) ? work.videos : [];
  const progress = Math.max(0, Math.min(100, Number(work.progress?.percent || 0)));
  const toolbar = document.createElement("nav");
  toolbar.className = "work-detail-toolbar";
  toolbar.setAttribute("aria-label", "作品详情快捷操作");

  toolbar.append(
    createToolbarButton("播放", playStatus(videos.length, progress), options.onPlay, {
      disabled: videos.length === 0,
      pendingLabel: "正在打开"
    }),
    createToolbarButton("资料", targetStatus(options.factsTarget, ".work-fact-row"), () => revealTarget(options.factsTarget), {
      disabled: !options.factsTarget
    }),
    createToolbarButton("相关", options.relatedTarget ? "同演员作品" : "暂无", () => revealTarget(options.relatedTarget), {
      disabled: !options.relatedTarget
    })
  );
  return toolbar;
}

function createToolbarButton(label, value, action, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.disabled = Boolean(options.disabled);
  button.setAttribute("aria-label", `${label}，${value}`);
  const title = document.createElement("span");
  title.textContent = label;
  const current = document.createElement("strong");
  current.textContent = value;
  button.append(title, current);
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    const previous = current.textContent;
    if (options.pendingLabel) {
      button.disabled = true;
      current.textContent = options.pendingLabel;
    }
    try {
      await action?.();
    } catch {
      // The target section or player owns its detailed error state.
    } finally {
      if (options.pendingLabel) {
        button.disabled = false;
        current.textContent = previous;
      }
    }
  });
  return button;
}

function playStatus(videoCount, progress) {
  if (!videoCount) return "暂无视频";
  if (progress > 0) return `继续 ${Math.floor(progress)}%`;
  return `${formatNumber(videoCount)} 个视频`;
}

function targetStatus(target, selector) {
  if (!target) return "暂无";
  const count = selector ? target.querySelectorAll(selector).length : 0;
  return count ? `${formatNumber(count)} 项` : "查看详情";
}

function revealTarget(target) {
  target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}
