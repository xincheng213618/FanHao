const BRAND_MODES = Object.freeze([
  { view: "studios", label: "片商" },
  { view: "codePrefixes", label: "前缀" }
]);

export function createBrandModeSwitch(activeView, showView) {
  const navigation = document.createElement("nav");
  navigation.className = "fanhao-brand-switch";
  navigation.setAttribute("aria-label", "厂牌浏览方式");

  for (const mode of BRAND_MODES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = mode.label;
    const active = mode.view === activeView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.addEventListener("click", () => {
      if (active) return;
      showView(mode.view, {}, { skipHistory: true, replaceHistory: true });
    });
    navigation.append(button);
  }

  return navigation;
}
