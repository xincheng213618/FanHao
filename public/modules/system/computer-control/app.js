const grid = document.querySelector("#controlGrid");
const platformStatus = document.querySelector("#platformStatus");
const notice = document.querySelector(".notice");
const noticeTitle = document.querySelector("#noticeTitle");
const noticeText = document.querySelector("#noticeText");

const actionNotes = {
  lock: "立即锁定当前 Windows 会话",
  mute: "切换系统静音状态",
  sleep: "让电脑进入休眠",
  restart: "60 秒后重启，可取消",
  shutdown: "60 秒后关机，可取消",
  cancel: "撤销计划中的关机或重启"
};

boot().catch((error) => {
  setNotice("无法打开控制面板", error.message || "请稍后重试", "error");
  platformStatus.textContent = "系统能力读取失败";
  grid?.removeAttribute("aria-busy");
});

async function boot() {
  const state = await request("/api/system/control");
  platformStatus.textContent = `${state.platformLabel || state.platform} · FanHao 主服务`;
  renderActions(Array.isArray(state.actions) ? state.actions : []);
  grid.removeAttribute("aria-busy");
}

function renderActions(actions) {
  grid.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `control-button ${action.kind === "danger" ? "danger" : ""} ${action.id === "cancel" ? "cancel" : ""}`.trim();
    button.dataset.action = action.id;

    const icon = document.createElement("span");
    icon.className = "control-icon";
    icon.textContent = action.icon || "•";
    icon.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "control-copy";
    const title = document.createElement("strong");
    title.textContent = action.label || action.id;
    const note = document.createElement("small");
    note.textContent = actionNotes[action.id] || "发送系统控制指令";
    copy.append(title, note);
    button.append(icon, copy);
    button.addEventListener("click", () => runAction(action, button));
    grid.append(button);
  }
}

async function runAction(action, button) {
  if (action.confirm && !window.confirm(action.confirm)) return;
  setBusy(true);
  button.dataset.previousLabel = button.querySelector("strong")?.textContent || "";
  if (button.querySelector("strong")) button.querySelector("strong").textContent = "发送中…";
  setNotice("正在发送", `正在执行“${action.label}”`, "");
  try {
    const result = await request("/api/system/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: action.id })
    });
    setNotice("指令已接收", result.message || `${action.label}指令已发送`, "success");
  } catch (error) {
    setNotice("发送失败", error.message || "系统控制指令发送失败", "error");
  } finally {
    if (button.querySelector("strong")) button.querySelector("strong").textContent = button.dataset.previousLabel;
    setBusy(false);
  }
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && payload.loginUrl) window.location.assign(payload.loginUrl);
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function setBusy(busy) {
  for (const button of grid.querySelectorAll("button")) button.disabled = busy;
  grid.setAttribute("aria-busy", busy ? "true" : "false");
}

function setNotice(title, text, tone) {
  noticeTitle.textContent = title;
  noticeText.textContent = text;
  notice.classList.toggle("error", tone === "error");
  notice.classList.toggle("success", tone === "success");
}
