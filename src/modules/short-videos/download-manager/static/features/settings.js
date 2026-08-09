import { post } from "../core/api.js";
import { $, toast } from "../core/dom.js";

export function createSettingsFeature(options = {}) {
  const onRefreshLinks = options.onRefreshLinks || (() => Promise.resolve());
  const dirtyInputs = new Set();
  let saveTimer = null;

  function setInputValue(id, value, inputOptions = {}) {
    const node = $(id);
    if (!node || document.activeElement === node) return;
    if (!inputOptions.force && dirtyInputs.has(id)) return;
    node.value = value;
  }

  function markClean(id) {
    dirtyInputs.delete(id);
  }

  function markDirty(id) {
    dirtyInputs.add(id);
  }

  function snapshot() {
    return {
      profile_url: $("profileUrl").value.trim(),
      profile_tab: "auto",
      library_output_dir: $("libraryPath").value.trim(),
      download_proxy: $("downloadProxy").value.trim(),
      concurrency: $("concurrencyNumber").value || $("concurrency").value,
      scrolls: $("scrolls").value,
      idle_rounds: $("idleRounds").value,
      incremental_stop_existing: $("incrementalStopExisting").value,
      download_cycle_limit: $("downloadCycleLimit")?.value || 350,
      download_cycle_cooldown_minutes: $("downloadCycleCooldownMinutes")?.value || 30,
      failure_guard_threshold: $("failureGuardThreshold").value,
    };
  }

  function persist(payload = snapshot()) {
    return post("/api/settings", payload);
  }

  async function save() {
    const payload = snapshot();
    await persist(payload);
    Object.keys(payload).forEach((key) => {
      if (key === "profile_url") markClean("profileUrl");
      if (key === "library_output_dir") markClean("libraryPath");
      if (key === "download_proxy") markClean("downloadProxy");
      if (key === "scrolls") markClean("scrolls");
      if (key === "idle_rounds") markClean("idleRounds");
      if (key === "incremental_stop_existing") markClean("incrementalStopExisting");
      if (key === "failure_guard_threshold") markClean("failureGuardThreshold");
      if (key === "concurrency") {
        markClean("concurrency");
        markClean("concurrencyNumber");
      }
    });
    toast("设置已保存");
    onRefreshLinks().catch(() => {});
    return payload;
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      save().catch((err) => toast(err.message));
    }, 450);
  }

  function setConcurrency(value, shouldSave = true) {
    const parsed = Math.max(1, Math.min(24, Number(value) || 1));
    $("concurrency").value = String(parsed);
    $("concurrencyNumber").value = String(parsed);
    $("concurrencyValue").textContent = String(parsed);
    if (shouldSave) saveSoon();
  }

  function bind() {
    [
      "profileUrl",
      "libraryPath",
      "downloadProxy",
      "scrolls",
      "idleRounds",
      "incrementalStopExisting",
      "downloadCycleLimit",
      "downloadCycleCooldownMinutes",
      "failureGuardThreshold",
      "concurrency",
      "concurrencyNumber",
    ].forEach((id) => {
      const node = $(id);
      if (!node) return;
      node.addEventListener("input", () => dirtyInputs.add(id));
    });
    $("concurrency").addEventListener("input", () => {
      setConcurrency($("concurrency").value);
    });
    $("concurrencyNumber").addEventListener("input", () => {
      setConcurrency($("concurrencyNumber").value);
    });
    $("saveSettings").addEventListener("click", () => save().catch((err) => toast(err.message)));
  }

  function render(state) {
    const settings = state.settings || {};
    setInputValue("profileUrl", settings.profile_url || "");
    setInputValue("libraryPath", settings.library_output_dir || state.paths?.library || state.paths?.manifest?.replace(/\\download_manifest\.jsonl$/i, "") || "");
    setInputValue("downloadProxy", settings.download_proxy || "");
    setInputValue("scrolls", settings.scrolls || 12000);
    setInputValue("idleRounds", settings.idle_rounds || 160);
    setInputValue("incrementalStopExisting", settings.incremental_stop_existing || 12);
    setInputValue("downloadCycleLimit", settings.download_cycle_limit || state.download?.cycle?.limit || 350);
    setInputValue("downloadCycleCooldownMinutes", settings.download_cycle_cooldown_minutes || state.download?.cycle?.cooldown_minutes || 30);
    setInputValue("failureGuardThreshold", settings.failure_guard_threshold || state.download?.failure_guard?.threshold || 10);
    setInputValue("concurrency", settings.concurrency || 8);
    setInputValue("concurrencyNumber", settings.concurrency || 8);
    $("concurrencyValue").textContent = $("concurrencyNumber").value || settings.concurrency || 8;
  }

  return { bind, render, snapshot, persist, save, markClean, markDirty };
}
