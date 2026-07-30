export function createToolViews(context) {
  const {
    els,
    setActiveBottom
  } = context;

  function renderTools() {
    setActiveBottom("tools");
    els.viewKicker.textContent = "个人中心";
    els.viewTitle.textContent = "我的";
    els.viewMeta.textContent = "";
    els.viewContent.replaceChildren(createGamesSection());
  }

  function createGamesSection() {
    const section = document.createElement("section");
    section.className = "tools-dashboard";
    const head = document.createElement("div");
    head.className = "tools-section-head";
    const title = document.createElement("strong");
    title.textContent = "小游戏";
    const meta = document.createElement("span");
    meta.textContent = "离线可用";
    head.append(title, meta);
    section.append(head, createGameLauncher());
    return section;
  }

  function createGameLauncher() {
    const wrap = document.createElement("section");
    wrap.className = "tool-launch-grid";
    wrap.append(
      createLaunchCard({
        badge: "2048",
        title: "2048 AI",
        detail: "手玩、AI 建议或自动运行",
        url: "./games/2048/index.html"
      }),
      createLaunchCard({
        badge: "解",
        title: "华容道",
        detail: "经典滑块与 AI 自动解",
        url: "./games/huarongdao/index.html#/game"
      })
    );
    return wrap;
  }

  function createLaunchCard(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tool-launch-card";
    button.setAttribute("aria-label", `打开${item.title}`);
    button.addEventListener("click", () => {
      window.location.assign(item.url);
    });

    const badge = document.createElement("span");
    badge.className = "tool-launch-badge";
    badge.textContent = item.badge;

    const body = document.createElement("span");
    body.className = "tool-launch-body";
    const title = document.createElement("strong");
    title.textContent = item.title;
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    body.append(title, detail);

    const action = document.createElement("span");
    action.className = "tool-launch-action";
    action.textContent = "打开";

    button.append(badge, body, action);
    return button;
  }

  return {
    renderTools
  };
}
