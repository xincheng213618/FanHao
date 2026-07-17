export function createLazyPersonProfile({ els, loadPersonProfile, onLoadError = () => {} }) {
  let instancePromise = null;
  let renderVersion = 0;

  function load() {
    if (!instancePromise) {
      instancePromise = Promise.resolve()
        .then(loadPersonProfile)
        .then((instance) => {
          if (!instance) throw new Error("人物资料组件加载失败");
          return instance;
        })
        .catch((error) => {
          instancePromise = null;
          throw error;
        });
    }
    return instancePromise;
  }

  function hide() {
    renderVersion += 1;
    if (!els.personProfile) return;
    els.personProfile.hidden = true;
    els.personProfile.classList.remove("ranking-profile-panel");
    els.personProfile.innerHTML = "";
  }

  function render(person) {
    const version = ++renderVersion;
    return load()
      .then((instance) => {
        if (version !== renderVersion) return;
        instance.render(person);
      })
      .catch((error) => {
        if (version === renderVersion) onLoadError(error);
      });
  }

  return { hide, load, render };
}
