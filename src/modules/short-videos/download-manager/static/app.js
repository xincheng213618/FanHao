import { api } from "./core/api.js";
import { toast } from "./core/dom.js";
import { createSingleFlightPoller } from "./core/poller.js";
import { createActivityFeature } from "./features/activity.js";
import { createAuthFeature } from "./features/auth.js";
import { createDownloadsFeature } from "./features/downloads.js?v=20260809-home-simplify-01";
import { createLibraryFeature } from "./features/library.js";
import { createLinksFeature } from "./features/links.js?v=20260809-home-simplify-01";
import { createProfilesFeature } from "./features/profiles.js?v=20260810-banned-profiles-01";
import { createSettingsFeature } from "./features/settings.js";

let statePoller = null;
let statusPoller = null;
let linksFeature = null;
let linksPoller = null;
let activityPoller = null;
let activePage = "home";
let statusEndpointAvailable = true;
let activityEndpointAvailable = true;
let lightweightEndpointConfirmed = false;

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
  return resolvedPage;
}

const settingsFeature = createSettingsFeature({ onRefreshLinks: refreshLinks });
const authFeature = createAuthFeature();
const profilesFeature = createProfilesFeature({ settings: settingsFeature, refreshState, refreshLinks });
const downloadsFeature = createDownloadsFeature({ settings: settingsFeature, refreshState });
linksFeature = createLinksFeature({
  settings: settingsFeature,
  refreshState,
  supportsLinkRetry: () => lightweightEndpointConfirmed,
});
const libraryFeature = createLibraryFeature({ showPage: () => setActivePage("library") });
const activityFeature = createActivityFeature();

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
  const state = await api("/api/state");
  features.forEach((feature) => feature.render(state));
}

async function fetchAndRenderHomeState() {
  const state = await api("/api/state");
  profilesFeature.renderStatus(state);
  downloadsFeature.renderHome(state);
  downloadsFeature.renderStatus(state);
  linksFeature.render(state);
}

async function fetchAndRenderStatus() {
  let state = null;
  if (statusEndpointAvailable) {
    try {
      state = await api("/api/status");
      lightweightEndpointConfirmed = true;
    } catch (_err) {
      statusEndpointAvailable = false;
      lightweightEndpointConfirmed = false;
    }
  }
  if (!state) state = await api("/api/state");
  profilesFeature.renderStatus(state);
  downloadsFeature.renderStatus(state);
}

async function fetchAndRenderActivity() {
  let state = null;
  if (activityEndpointAvailable) {
    try {
      state = await api("/api/activity");
    } catch (_err) {
      activityEndpointAvailable = false;
    }
  }
  activityFeature.render(state || await api("/api/state"));
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
