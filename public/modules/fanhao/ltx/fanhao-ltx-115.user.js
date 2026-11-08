// ==UserScript==
// @name         FanHao LTX · 115 云下载
// @namespace    fanhao.ltx
// @version      1.0.0
// @description  将本机 FanHao 里手动选定的链接提交给浏览器已登录的 115。
// @match        http://127.0.0.1/fanhao/ltx*
// @match        http://localhost/fanhao/ltx*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @connect      clouddownload.115.com
// @noframes
// ==/UserScript==

(() => {
  "use strict";
  if (location.port !== "29998" || !/^\/fanhao\/ltx\/?$/.test(location.pathname)
    || !document.querySelector('meta[name="fanhao-ltx"]')) return;

  const endpoint = "https://clouddownload.115.com/web/";
  let busy = false;

  function report(id, kind, message) {
    document.dispatchEvent(new CustomEvent("fanhao:ltx115:result", {
      detail: JSON.stringify({ id, kind, message })
    }));
  }

  function errorMessage(response) {
    const code = Number(response.errcode ?? response.errno ?? response.code);
    if (code === 911) return "115 要求登录或验证账号。请在同一浏览器打开 115 云下载完成验证。";
    const message = response.error_msg || response.error || response.msg;
    return typeof message === "string" ? message.slice(0, 180) : "115 拒绝了这次提交。";
  }

  function handleResponse(id, response, count) {
    if (response.status < 200 || response.status >= 300) {
      report(id, "error", `115 返回 HTTP ${response.status}，请检查登录状态。`);
      return;
    }
    let data;
    try { data = JSON.parse(response.responseText); } catch {
      report(id, "error", "115 返回了网页，请在同一浏览器登录 115 后再试。");
      return;
    }
    if (!data || (data.state !== true && data.state !== 1)) {
      report(id, "error", errorMessage(data || {}));
      return;
    }
    const results = Array.isArray(data.result) ? data.result : [];
    const failed = results.filter((item) => item?.state !== true && item?.state !== 1);
    if (failed.length) {
      report(id, "error", `115 已接受 ${results.length - failed.length} 条，失败 ${failed.length} 条。 ${errorMessage(failed[0] || {})}`);
    } else {
      report(id, "ok", `115 已接受 ${count} 条云下载链接。`);
    }
  }

  document.addEventListener("fanhao:ltx115:add", (event) => {
    let request;
    try { request = JSON.parse(event.detail); } catch { return; }
    const { id, urls, dir = "" } = request || {};
    if (typeof id !== "string" || id.length > 80) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      report(id, "error", "请在 FanHao 页面上手动点击添加。");
      return;
    }
    if (!Array.isArray(urls) || !urls.length || urls.length > 50 || urls.some((url) =>
      typeof url !== "string" || url.length > 16000 || /[\r\n]/.test(url)
      || !/^(?:magnet:\?|ed2k:\/\/\|file\|)/i.test(url)) || typeof dir !== "string" || !/^\d{0,32}$/.test(dir)) {
      report(id, "error", "链接或保存目录 ID 格式不正确。");
      return;
    }
    if (busy) {
      report(id, "error", "上一批链接正在提交，请稍候。");
      return;
    }

    const body = new URLSearchParams({ ac: "add_task_urls" });
    urls.forEach((url, index) => body.set(`url[${index}]`, url));
    if (dir) body.set("wp_path_id", dir);
    const unknown = () => report(id, "unknown", "115 的提交结果未返回。请先到云下载核对任务再重试。");
    busy = true;
    try {
      GM_xmlhttpRequest({
        method: "POST",
        url: endpoint,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        data: body.toString(),
        timeout: 20000,
        onload: (response) => { busy = false; handleResponse(id, response, urls.length); },
        onerror: () => { busy = false; unknown(); },
        ontimeout: () => { busy = false; unknown(); },
        onabort: () => { busy = false; unknown(); }
      });
    } catch {
      busy = false;
      report(id, "error", "浏览器扩展未能发起请求，请检查脚本的 115 访问权限。");
    }
  });

  document.documentElement.dataset.fanhaoLtx115 = "1";
})();
