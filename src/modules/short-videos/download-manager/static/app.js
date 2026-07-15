import { api } from "./core/api.js";
import { toast } from "./core/dom.js";
import { createSingleFlightPoller } from "./core/poller.js";
import { createActivityFeature } from "./features/activity.js";
import { createAuthFeature } from "./features/auth.js";
import { createDownloadsFeature } from "./features/downloads.js";
import { createLibraryFeature } from "./features/library.js";
import { createLinksFeature } from "./features/links.js";
import { createProfilesFeature } from "./features/profiles.js";
import { createSettingsFeature } from "./features/settings.js";

let statePoller = null;
let linksFeature = null;

function refreshState() {
  return statePoller ? statePoller.run() : Promise.resolve();
}

function refreshLinks() {
  return Promise.resolve(linksFeature?.refresh());
}

function setActivePage(page) {
  const target = page || "home";
  const panels = Array.from(document.querySelectorAll("[data-page-panel]"));
  const buttons = Array.from(document.querySelectorAll("[data-page-target]"));
  const exists = panels.some((panel) => panel.dataset.pagePanel === target);
  const activePage = exists ? target : "home";
  panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.pagePanel === activePage));
  buttons.forEach((button) => button.classList.toggle("active", button.dataset.pageTarget === activePage));
  if (location.hash !== `#${activePage}`) {
    history.replaceState(null, "", `#${activePage}`);
  }
  return activePage;
}

const settingsFeature = createSettingsFeature({ onRefreshLinks: refreshLinks });
const authFeature = createAuthFeature();
const profilesFeature = createProfilesFeature({ settings: settingsFeature, refreshState, refreshLinks });
const downloadsFeature = createDownloadsFeature({ settings: settingsFeature, refreshState });
linksFeature = createLinksFeature({ settings: settingsFeature, refreshState });
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

statePoller = createSingleFlightPoller(fetchAndRenderState, 5000);
const linksPoller = createSingleFlightPoller(() => linksFeature.refreshLoaded(), 10000);

function activatePage(page) {
  if (page === "library") libraryFeature.activate().catch((err) => toast(err.message));
  if (page === "profiles") profilesFeature.activate().catch((err) => toast(err.message));
  if (page === "settings") authFeature.activate().catch((err) => toast(err.message));
}

function bindNavigation() {
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = setActivePage(button.dataset.pageTarget || "home");
      activatePage(page);
    });
  });
  window.addEventListener("hashchange", () => setActivePage(location.hash.replace(/^#/, "") || "home"));
  const initialPage = setActivePage(location.hash.replace(/^#/, "") || "home");
  if (initialPage === "library" || initialPage === "profiles") activatePage(initialPage);
}

features.forEach((feature) => feature.bind());
bindNavigation();
statePoller.run().catch((err) => toast(err.message));
linksFeature.refresh().catch((err) => toast(err.message));
statePoller.start();
linksPoller.start();
