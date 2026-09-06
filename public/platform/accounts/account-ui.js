const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const date = (value) => value ? new Date(value).toLocaleDateString("zh-CN") : "尚未登录";
const dateTime = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "暂无记录";
const inviteStatuses = { all: "全部状态", available: "可使用", exhausted: "已用完", expired: "已过期", disabled: "已停用" };
const field = (name, label, options = {}) => `<label>${label}<input name="${name}" type="${options.type || "text"}" ${options.required === false ? "" : "required"}
  ${options.type === "password" ? `minlength="${options.minLength || 10}" maxlength="128"` : ""} ${options.attrs || ""} value="${escape(options.value || "")}" autocomplete="${options.autocomplete || "off"}"></label>`;

export function mountAccountPanel(root, { request, authenticate = (mode, body) => request(`/api/accounts/${mode}`, { method: "POST", body }),
  clearSession = async () => {}, onSignedIn = async () => {}, onSignedOut = async () => {}, initialMode = "login", legacyLogin = null } = {}) {
  let state = null, tab = "profile", mode = initialMode, busy = false, disposed = false, generation = 0;
  let userOffset = 0, inviteOffset = 0, auditOffset = 0, search = "", auditSearch = "", generated = [], resetTarget = null, resetCode = null;
  let inviteSearch = "", inviteStatus = "all", selectedInvite = null, inviteReturn = "invites", redemptionOffset = 0, redemptionSearch = "";
  function clearSecrets() { generated = []; resetTarget = null; resetCode = null; selectedInvite = null; }
  root.classList.add("account-ui");
  function message(text, error = false) {
    if (disposed) return;
    const node = root.querySelector("[data-account-message]");
    if (node) { node.textContent = text; node.classList.toggle("is-error", error); }
  }
  function header(title, description) { return `<div class="account-heading"><span class="account-eyebrow">FANHAO ACCOUNT</span><h2>${title}</h2><p>${description}</p></div>`; }
  function page(content) {
    if (disposed) return;
    root.innerHTML = `<div class="account-card">${content}<p class="account-message" data-account-message role="status" aria-live="polite"></p></div>`;
  }
  function guest() {
    if (mode === "reset") {
      page(`${header("找回密码", "请联系管理员获取一次性重置码，再为账号设置新密码。")}
        <p class="account-hint">重置码有效期为 30 分钟，只能使用一次。完成后，所有设备都需要重新登录。</p>
        <form data-form="reset">
        ${field("username", "用户名", { autocomplete: "username", attrs: 'maxlength="32" autocapitalize="none" spellcheck="false"' })}
        ${field("resetCode", "密码重置码", { attrs: 'maxlength="100" placeholder="FHR-…" autocapitalize="none" spellcheck="false"' })}
        ${field("newPassword", "新密码", { type: "password", autocomplete: "new-password" })}
        ${field("confirmPassword", "确认新密码", { type: "password", autocomplete: "new-password" })}
        <button class="account-primary" type="submit">重置密码</button></form>
        <button class="account-link" type="button" data-mode="login">返回登录</button>`);
      return;
    }
    if (mode === "register" && !state.registrationEnabled) mode = "login";
    if (mode === "setup" && !state.setupAvailable) mode = "login";
    const signup = mode !== "login";
    const title = mode === "setup" ? "创建首个管理员" : signup ? "创建你的账号" : "欢迎回来";
    page(`${header(title, mode === "setup" ? "仅服务所在电脑可初始化管理员。" : signup ? (state.invitationRequired ? "填写邀请码，加入资料库。" : "目前开放注册，无需邀请码。") : state.accountLoginRequired ? "此资料库已关闭访客访问，请使用账号登录。" : "使用账号登录网页和安卓端。")}
      <p class="account-hint">登录后，番号收藏与观看记录按账号保存。未登录时使用访客记录。</p>
      <div class="account-tabs" aria-label="账号操作"><button type="button" data-mode="login" aria-pressed="${mode === "login"}">登录</button>
      ${state.registrationEnabled ? `<button type="button" data-mode="register" aria-pressed="${mode === "register"}">注册</button>` : ""}</div>
      ${!state.registrationEnabled ? '<p class="account-hint">当前已关闭新用户注册，已有账号仍可登录。</p>' : ""}
      <form data-form="${mode}">
      ${field("username", "用户名", { autocomplete: "username", attrs: 'minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}" autocapitalize="none" spellcheck="false" placeholder="3–32 位字母或数字等"' })}
      ${signup ? field("displayName", "昵称（选填）", { required: false, attrs: 'maxlength="40" placeholder="如何称呼你"' }) : ""}
      ${field("password", "密码", { type: "password", autocomplete: signup ? "new-password" : "current-password", attrs: 'placeholder="10–128 位"' })}
      ${signup ? field("confirmPassword", "确认密码", { type: "password", autocomplete: "new-password" }) : ""}
      ${mode === "register" ? field("inviteCode", state.invitationRequired ? "邀请码" : "邀请码（选填）", { required: state.invitationRequired, attrs: 'maxlength="100" placeholder="FH-…" autocapitalize="characters" spellcheck="false"' }) : ""}
      <button class="account-primary" type="submit">${mode === "setup" ? "创建管理员" : signup ? "注册并登录" : "登录"}</button></form>
      ${mode === "login" ? '<button class="account-link" type="button" data-mode="reset">忘记密码？</button>' : ""}
      ${state.setupAvailable && mode !== "setup" ? '<button class="account-link" type="button" data-mode="setup">本机初始化管理员 →</button>' : ""}
      ${legacyLogin && !state.accountLoginRequired ? `<details class="account-details"><summary>使用原访问密码</summary><form data-form="legacy">${field("password", "原访问密码", { type: "password", minLength: 1, autocomplete: "current-password" })}<button type="submit">验证访问密码</button></form></details>` : ""}`);
  }
  function navigation() {
    const items = [["profile", "个人资料"], ["sessions", "登录设备"], ...(state.user.role === "admin" ? [["users", "用户管理"], ["invites", "邀请码"], ["settings", "注册与访问"], ["audit", "操作记录"]] : [])];
    return `<div class="account-user-heading"><span class="account-avatar">${escape(state.user.displayName.slice(0, 1).toUpperCase())}</span><div><strong>${escape(state.user.displayName)}</strong>
      <span>@${escape(state.user.username)} · ${state.user.role === "admin" ? "管理员" : "普通用户"}</span></div></div>
      <nav class="account-tabs" aria-label="用户中心">${items.map(([id, label]) => `<button type="button" data-tab="${id}" aria-pressed="${tab === id}">${label}</button>`).join("")}</nav>`;
  }
  function profile() {
    return `<h3>个人资料</h3><form data-form="profile">${field("displayName", "昵称", { value: state.user.displayName, attrs: 'maxlength="40"' })}<button type="submit">保存资料</button></form>
      <p class="account-hint">用户名 ${escape(state.user.username)} · 注册于 ${date(state.user.createdAt)}</p>
      <p class="account-hint">登录后，番号收藏与观看记录按账号保存。未登录时使用访客记录。</p>
      <details class="account-details"><summary>修改密码</summary><p class="account-hint">修改后所有设备需重新登录。</p><form data-form="password">
      ${field("currentPassword", "当前密码", { type: "password", autocomplete: "current-password" })}
      ${field("newPassword", "新密码", { type: "password", autocomplete: "new-password" })}
      ${field("confirmPassword", "确认新密码", { type: "password", autocomplete: "new-password" })}
      <button type="submit">更新密码</button></form></details>
      <button class="account-danger account-logout" type="button" data-action="logout">退出登录</button>`;
  }
  function settings() {
    return `<h3>注册与访问设置</h3><p class="account-hint">保存后在网页与安卓同步生效。</p><form data-form="settings">
      <label class="account-switch"><input name="registrationEnabled" type="checkbox" ${state.registrationEnabled ? "checked" : ""}><span>开放新用户注册</span></label>
      <label class="account-switch"><input name="invitationRequired" type="checkbox" ${state.invitationRequired ? "checked" : ""}><span>注册时必须填写邀请码</span></label>
      <p class="account-hint">关闭邀请码要求时可以直接注册；填写的邀请码仍会验证并消耗次数。</p>
      <label class="account-switch"><input name="accountLoginRequired" type="checkbox" ${state.accountLoginRequired ? "checked" : ""}><span>访问资料库必须登录账号</span></label>
      <p class="account-hint">开启后，本机、局域网和远程设备都需登录用户账号，原访问密码也不能单独进入资料库。已有账号可继续登录，注册入口仍按上方设置开放。</p>
      <button class="account-primary" type="submit">保存设置</button></form>`;
  }
  function sessions(payload) {
    const others = payload.sessions.filter((session) => !session.current).length;
    return `<h3>登录设备</h3><p class="account-hint">这里列出仍有效的登录记录。设备名称供参考，最近活动约每 5 分钟更新。</p>
      <div class="account-session-actions"><button type="button" data-action="refresh-sessions">刷新设备</button>
      <button type="button" class="account-danger" data-action="revoke-other-sessions" ${others ? "" : "disabled"}>退出其他全部设备${others ? `（${others}）` : ""}</button></div>
      <div class="account-list" aria-label="登录设备列表">${payload.sessions.map((session) => `<article class="account-row account-session-row" data-session-id="${escape(session.id)}" data-current="${session.current}">
        <div><strong>${escape(session.deviceLabel)}</strong>${session.current ? '<span class="account-current-device">当前设备</span>' : ""}
        <small>登录于 ${dateTime(session.createdAt)}</small><small>最近活动 ${dateTime(session.lastSeenAt)}</small><small>有效期至 ${dateTime(session.expiresAt)}</small></div>
        <button type="button" class="account-danger" data-revoke-session="${escape(session.id)}" data-current="${session.current}">${session.current ? "退出当前设备" : "退出此设备"}</button>
      </article>`).join("")}</div>`;
  }
  function pager(payload, kind) {
    return `<div class="account-pager"><span>共 ${payload.total} 条 · 第 ${Math.floor(payload.offset / 50) + 1} 页</span>
      <button type="button" data-page="${kind}" data-offset="${Math.max(0, payload.offset - 50)}" ${payload.offset ? "" : "disabled"}>上一页</button>
      <button type="button" data-page="${kind}" data-offset="${payload.offset + 50}" ${payload.offset + 50 < payload.total ? "" : "disabled"}>下一页</button></div>`;
  }
  function users(payload) {
    return `<h3>用户管理</h3><form data-form="search" class="account-search">${field("search", "搜索用户", { required: false, value: search, attrs: 'maxlength="100" placeholder="用户名或昵称"' })}<button type="submit">搜索</button></form>
      ${resetTarget ? passwordResetPanel() : ""}
      <div class="account-list">${payload.users.map((user) => `<article class="account-row"><div><strong>${escape(user.displayName)}</strong><span>@${escape(user.username)} · ${user.disabled ? "已停用" : "正常"}</span><small>注册 ${date(user.createdAt)} · 最近登录 ${date(user.lastLoginAt)}</small>
      ${user.registration?.kind === "invitation" ? `<button type="button" class="account-source" data-invite-detail="${escape(user.registration.inviteId)}">来自邀请码 •••• ${escape(user.registration.suffix)}</button><small>生成者 @${escape(user.registration.createdByUsername)}</small>` : '<small>注册来源：未使用邀请码</small>'}</div>
      <div class="account-row-actions"><button type="button" data-user="${escape(user.id)}" data-role="${user.role === "admin" ? "user" : "admin"}">${user.role === "admin" ? "设为普通用户" : "设为管理员"}</button>
      <button type="button" data-user="${escape(user.id)}" data-disabled="${!user.disabled}" class="${user.disabled ? "" : "account-danger"}">${user.disabled ? "启用" : "停用"}</button>
      <button type="button" data-reset-user="${escape(user.id)}" data-username="${escape(user.username)}" ${user.disabled ? "disabled" : ""}>重置密码</button></div></article>`).join("") || '<p class="account-empty">没有匹配的用户。</p>'}</div>${pager(payload, "users")}`;
  }
  function passwordResetPanel() {
    return `<section class="account-generated" aria-label="协助重置密码"><h3>重置 @${escape(resetTarget.username)} 的密码</h3>
      <p class="account-hint">先核实用户身份，再把重置码交给本人。重新生成会使该用户的旧重置码失效；使用后会退出其全部设备。</p>
      ${resetCode ? `<label>一次性重置码<textarea readonly rows="2" data-reset-code>${escape(resetCode.code)}</textarea></label>
        <p class="account-hint">${dateTime(resetCode.expiresAt)} 到期。完整码只在此处显示，请及时复制。</p>
        <button type="button" data-action="copy-reset">复制重置码</button>` : `<form data-form="issue-reset">
        ${field("currentPassword", "你的管理员密码", { type: "password", autocomplete: "current-password" })}
        <button type="submit">生成一次性重置码</button></form>`}
      <button type="button" data-action="close-reset">关闭</button></section>`;
  }
  function audit(payload) {
    const actions = { "account.created": "创建账号", "user.updated": "调整账号", "password.changed": "修改密码", "password.reset-issued": "发放重置码",
      "password.reset": "重置密码", "registration.changed": "调整注册设置", "access.changed": "调整访问设置", "invites.created": "生成邀请码", "invite.revoked": "停用邀请码", "sessions.revoked": "退出登录设备" };
    return `<h3>操作记录</h3><p class="account-hint">保留最近 10,000 条成功的关键操作。可按操作人或目标用户名搜索。</p>
      <form data-form="audit-search" class="account-search">${field("search", "搜索操作记录", { required: false, value: auditSearch, attrs: 'maxlength="100" placeholder="用户名"' })}<button type="submit">搜索</button></form>
      <div class="account-list" aria-label="操作记录列表">${payload.events.map((event) => `<article class="account-row"><div>
        <strong>${escape(actions[event.action] || event.action)}</strong><span>${escape(event.summary)}</span>
        <small>操作人：${event.actorUsername ? `@${escape(event.actorUsername)}` : "通过重置码验证"}${event.targetUsername ? ` · 目标：@${escape(event.targetUsername)}` : ""}</small>
        <small>${dateTime(event.createdAt)}</small></div></article>`).join("") || '<p class="account-empty">没有匹配的操作记录。</p>'}</div>${pager(payload, "audit")}`;
  }
  function invites(payload) {
    return `<h3>邀请码生成器</h3><p class="account-hint">邀请码仅用于创建普通用户。完整码只在生成后显示，请及时复制。</p><form data-form="invites"><div class="account-form-grid">
      ${field("count", "生成数量", { type: "number", value: "1", attrs: 'min="1" max="100"' })}
      ${field("maxUses", "每码使用次数", { type: "number", value: "1", attrs: 'min="1" max="1000"' })}
      ${field("expiresInDays", "有效天数", { type: "number", value: "7", attrs: 'min="1" max="365"' })}</div>
      ${field("note", "备注（选填）", { required: false, attrs: 'maxlength="120" placeholder="例如：朋友邀请"' })}<button class="account-primary" type="submit">生成邀请码</button></form>
      ${generated.length ? `<div class="account-generated"><label>刚生成的邀请码<textarea readonly rows="${Math.min(6, generated.length + 1)}">${generated.map((entry) => escape(entry.code)).join("\n")}</textarea></label><button type="button" data-action="copy">复制全部</button></div>` : ""}
      <h3>生成记录</h3><form data-form="invite-search" class="account-invite-filter">
      ${field("search", "搜索邀请码", { required: false, value: inviteSearch, attrs: 'maxlength="100" placeholder="备注、末尾标识或生成者用户名"' })}
      <label>邀请码状态<select name="status" aria-label="邀请码状态">${Object.entries(inviteStatuses).map(([value, text]) => `<option value="${value}" ${inviteStatus === value ? "selected" : ""}>${text}</option>`).join("")}</select></label>
      <button type="submit">筛选</button></form><div class="account-list" aria-label="邀请码列表">${payload.invites.map((invite) => {
        return `<article class="account-row" data-invite-row="${escape(invite.id)}"><div><strong>•••• ${escape(invite.suffix)}</strong><span>${inviteStatuses[invite.status]} · 已用 ${invite.uses}/${invite.maxUses} 次 · ${date(invite.expiresAt)} 到期</span><small>${escape(invite.note || "无备注")}</small><small>生成者 @${escape(invite.createdByUsername)}</small></div>
          <div class="account-row-actions"><button type="button" data-invite-detail="${escape(invite.id)}">使用记录</button>${invite.status === "available" ? `<button type="button" class="account-danger" data-invite="${escape(invite.id)}">停用</button>` : ""}</div></article>`;
      }).join("") || `<p class="account-empty">${inviteSearch || inviteStatus !== "all" ? "没有符合筛选条件的邀请码。" : "还没有邀请码，生成后会显示在这里。"}</p>`}</div>${pager(payload, "invites")}`;
  }
  function inviteDetails(payload) {
    const { invite } = payload;
    return `<button type="button" class="account-link" data-action="back-invites">← 返回${inviteReturn === "users" ? "用户管理" : "邀请码列表"}</button>
      <h3>邀请码使用记录</h3><section class="account-invite-summary"><strong>•••• ${escape(invite.suffix)}</strong>
      <p>${inviteStatuses[invite.status]} · 已用 ${invite.uses}/${invite.maxUses} 次</p><p>${escape(invite.note || "无备注")}</p>
      <p>生成者 @${escape(invite.createdByUsername)} · ${dateTime(invite.createdAt)} 生成</p><p>${dateTime(invite.expiresAt)} 到期</p>
      ${invite.status === "available" ? `<button type="button" class="account-danger" data-invite="${escape(invite.id)}">停用邀请码</button>` : ""}</section>
      <p class="account-hint">以下账号使用此码完成注册。停用或过期不影响已注册账号。</p>
      <form data-form="redemption-search" class="account-search">${field("search", "搜索使用者", { required: false, value: redemptionSearch, attrs: 'maxlength="100" placeholder="用户名或昵称"' })}<button type="submit">搜索</button></form>
      <div class="account-list" aria-label="邀请码使用者">${payload.redemptions.map((user) => `<article class="account-row"><div>
        <strong>${escape(user.displayName)}</strong><span>@${escape(user.username)} · ${user.role === "admin" ? "管理员" : "普通用户"} · ${user.disabled ? "已停用" : "正常"}</span>
        <small>${dateTime(user.redeemedAt)} 注册</small></div></article>`).join("") || `<p class="account-empty">${redemptionSearch ? "没有匹配的使用者。" : "此邀请码还没有使用记录。"}</p>`}</div>${pager(payload, "redemptions")}`;
  }
  async function render() {
    const current = ++generation;
    if (!state?.user) { guest(); return; }
    if (state.user.role !== "admin" && !["profile", "sessions"].includes(tab)) tab = "profile";
    let content;
    if (["users", "invites", "sessions", "audit"].includes(tab)) {
      page(`${navigation()}<p role="status">正在加载…</p>`);
      try {
        const detail = tab === "invites" && selectedInvite;
        const offset = detail ? redemptionOffset : tab === "users" ? userOffset : tab === "audit" ? auditOffset : inviteOffset;
        const term = detail ? redemptionSearch : tab === "users" ? search : tab === "audit" ? auditSearch : inviteSearch;
        const payload = await request(tab === "sessions" ? "/api/accounts/sessions"
          : `/api/accounts/admin/${detail ? `invites/${encodeURIComponent(selectedInvite)}` : tab}?offset=${offset}&search=${encodeURIComponent(term)}${tab === "invites" && !detail ? `&status=${inviteStatus}` : ""}`);
        if (disposed || current !== generation) return;
        content = detail ? inviteDetails(payload) : tab === "sessions" ? sessions(payload) : tab === "users" ? users(payload) : tab === "audit" ? audit(payload) : invites(payload);
      } catch (error) {
        if (!disposed && current === generation) page(`${navigation()}<p class="account-hint">内容暂时无法读取，请重试。</p><button type="button" data-action="retry">重新加载</button>`);
        throw error;
      }
    } else content = tab === "settings" ? settings() : profile();
    page(navigation() + content);
  }
  async function refresh() {
    const current = ++generation;
    const next = await request("/api/accounts/status");
    if (disposed || current !== generation) return;
    if (state?.user?.id !== next.user?.id || (state?.user?.role === "admin" && next.user?.role !== "admin")) clearSecrets();
    state = next; await render();
  }
  async function run(action) {
    if (busy || disposed) return;
    busy = true;
    root.setAttribute("aria-busy", "true");
    for (const button of root.querySelectorAll("button:not(:disabled)")) { button.disabled = true; button.dataset.busyDisabled = "true"; }
    message("正在处理…");
    try { await action(); }
    catch (error) {
      if (!disposed && state?.user && Number(error.statusCode || error.status) === 401) {
        // Keep the revoked credential until an explicit login/logout; clearing it here could
        // fall back to this server's legacy trusted-network access on an Android client.
        state = { ...state, user: null }; mode = "login"; tab = "profile"; clearSecrets();
        guest(); message("登录已失效，请重新登录", true);
      } else if (!disposed) message(error.message || "操作失败，请重试", true);
    }
    finally {
      busy = false;
      if (!disposed) {
        root.removeAttribute("aria-busy");
        for (const button of root.querySelectorAll("[data-busy-disabled]")) { button.disabled = false; delete button.dataset.busyDisabled; }
      }
    }
  }
  async function submit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form || !root.contains(form)) return;
    event.preventDefault();
    const kind = form.dataset.form;
    const data = Object.fromEntries(new FormData(form));
    await run(async () => {
      if (["login", "register", "setup"].includes(kind)) {
        if (kind !== "login" && data.password !== data.confirmPassword) throw new Error("两次输入的密码不一致");
        delete data.confirmPassword;
        if (!data.displayName) delete data.displayName;
        await authenticate(kind, data);
        if (disposed) return;
        clearSecrets(); form.reset(); await refresh(); if (!disposed) await onSignedIn(); message("登录成功");
      } else if (kind === "reset") {
        if (data.newPassword !== data.confirmPassword) throw new Error("两次输入的新密码不一致");
        delete data.confirmPassword;
        await request("/api/accounts/password/reset", { method: "POST", body: data });
        await clearSession(); clearSecrets(); form.reset(); mode = "login"; await refresh();
        if (!disposed) await onSignedOut(); message("密码已重置，所有设备已退出。请使用新密码登录");
      } else if (kind === "issue-reset") {
        const payload = await request(`/api/accounts/admin/users/${encodeURIComponent(resetTarget.id)}/password-reset`, { method: "POST", body: data });
        form.reset();
        if (disposed) return;
        resetCode = payload.reset; await render(); message("一次性重置码已生成，请交给该用户本人");
        root.querySelector("[data-reset-code]")?.focus();
      } else if (kind === "legacy") { await legacyLogin(data.password); }
      else if (kind === "profile") { await request("/api/accounts/me", { method: "PATCH", body: data }); await refresh(); message("个人资料已保存"); }
      else if (kind === "password") {
        if (data.newPassword !== data.confirmPassword) throw new Error("两次输入的新密码不一致");
        delete data.confirmPassword;
        await request("/api/accounts/password", { method: "POST", body: data });
        await clearSession(); clearSecrets(); form.reset(); mode = "login"; await refresh(); if (!disposed) await onSignedOut(); message("密码已修改，请重新登录");
      } else if (kind === "settings") {
        await request("/api/accounts/admin/settings", { method: "PATCH", body: { registrationEnabled: data.registrationEnabled === "on", invitationRequired: data.invitationRequired === "on", accountLoginRequired: data.accountLoginRequired === "on" } });
        await refresh(); message("设置已保存");
      } else if (kind === "invites") {
        const payload = await request("/api/accounts/admin/invites", { method: "POST", body: { ...data, count: Number(data.count), maxUses: Number(data.maxUses), expiresInDays: Number(data.expiresInDays) } });
        if (disposed) return;
        generated = payload.invites; inviteOffset = 0; inviteSearch = ""; inviteStatus = "all"; await render(); message(`已生成 ${generated.length} 个邀请码，请复制保存`);
      } else if (kind === "search") { search = data.search; userOffset = 0; resetTarget = resetCode = null; await render(); }
      else if (kind === "audit-search") { auditSearch = data.search; auditOffset = 0; await render(); }
      else if (kind === "invite-search") { inviteSearch = data.search; inviteStatus = data.status; inviteOffset = 0; await render(); }
      else if (kind === "redemption-search") { redemptionSearch = data.search; redemptionOffset = 0; await render(); }
    });
  }
  async function click(event) {
    const button = event.target.closest("button");
    if (!button || !root.contains(button) || button.type === "submit") return;
    await run(async () => {
      if (button.dataset.mode) { mode = button.dataset.mode; await render(); }
      else if (button.dataset.tab) { tab = button.dataset.tab; resetTarget = resetCode = selectedInvite = null; await render(); }
      else if (button.dataset.page) {
        if (button.dataset.page === "users") { userOffset = Number(button.dataset.offset); resetTarget = resetCode = null; }
        else if (button.dataset.page === "audit") auditOffset = Number(button.dataset.offset);
        else if (button.dataset.page === "redemptions") redemptionOffset = Number(button.dataset.offset);
        else inviteOffset = Number(button.dataset.offset);
        await render();
      }
      else if (button.dataset.inviteDetail) {
        inviteReturn = tab; selectedInvite = button.dataset.inviteDetail; tab = "invites"; resetTarget = resetCode = null;
        redemptionSearch = ""; redemptionOffset = 0; await render();
      }
      else if (button.dataset.action === "back-invites") { tab = inviteReturn; selectedInvite = null; await render(); }
      else if (button.dataset.resetUser) {
        resetTarget = { id: button.dataset.resetUser, username: button.dataset.username }; resetCode = null; await render();
        root.querySelector('[data-form="issue-reset"] input')?.focus();
      }
      else if (button.dataset.action === "close-reset") { resetTarget = resetCode = null; await render(); }
      else if (button.dataset.action === "copy-reset") {
        try { await navigator.clipboard.writeText(resetCode.code); message("重置码已复制"); }
        catch { const textarea = root.querySelector("[data-reset-code]"); textarea?.focus(); textarea?.select(); message("请长按或按 Ctrl+C 复制已选中的重置码"); }
      }
      else if (button.dataset.action === "retry") { await refresh(); }
      else if (button.dataset.action === "refresh-sessions") { await render(); message("登录设备已刷新"); }
      else if (button.dataset.action === "revoke-other-sessions") {
        if (!window.confirm("退出其他全部设备？当前设备将保持登录。")) { message(""); return; }
        const result = await request("/api/accounts/sessions/revoke-others", { method: "POST", body: {} });
        await render(); message(`已退出 ${result.revoked} 个其他设备`);
      } else if (button.dataset.revokeSession) {
        if (!window.confirm(button.dataset.current === "true" ? "退出当前设备？继续使用账号需重新登录。" : "退出此设备？该设备需重新登录。")) { message(""); return; }
        const result = await request(`/api/accounts/sessions/${encodeURIComponent(button.dataset.revokeSession)}/revoke`, { method: "POST", body: {} });
        if (result.current) {
          await clearSession(); clearSecrets(); mode = "login"; tab = "profile"; await refresh();
          if (!disposed) await onSignedOut(); message("已退出当前设备");
        } else { await render(); message("该设备已退出登录"); }
      }
      else if (button.dataset.action === "logout") {
        await request("/api/accounts/logout", { method: "POST", body: {} }); await clearSession(); clearSecrets(); mode = "login"; await refresh(); if (!disposed) await onSignedOut(); message("已退出登录");
      } else if (button.dataset.action === "copy") {
        const textarea = root.querySelector("textarea");
        try { await navigator.clipboard.writeText(generated.map((entry) => entry.code).join("\n")); message("邀请码已复制"); }
        catch { textarea?.focus(); textarea?.select(); message("请长按或按 Ctrl+C 复制已选中的邀请码"); }
      } else if (button.dataset.user) {
        if (!window.confirm(`确定${button.textContent}？该用户需要重新登录。`)) { message(""); return; }
        await request(`/api/accounts/admin/users/${encodeURIComponent(button.dataset.user)}`, { method: "PATCH", body: button.dataset.role ? { role: button.dataset.role } : { disabled: button.dataset.disabled === "true" } });
        resetTarget = resetCode = null;
        await refresh(); message("用户状态已更新");
      } else if (button.dataset.invite) {
        if (!window.confirm("停用后该邀请码将无法注册，确定停用？")) { message(""); return; }
        await request(`/api/accounts/admin/invites/${encodeURIComponent(button.dataset.invite)}/revoke`, { method: "POST", body: {} });
        if (!selectedInvite) inviteOffset = 0;
        await render(); message("邀请码已停用");
      }
    });
  }
  root.addEventListener("submit", submit); root.addEventListener("click", click);
  page(`${header("用户中心", "正在连接账号服务…")}<button type="button" data-action="retry">重新连接</button>`);
  void run(refresh);
  return { refresh: () => run(refresh), destroy() { disposed = true; generation++; clearSecrets(); root.removeEventListener("submit", submit); root.removeEventListener("click", click); root.replaceChildren(); } };
}
