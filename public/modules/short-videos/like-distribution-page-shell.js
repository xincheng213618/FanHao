export function renderLikeDistributionPageShell(options) {
  const {
    authorEfficiencyTable,
    createIcon,
    els,
    ensureView,
    isCurrent,
    onLeave,
    state
  } = options;
  const shell = document.createElement("section");
  shell.className = "short-video-home short-video-distribution-page";
  const navigation = document.createElement("div");
  navigation.className = "short-video-distribution-page-nav";
  const back = document.createElement("button");
  back.type = "button";
  back.append(createIcon("chevronLeft"), document.createTextNode(authorEfficiencyTable ? "返回内容洞察" : "返回短视频"));
  back.addEventListener("click", onLeave);
  const context = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = authorEfficiencyTable ? "作者投入分析" : "短视频数据统计";
  const title = document.createElement("h1");
  title.textContent = authorEfficiencyTable ? "占用与命中关系" : "内容洞察";
  context.append(eyebrow, title);
  navigation.append(back, context);
  const placeholder = document.createElement("section");
  placeholder.className = "short-video-distribution-panel short-video-distribution-loading-panel";
  placeholder.setAttribute("role", "status");
  placeholder.setAttribute("aria-live", "polite");
  placeholder.setAttribute("aria-busy", "true");
  const loadingTitle = document.createElement("strong");
  loadingTitle.textContent = authorEfficiencyTable ? "正在准备作者关系表" : "正在准备内容洞察";
  const loadingDescription = document.createElement("span");
  loadingDescription.textContent = "正在读取本机统计缓存；缓存过期时会在后台同步最新结果。";
  placeholder.append(loadingTitle, loadingDescription);
  shell.append(navigation, placeholder);
  els.workGrid.append(shell);

  ensureView().then((view) => {
    if (!isCurrent() || state.shortVideo.mode !== "likes" || !placeholder.isConnected) return;
    placeholder.replaceWith(authorEfficiencyTable
      ? view.renderAuthorEfficiencyTable()
      : view.renderLikeDistributionPanel());
  }).catch((error) => {
    if (!isCurrent() || !placeholder.isConnected) return;
    placeholder.removeAttribute("aria-busy");
    placeholder.classList.add("is-error");
    placeholder.textContent = error?.message || "内容洞察模块加载失败";
  });
}
