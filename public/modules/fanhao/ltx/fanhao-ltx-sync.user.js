// ==UserScript==
// @name         FanHao · Jasna-LTX 目录同步
// @namespace    fanhao.ltx
// @version      1.1.0
// @match        https://ltxlib.dpdns.org/*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(() => {
  "use strict";
  const official = "https://ltxlib.dpdns.org";
  const params = new URLSearchParams(location.hash.slice(1));
  const id = params.get("fanhaoCatalog");
  const origin = params.get("fanhaoOrigin");
  const opener = unsafeWindow.opener;
  if (location.origin !== official || !opener || !/^[0-9a-f-]{36}$/i.test(id || "")
    || !["http://127.0.0.1:29998", "http://localhost:29998"].includes(origin)) return;
  const limit = 32 * 1024 * 1024;
  let sent = false;
  const ready = (fn) => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  };

  function forward(data) {
    const catalog = data?.data ?? data;
    if (sent || !Array.isArray(catalog?.items) || !catalog.items.length) return;
    const { items, avatars, genres, updated_at } = catalog;
    const json = JSON.stringify({ items, avatars, genres, updated_at });
    if (new Blob([json]).size > limit) return;
    opener.postMessage({ type: "fanhao:ltx:catalog", id, json }, origin);
    sent = true;
    observer.disconnect();
  }
  function readEmbedded() {
    const script = document.getElementById("ltx-items");
    if (!script || script.textContent.length > limit) return;
    try { forward(JSON.parse(script.textContent)); } catch { /* Use the site's response if available. */ }
  }

  // Observe only successful directory responses from the site's own page.
  const pageFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function (...args) {
    const pending = pageFetch.apply(this, args);
    void pending.then((response) => {
      if (sent || !response.ok || ![`${official}/api/items`, `${official}/api/verify`].includes(response.url)
        || Number(response.headers.get("content-length")) > limit) return;
      return response.clone().text().then((text) => {
        if (text.length <= limit) forward(JSON.parse(text));
      });
    }).catch(() => {});
    return pending;
  };
  const observer = new MutationObserver(readEmbedded);
  observer.observe(document, { childList: true, subtree: true });
  ready(() => {
    readEmbedded();
    observer.disconnect();
    opener.postMessage({ type: "fanhao:ltx:ready", id }, origin);
  });
})();
