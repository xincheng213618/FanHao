export async function loadModuleCatalog(fetchModules) {
  const payload = await fetchModules();
  const modules = Array.isArray(payload?.modules) ? payload.modules : [];
  return modules
    .filter((module) => module && typeof module === "object" && module.id && module.title)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

export function renderWebModuleNavigation(container, modules) {
  if (!container) return [];
  const webModules = modules.filter((module) => module.client?.web);
  if (!webModules.length) return [...container.querySelectorAll("[data-product-view]")];

  const fragment = document.createDocumentFragment();
  for (const module of webModules) {
    const surface = module.client.web;
    const link = document.createElement("a");
    link.className = "product-tab";
    link.href = surface.href || "/";
    link.textContent = module.title;
    link.dataset.moduleId = module.id;
    link.dataset.moduleNavigation = "window";
    link.dataset.productView = surface.view || "people";
    link.target = "_blank";
    link.rel = "noopener";
    if (surface.galleryMode) link.dataset.galleryMode = surface.galleryMode;
    if (surface.peopleScope) link.dataset.peopleScope = surface.peopleScope;
    fragment.append(link);
  }

  container.replaceChildren(fragment);
  return [...container.querySelectorAll("[data-product-view]")];
}
