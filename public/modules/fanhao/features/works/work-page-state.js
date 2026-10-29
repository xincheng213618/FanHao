// The server slices records before this client removes overlapping work IDs.
// Keep that consumed-record cursor independent of the visible card count.
export function resolveWorkPage(data, { existingWorks = [], offset = 0, previousTotal = 0 } = {}) {
  const rows = Array.isArray(data?.works) ? data.works : [];
  const seen = new Set(existingWorks.map(work => String(work.id)));
  const works = [];
  for (const work of rows) {
    const id = work?.id == null ? "" : String(work.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    works.push(work);
  }
  const rawLoaded = offset + rows.length;
  const reportedTotal = data?.total == null ? NaN : Number(data.total);
  const total = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
    ? reportedTotal : Math.max(Number(previousTotal) || 0, rawLoaded);
  return { works, rawLoaded, total, hasMore: rows.length > 0 && rawLoaded < total };
}
