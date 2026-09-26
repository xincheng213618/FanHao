const PRIMARY_ANDROID_NAV_IDS = Object.freeze(["fanhao", "photos", "short-videos", "novels", "tools"]);
const PRIMARY_ANDROID_NAV_LABELS = Object.freeze({
  fanhao: "番号",
  photos: "套图",
  "short-videos": "短视频",
  novels: "小说",
  tools: "我的"
});

export async function loadModuleCatalog(fetchModules) {
  const payload = await fetchModules();
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  return modules
    .filter((module) => module && typeof module === "object" && module.id && module.title)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

export function renderAndroidModuleNavigation(container, modules) {
  if (!container) return [];
  const androidModules = modules
    .filter((module) => module.client?.android)
    .sort((a, b) => Number(a.client.android.order ?? a.order ?? 0) - Number(b.client.android.order ?? b.order ?? 0));
  if (!androidModules.length) return [...container.querySelectorAll("button")];

  const moduleById = new Map(androidModules.map((module) => [module.id, module]));
  const primaryModules = PRIMARY_ANDROID_NAV_IDS.map((id) => moduleById.get(id)).filter(Boolean);
  const navigationModules = primaryModules.length === PRIMARY_ANDROID_NAV_IDS.length
    ? primaryModules
    : androidModules.slice(0, 5);

  const fragment = document.createDocumentFragment();
  for (const module of navigationModules) {
    const surface = module.client.android;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bottom-nav-item bottom-nav-${module.id}`;
    if (module.id === "short-videos") button.classList.add("bottom-nav-primary");
    button.dataset.moduleId = module.id;
    button.dataset.bottomKey = surface.bottomKey || module.id;
    if (module.id === "photos") {
      button.dataset.gallerySwitcher = "";
      button.dataset.galleryModeCurrent = "photo";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.title = "点击回到当前分类；长按选择套图、韩漫、电影、电视剧或动漫";
    }
    if (module.id === "novels") {
      button.dataset.readingSwitcher = "";
      button.dataset.readingModeCurrent = "novels";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.title = "点击回到当前分类；长按选择小说或音乐";
    }
    if (module.id === "fanhao") {
      button.dataset.fanhaoHome = "";
      button.dataset.homeSwitcher = "";
      button.dataset.homeModeCurrent = "fanhao";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.title = "点击回到当前分类；长按选择番号或欧美";
    }
    else if (surface.channel) button.dataset.openChannel = surface.channel;
    else if (surface.view) button.dataset.openView = surface.view;

    const icon = createBottomNavigationIcon(module.id);
    const label = document.createElement("span");
    label.className = "bottom-nav-label";
    label.textContent = PRIMARY_ANDROID_NAV_LABELS[module.id] || surface.title || module.title;
    button.setAttribute("aria-label", label.textContent);
    button.append(icon, label);
    fragment.append(button);
  }

  container.replaceChildren(fragment);
  return [...container.querySelectorAll("button")];
}

function createBottomNavigationIcon(moduleId) {
  const icon = document.createElement("span");
  icon.className = "bottom-nav-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = bottomNavigationIconMarkup(moduleId);
  return icon;
}

function bottomNavigationIconMarkup(moduleId) {
  const icons = {
    fanhao: `
      <svg class="bottom-nav-icon-outline" viewBox="0 0 24 24"><path d="M3.5 10.4 12 3.5l8.5 6.9v9.1a1 1 0 0 1-1 1h-5.2v-6.2H9.7v6.2H4.5a1 1 0 0 1-1-1Z"/></svg>
      <svg class="bottom-nav-icon-filled" viewBox="0 0 24 24"><path d="M2.7 10.1 12 2.5l9.3 7.6a1 1 0 0 1 .4.8v9.2a1.6 1.6 0 0 1-1.6 1.6h-6.4v-6.4h-3.4v6.4H3.9a1.6 1.6 0 0 1-1.6-1.6v-9.2a1 1 0 0 1 .4-.8Z"/></svg>`,
    photos: `
      <svg class="bottom-nav-icon-outline" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.3" cy="9" r="1.6"/><path d="m4.5 17 4.2-4 3.2 2.8 3.3-3.3 4.3 4.5"/></svg>
      <svg class="bottom-nav-icon-filled" viewBox="0 0 24 24"><path d="M5 3h14a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm3.2 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-4 10.8c0 .7.5 1.2 1.2 1.2h13.2c.7 0 1.2-.5 1.2-1.2l-4.6-4.7-3.3 3.3-3.2-2.8Z"/></svg>`,
    "short-videos": `
      <svg class="bottom-nav-icon-outline" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="4"/><path d="m10 9 5 3-5 3Z"/></svg>
      <svg class="bottom-nav-icon-filled" viewBox="0 0 24 24"><path d="m9 7 8 5-8 5Z"/></svg>`,
    novels: `
      <svg class="bottom-nav-icon-outline" viewBox="0 0 24 24"><path d="M4 4.5h5.2c1.5 0 2.8 1.1 2.8 2.6v13c0-1.4-1.3-2.6-2.8-2.6H4Zm16 0h-5.2c-1.5 0-2.8 1.1-2.8 2.6v13c0-1.4 1.3-2.6 2.8-2.6H20Z"/></svg>
      <svg class="bottom-nav-icon-filled" viewBox="0 0 24 24"><path d="M3 3h6.1c1.1 0 2.1.4 2.9 1.2V20c-.8-.8-1.8-1.2-2.9-1.2H3Zm18 0h-6.1c-1.1 0-2.1.4-2.9 1.2V20c.8-.8 1.8-1.2 2.9-1.2H21Z"/></svg>`,
    tools: `
      <svg class="bottom-nav-icon-outline" viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c.5-4.2 3.2-6.2 7.5-6.2s7 2 7.5 6.2"/></svg>
      <svg class="bottom-nav-icon-filled" viewBox="0 0 24 24"><circle cx="12" cy="7.7" r="4.2"/><path d="M3.4 21c.4-5.2 3.4-7.8 8.6-7.8s8.2 2.6 8.6 7.8Z"/></svg>`
  };
  return icons[moduleId] || `<svg class="bottom-nav-icon-outline bottom-nav-icon-filled" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>`;
}
