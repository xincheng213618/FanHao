const AUTH_LABELS = {
  "missing-password": "未输入密码",
  password: "已输入密码",
  "trusted-network": "局域网免密",
  app: "Android 注入",
  "app-cookie": "App Cookie",
  unknown: "未知方式"
};

const ACCESS_LABELS = {
  local: "本机",
  lan: "局域网",
  remote: "远程",
  unknown: "未知网络"
};

const AUTH_ORDER = ["missing-password", "password", "trusted-network", "app", "app-cookie", "unknown"];
const numberFormatter = new Intl.NumberFormat("zh-CN");

function formatNumber(value) {
  return numberFormatter.format(Number(value || 0));
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function setText(node, value) {
  if (node) node.textContent = value;
}

export function createAccessAnalyticsController({ api, root }) {
  const state = {
    payload: null,
    loading: false,
    offset: 0,
    limit: 50,
    searchTimer: null
  };
  const els = {
    geoStatus: root?.querySelector("#accessGeoStatus"),
    refresh: root?.querySelector("#accessRefresh"),
    days: root?.querySelector("#accessDays"),
    network: root?.querySelector("#accessNetwork"),
    auth: root?.querySelector("#accessAuth"),
    province: root?.querySelector("#accessProvince"),
    query: root?.querySelector("#accessQuery"),
    summary: root?.querySelector("#accessSummary"),
    authBreakdown: root?.querySelector("#accessAuthBreakdown"),
    provinceBreakdown: root?.querySelector("#accessProvinceBreakdown"),
    daily: root?.querySelector("#accessDaily"),
    tableSummary: root?.querySelector("#accessTableSummary"),
    rows: root?.querySelector("#accessVisitorRows"),
    status: root?.querySelector("#accessStatus"),
    previous: root?.querySelector("#accessPrev"),
    next: root?.querySelector("#accessNext"),
    pageLabel: root?.querySelector("#accessPageLabel")
  };

  function queryString() {
    const params = new URLSearchParams({
      days: els.days?.value || "30",
      limit: String(state.limit),
      offset: String(state.offset)
    });
    params.set("access", els.network?.value || "remote");
    if (els.auth?.value) params.set("auth", els.auth.value);
    if (els.province?.value) params.set("province", els.province.value);
    if (els.query?.value.trim()) params.set("q", els.query.value.trim());
    return params.toString();
  }

  async function load(options = {}) {
    if (!root || state.loading) return state.payload;
    state.loading = true;
    if (els.refresh) {
      els.refresh.disabled = true;
      els.refresh.textContent = "刷新中";
    }
    if (!options.quiet) setText(els.status, "正在汇总访问记录…");
    try {
      state.payload = await api(`/api/admin/access-stats?${queryString()}`);
      render();
      setText(els.status, state.payload.summary?.lastSeen
        ? `统计已更新 · 最近访问 ${formatDateTime(state.payload.summary.lastSeen)}`
        : "当前范围内还没有访问记录");
      return state.payload;
    } catch (error) {
      setText(els.status, error.message || "读取访问统计失败");
      throw error;
    } finally {
      state.loading = false;
      if (els.refresh) {
        els.refresh.disabled = false;
        els.refresh.textContent = "刷新统计";
      }
    }
  }

  function resetAndLoad() {
    state.offset = 0;
    load().catch(() => {});
  }

  function render() {
    renderGeoStatus();
    renderProvinceOptions();
    renderSummary();
    renderAuthBreakdown();
    renderProvinceBreakdown();
    renderDaily();
    renderVisitors();
  }

  function renderGeoStatus() {
    const geo = state.payload?.geo || {};
    setText(els.geoStatus, geo.ready ? "ip2region 离线库可用" : "离线库不可用");
    els.geoStatus?.classList.toggle("error", !geo.ready);
    if (els.geoStatus) els.geoStatus.title = geo.error || geo.database || "";
  }

  function renderProvinceOptions() {
    if (!els.province) return;
    const selected = els.province.value;
    els.province.innerHTML = '<option value="">全部省份</option>';
    for (const province of state.payload?.provinceOptions || []) {
      const option = document.createElement("option");
      option.value = province;
      option.textContent = province;
      els.province.append(option);
    }
    if ([...els.province.options].some((option) => option.value === selected)) els.province.value = selected;
  }

  function renderSummary() {
    if (!els.summary) return;
    const summary = state.payload?.summary || {};
    const cards = [
      ["独立 IP", summary.uniqueIps, `${formatNumber(summary.pageViews)} 次页面访问`, "accent"],
      ["全部请求", summary.requests, `${formatNumber(summary.errorRequests)} 次异常响应`, "blue"],
      ["未输入密码", summary.missingPasswordRequests, "远程请求未携带有效身份", "rust"],
      ["已输入密码", summary.passwordRequests, "远程网页密码 Cookie", "slate"],
      ["注入访问", summary.injectedRequests, "Android 注入或 App Cookie", "violet"]
    ];
    els.summary.innerHTML = cards.map(([label, value, detail, tone]) => `
      <article class="access-summary-card ${tone}">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(formatNumber(value))}</strong>
        <small>${escapeHtml(detail)}</small>
      </article>
    `).join("");
  }

  function renderAuthBreakdown() {
    if (!els.authBreakdown) return;
    const rows = new Map((state.payload?.auth || []).map((row) => [row.reason, row]));
    const reasons = [...AUTH_ORDER, ...rows.keys()].filter((reason, index, values) => values.indexOf(reason) === index);
    els.authBreakdown.innerHTML = reasons.map((reason) => {
      const row = rows.get(reason) || {};
      return `
        <div class="access-auth-row">
          <button type="button" data-access-auth-filter="${escapeHtml(reason)}">${escapeHtml(AUTH_LABELS[reason] || reason)}</button>
          <strong>${escapeHtml(formatNumber(row.requests))}</strong>
          <small>${escapeHtml(formatNumber(row.uniqueIps))} 个 IP · ${escapeHtml(formatNumber(row.pageViews))} 次页面访问</small>
        </div>
      `;
    }).join("");
    for (const button of els.authBreakdown.querySelectorAll("[data-access-auth-filter]")) {
      button.addEventListener("click", () => {
        if (els.auth) els.auth.value = button.dataset.accessAuthFilter || "";
        resetAndLoad();
      });
    }
  }

  function renderProvinceBreakdown() {
    if (!els.provinceBreakdown) return;
    const rows = state.payload?.provinces || [];
    const max = Math.max(1, ...rows.map((row) => Number(row.requests || 0)));
    els.provinceBreakdown.innerHTML = rows.length ? rows.map((row) => `
      <div class="access-ranking-row">
        <span class="access-ranking-bar" style="--bar-width:${Math.max(2, Number(row.requests || 0) / max * 100).toFixed(1)}%"></span>
        <strong>${escapeHtml(row.province)}</strong>
        <b>${escapeHtml(formatNumber(row.requests))}</b>
        <small>${escapeHtml(formatNumber(row.uniqueIps))} 个 IP · ${escapeHtml(formatNumber(row.pageViews))} 次页面访问</small>
      </div>
    `).join("") : '<div class="access-empty">暂无省份数据</div>';
  }

  function renderDaily() {
    if (!els.daily) return;
    const rows = (state.payload?.daily || []).slice(-31);
    const max = Math.max(1, ...rows.map((row) => Number(row.requests || 0)));
    els.daily.innerHTML = rows.length ? rows.map((row) => `
      <div class="access-daily-row">
        <span class="access-daily-bar" style="--bar-width:${Math.max(2, Number(row.requests || 0) / max * 100).toFixed(1)}%"></span>
        <strong>${escapeHtml(row.day)}</strong>
        <b>${escapeHtml(formatNumber(row.requests))}</b>
        <small>${escapeHtml(formatNumber(row.uniqueIps))} 个 IP · ${escapeHtml(formatNumber(row.deniedRequests))} 次未授权</small>
      </div>
    `).join("") : '<div class="access-empty">暂无每日数据</div>';
  }

  function renderVisitors() {
    if (!els.rows) return;
    const visitors = state.payload?.visitors || [];
    const pagination = state.payload?.pagination || {};
    const total = Number(pagination.total || 0);
    const page = Math.floor(state.offset / state.limit) + 1;
    const pages = Math.max(1, Math.ceil(total / state.limit));
    setText(els.tableSummary, `${formatNumber(total)} 条 IP / 访问方式组合`);
    setText(els.pageLabel, `${page} / ${pages}`);
    if (els.previous) els.previous.disabled = state.offset <= 0 || state.loading;
    if (els.next) els.next.disabled = state.offset + state.limit >= total || state.loading;

    els.rows.innerHTML = visitors.length ? visitors.map((visitor) => `
      <tr>
        <td><span class="access-ip">${escapeHtml(visitor.ip)}</span></td>
        <td>
          <div class="access-cell-stack">
            <strong>${escapeHtml([visitor.province, visitor.city].filter((item, index, values) => item && item !== "未知" && values.indexOf(item) === index).join(" · ") || visitor.country || "未知")}</strong>
            <small>${escapeHtml(visitor.isp || "未知运营商")}</small>
          </div>
        </td>
        <td>
          <div class="access-cell-stack">
            <span><b class="access-auth-badge ${escapeHtml(visitor.authReason)}">${escapeHtml(AUTH_LABELS[visitor.authReason] || visitor.authReason)}</b></span>
            <small>${escapeHtml(ACCESS_LABELS[visitor.accessMode] || visitor.accessMode)}</small>
          </div>
        </td>
        <td>
          <div class="access-cell-stack">
            <strong>${escapeHtml(formatNumber(visitor.requests))} / ${escapeHtml(formatNumber(visitor.pageViews))}</strong>
            <small>接口 ${escapeHtml(formatNumber(visitor.apiRequests))} · 媒体 ${escapeHtml(formatNumber(visitor.mediaRequests))}</small>
          </div>
        </td>
        <td>
          <div class="access-cell-stack">
            <span>${escapeHtml(formatDateTime(visitor.firstSeen))}</span>
            <small>${escapeHtml(formatDateTime(visitor.lastSeen))}</small>
          </div>
        </td>
        <td><span class="access-path" title="${escapeHtml(visitor.lastPath)}">${escapeHtml(visitor.lastPath || "-")}</span></td>
      </tr>
    `).join("") : '<tr><td class="access-empty" colspan="6">当前筛选范围内没有访问记录</td></tr>';
  }

  function bind() {
    els.refresh?.addEventListener("click", () => load().catch(() => {}));
    for (const control of [els.days, els.network, els.auth, els.province]) control?.addEventListener("change", resetAndLoad);
    els.query?.addEventListener("input", () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(resetAndLoad, 320);
    });
    els.previous?.addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - state.limit);
      load().catch(() => {});
    });
    els.next?.addEventListener("click", () => {
      state.offset += state.limit;
      load().catch(() => {});
    });
  }

  bind();
  return { load };
}
