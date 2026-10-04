import { api } from "./core/api.js";
import { toast } from "./core/dom.js";
import { createSingleFlightPoller } from "./core/poller.js";
import { createActivityFeature } from "./features/activity.js?v=20260902-extract-reset-01";
import { createAuthFeature } from "./features/auth.js";
import { createDownloadsFeature } from "./features/downloads.js?v=20260917-api-probe-02";
import { createLibraryFeature } from "./features/library.js?v=20261002-manager-performance-01";
import { createLinksFeature } from "./features/links.js?v=20261002-workspace-01";
import { createProfilesFeature } from "./features/profiles.js?v=20261002-workspace-01";
import { createSettingsFeature } from "./features/settings.js?v=20260823-auto-collection-01";

let statePoller = null;
let statusPoller = null;
let linksFeature = null;
let linksPoller = null;
let activityPoller = null;
let activePage = "home";
const statusEndpoint = createLightweightEndpoint("/api/status");
const activityEndpoint = createLightweightEndpoint("/api/activity");

function createLightweightEndpoint(path) {
  let unsupported = false;
  let confirmed = false;
  let failures = 0;
  let retryAt = 0;
  return {
    get confirmed() { return confirmed; },
    async read() {
      if (unsupported || Date.now() < retryAt) return null;
      try {
        const state = await api(path);
        confirmed = true;
        failures = 0;
        retryAt = 0;
        return state;
      } catch (error) {
        if ([404, 405, 501].includes(error.status) || error.code === "ENDPOINT_NOT_SUPPORTED") {
          unsupported = true;
        } else {
          failures = Math.min(failures + 1, 5);
          retryAt = Date.now() + Math.min(5000 * 2 ** (failures - 1), 60000);
        }
        return null;
      }
    },
  };
}

function refreshState() {
  const tasks = [statusPoller ? statusPoller.run() : Promise.resolve()];
  if (activePage === "home" && statePoller) tasks.push(statePoller.run());
  if (activePage === "activity" && activityPoller) tasks.push(activityPoller.run());
  return Promise.all(tasks);
}

function refreshLinks() {
  if (activePage !== "home") return Promise.resolve();
  return Promise.resolve(linksFeature?.refresh());
}

function setActivePage(page) {
  const target = page || "home";
  const panels = Array.from(document.querySelectorAll("[data-page-panel]"));
  const buttons = Array.from(document.querySelectorAll("[data-page-target]"));
  const exists = panels.some((panel) => panel.dataset.pagePanel === target);
  const resolvedPage = exists ? target : "home";
  const pageCopy = {
    home: ["OVERVIEW", "下载概览", "从采集到归档，在这里管理你的媒体。"],
    library: ["LIBRARY", "已下载作品", "已保存的作品，随时回看。"],
    profiles: ["AUTHORS", "主页管理", "关注每一位作者，让作品有序归档。"],
    settings: ["PREFERENCES", "配置", "按你的习惯设置采集、下载与存储。"],
    activity: ["ACTIVITY", "任务列表", "查看采集进度与后台运行记录。"],
  }[resolvedPage];
  document.getElementById("workspaceEyebrow").textContent = `WORKSPACE / ${pageCopy[0]}`;
  document.getElementById("workspaceTitle").textContent = pageCopy[1];
  document.getElementById("workspaceDescription").textContent = pageCopy[2];
  panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.pagePanel === resolvedPage));
  buttons.forEach((button) => {
    const active = button.dataset.pageTarget === resolvedPage;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (location.hash !== `#${resolvedPage}`) {
    history.replaceState(null, "", `#${resolvedPage}`);
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  return resolvedPage;
}

const settingsFeature = createSettingsFeature({ onRefreshLinks: refreshLinks });
const authFeature = createAuthFeature();
const profilesFeature = createProfilesFeature({ settings: settingsFeature, refreshState, refreshLinks });
const downloadsFeature = createDownloadsFeature({ settings: settingsFeature, refreshState });
linksFeature = createLinksFeature({
  settings: settingsFeature,
  refreshState,
  supportsLinkRetry: () => statusEndpoint.confirmed,
});
const libraryFeature = createLibraryFeature({ showPage: () => {
  activePage = setActivePage("library");
  syncPagePollers();
} });
const activityFeature = createActivityFeature({ refreshState });

const features = [
  settingsFeature,
  authFeature,
  profilesFeature,
  downloadsFeature,
  linksFeature,
  libraryFeature,
  activityFeature,
];

async function fetchAndRenderState() {
  const state = await api("/api/state?compact=1");
  features.forEach((feature) => feature.render(state));
}

async function fetchAndRenderHomeState() {
  const state = await api("/api/state?compact=1");
  profilesFeature.renderStatus(state);
  downloadsFeature.renderHome(state);
  downloadsFeature.renderStatus(state);
  linksFeature.render(state);
}

async function fetchAndRenderStatus() {
  const state = await statusEndpoint.read() || await api("/api/state?compact=1");
  profilesFeature.renderStatus(state);
  downloadsFeature.renderStatus(state);
  linksFeature.renderRuntime(state);
}

async function fetchAndRenderActivity() {
  const state = await activityEndpoint.read() || await api("/api/state?compact=1");
  activityFeature.render(state);
}

statePoller = createSingleFlightPoller(fetchAndRenderHomeState, 15000);
statusPoller = createSingleFlightPoller(fetchAndRenderStatus, 5000);
linksPoller = createSingleFlightPoller(() => linksFeature.refreshLoaded(), 30000);
activityPoller = createSingleFlightPoller(fetchAndRenderActivity, 10000);

function syncPagePollers() {
  statePoller.stop();
  linksPoller.stop();
  activityPoller.stop();
  if (document.visibilityState === "hidden") {
    statusPoller.stop();
    return;
  }
  statusPoller.start();
  if (activePage === "home") {
    statePoller.start();
    linksPoller.start();
  } else if (activePage === "activity") {
    activityPoller.start();
  }
}

function activatePage(page, refreshHome = true) {
  activePage = page;
  if (page === "home") {
    if (refreshHome) statePoller.run().catch((err) => toast(err.message));
    linksFeature.refresh().catch((err) => toast(err.message));
  }
  if (page === "library") libraryFeature.activate().catch((err) => toast(err.message));
  if (page === "profiles") profilesFeature.activate().catch((err) => toast(err.message));
  if (page === "settings") authFeature.activate().catch((err) => toast(err.message));
  if (page === "activity") activityPoller.run().catch((err) => toast(err.message));
  syncPagePollers();
}

function bindNavigation() {
  if ("ResizeObserver" in window) {
    const toolbarSizes = new ResizeObserver((entries) => {
      entries.forEach(({ target }) => {
        const property = target.matches(".profile-manager-controls") ? "--profile-toolbar-height" : "--links-toolbar-height";
        target.parentElement.style.setProperty(property, `${target.getBoundingClientRect().height}px`);
      });
    });
    document.querySelectorAll(".profile-manager-controls, .links-head").forEach((toolbar) => toolbarSizes.observe(toolbar));
  }
  const backToTop = document.getElementById("backToTop");
  let scrollFramePending = false;
  window.addEventListener("scroll", () => {
    if (scrollFramePending) return;
    scrollFramePending = true;
    window.requestAnimationFrame(() => {
      backToTop.hidden = window.scrollY < 600;
      scrollFramePending = false;
    });
  }, { passive: true });
  backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "instant" }));
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = setActivePage(button.dataset.pageTarget || "home");
      activatePage(page);
    });
  });
  window.addEventListener("hashchange", () => {
    const page = setActivePage(location.hash.replace(/^#/, "") || "home");
    activatePage(page);
  });
  document.addEventListener("visibilitychange", () => {
    syncPagePollers();
    if (document.visibilityState === "hidden") return;
    statusPoller.run().catch((err) => toast(err.message));
    if (activePage === "home") {
      statePoller.run().catch((err) => toast(err.message));
      linksFeature.refreshLoaded().catch((err) => toast(err.message));
    } else if (activePage === "activity") {
      activityPoller.run().catch((err) => toast(err.message));
    }
  });
  return setActivePage(location.hash.replace(/^#/, "") || "home");
}

features.forEach((feature) => feature.bind());
const initialPage = bindNavigation();
Promise.all([fetchAndRenderState(), statusPoller.run()])
  .then(() => activatePage(initialPage, false))
  .catch((err) => toast(err.message))
  .finally(syncPagePollers);
