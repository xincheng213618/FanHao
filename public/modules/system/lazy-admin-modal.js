const ADMIN_MODAL_METHODS = Object.freeze([
  "closeModal",
  "generateMissingCovers",
  "importActorAvatars",
  "loadScripts",
  "openCompilationConfig",
  "openModal",
  "previewActorAvatarCandidates",
  "refreshActorMovies",
  "refreshRankings",
  "renderScripts",
  "rescanSelectedPerson",
  "runSelectedScript",
  "saveCompilationConfigData"
]);

export function createLazyAdminModal(loadAdminModal) {
  let instancePromise = null;

  function load() {
    if (!instancePromise) {
      instancePromise = Promise.resolve()
        .then(loadAdminModal)
        .then((instance) => {
          if (!instance) throw new Error("后台控制台加载失败");
          return instance;
        })
        .catch((error) => {
          instancePromise = null;
          throw error;
        });
    }
    return instancePromise;
  }

  const lazyModal = { load };
  for (const method of ADMIN_MODAL_METHODS) {
    lazyModal[method] = (...args) => load().then((instance) => instance[method](...args));
  }
  return lazyModal;
}

export function bindLazyAdminModal({ adminModal, els, openAdminScript, state }) {
  els.topRescanButton?.addEventListener("click", () => openAdminScript(""));
  for (const trigger of [els.topRescanButton, els.compilationConfigButton]) {
    trigger?.addEventListener("pointerenter", () => adminModal.load().catch(() => {}), { once: true });
    trigger?.addEventListener("focus", () => adminModal.load().catch(() => {}), { once: true });
  }

  els.closeAdmin?.addEventListener("click", adminModal.closeModal);
  els.adminBackdrop?.addEventListener("click", adminModal.closeModal);
  els.adminRescanPerson?.addEventListener("click", adminModal.rescanSelectedPerson);
  els.adminRefreshActor?.addEventListener("click", adminModal.refreshActorMovies);
  els.adminRefreshRankings?.addEventListener("click", adminModal.refreshRankings);
  els.adminPreviewActorAvatars?.addEventListener("click", adminModal.previewActorAvatarCandidates);
  els.adminImportActorAvatars?.addEventListener("click", adminModal.importActorAvatars);
  els.adminGenerateCovers?.addEventListener("click", adminModal.generateMissingCovers);
  els.adminScriptForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    adminModal.runSelectedScript(event);
  });
  els.adminRefreshScripts?.addEventListener("click", adminModal.loadScripts);
  els.adminScriptCategory?.addEventListener("change", () => {
    state.adminScriptCategory = els.adminScriptCategory.value || "all";
    adminModal.renderScripts();
  });
  els.compilationConfigButton?.addEventListener("click", adminModal.openCompilationConfig);
}
