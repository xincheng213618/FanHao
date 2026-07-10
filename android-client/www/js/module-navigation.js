export async function loadModuleCatalog(fetchModules) {
  const payload = await fetchModules();
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  return modules
    .filter((module) => module && typeof module === "object" && module.id && module.title)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

export function renderAndroidModuleNavigation(container, modules) {
  if (!container) return [];
  const androidModules = modules.filter((module) => module.client?.android);
  if (!androidModules.length) return [...container.querySelectorAll("button")];

  const fragment = document.createDocumentFragment();
  for (const module of androidModules) {
    const surface = module.client.android;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.moduleId = module.id;
    button.dataset.bottomKey = surface.bottomKey || module.id;
    if (module.id === "fanhao") button.dataset.fanhaoHome = "";
    else if (surface.channel) button.dataset.openChannel = surface.channel;
    else if (surface.view) button.dataset.openView = surface.view;

    const label = document.createElement("span");
    label.textContent = module.title;
    button.append(label);
    fragment.append(button);
  }

  container.replaceChildren(fragment);
  return [...container.querySelectorAll("button")];
}
