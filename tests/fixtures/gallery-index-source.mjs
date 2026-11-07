// These query fixtures control publication and revision races without filesystem I/O.
export function createGalleryIndexSource(read) {
  let snapshot;
  let revision = 0;
  return {
    getIndex({ refresh = false } = {}) {
      if (!snapshot || refresh) {
        const next = read();
        snapshot = refresh ? { ...next, photoSets: [], mediaItems: [] } : next;
        revision += 1;
      }
      return snapshot;
    },
    invalidate() {
      snapshot = undefined;
      revision += 1;
    },
    listRevision: () => String(revision)
  };
}
