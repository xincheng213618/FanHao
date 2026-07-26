const ADMIN_SECTIONS = new Set(["overview", "visitors", "scripts", "tasks", "maintenance", "settings"]);

export function adminUrl(section = "overview", options = {}) {
  const scriptId = String(options.scriptId || "").trim();
  const normalizedSection = scriptId ? "scripts" : (ADMIN_SECTIONS.has(section) ? section : "overview");
  const params = new URLSearchParams();
  if (scriptId) params.set("script", scriptId);

  const defaults = options.defaults || options.scriptDefaults;
  if (defaults && typeof defaults === "object" && Object.keys(defaults).length) {
    params.set("defaults", JSON.stringify(defaults));
  }

  return `/admin${params.size ? `?${params}` : ""}#${normalizedSection}`;
}
