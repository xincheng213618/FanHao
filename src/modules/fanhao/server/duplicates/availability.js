import fs from "node:fs/promises";
import path from "node:path";

const within = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

// Candidate metadata only: no media bytes, decoder, database writes or deletion.
export async function checkDuplicateAvailability(snapshot, roots = []) {
  const allowed = [...new Set(roots.map(root => path.resolve(root)))], rootStates = new Map();
  const unknown = message => ({ availabilityStatus: "unknown", availabilityError: message });
  function rootState(root) {
    if (!rootStates.has(root)) rootStates.set(root, (async () => {
      try { return (await fs.stat(root)).isDirectory() ? { root, real: await fs.realpath(root) } : null; }
      catch { return null; }
    })());
    return rootStates.get(root);
  }
  async function projectedPath(location) {
    let ancestor = location;
    for (;;) {
      try { await fs.lstat(ancestor); break; }
      catch (error) {
        const parent = path.dirname(ancestor);
        if (error.code !== "ENOENT" || parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    return path.resolve(await fs.realpath(ancestor), path.relative(ancestor, location));
  }
  async function inspect(file) {
    const location = path.resolve(file.path), candidates = allowed.filter(root => within(location, root));
    if (!candidates.length) return unknown("视频路径不在资料库根目录内，请重新扫描。");
    const online = (await Promise.all(candidates.map(rootState))).filter(Boolean);
    if (!online.length) return unknown("资料库磁盘或共享目录不可访问，文件状态待确认。");
    try {
      const stat = await fs.lstat(location);
      if (!stat.isFile() || stat.isSymbolicLink()) return unknown("目标不是普通视频文件，请检查路径。");
      const real = await fs.realpath(location);
      if (!online.some(root => within(real, root.real))) return unknown("视频路径经过链接后超出资料库范围。");
      if (stat.size !== Number(file.size) || file.modifiedAt && Math.abs(stat.mtimeMs - Date.parse(file.modifiedAt)) > 1) return unknown("视频文件信息已变化，请重新扫描后比对。");
      return { availabilityStatus: "available", availabilityError: "" };
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          const projected = await projectedPath(location);
          const authorized = online.filter(root => within(projected, root.real));
          if (!authorized.length) return unknown("视频路径经过链接后超出资料库范围。");
          // Recheck after resolving ancestors: a concurrently restored file or
          // newly offline disk must not be classified as a confirmed absence.
          try { await fs.lstat(location); return unknown("检查期间视频路径发生变化，请重试。"); }
          catch (again) { if (again.code !== "ENOENT") throw again; }
          if ((await Promise.all(authorized.map(async root => {
            try { return (await fs.stat(root.root)).isDirectory(); } catch { return false; }
          }))).some(Boolean)) return { availabilityStatus: "missing", availabilityError: "" };
        } catch { /* Keep uncertain or inaccessible paths visible for review. */ }
      }
      return unknown("文件不可访问，请检查磁盘或重新扫描。");
    }
  }
  const entries = snapshot.groups.flatMap(group => group.files), results = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, entries.length) }, async () => {
    while (cursor < entries.length) { const file = entries[cursor++]; results.set(file, await inspect(file)); }
  }));
  return { ...snapshot, availability: { checkedAt: new Date().toISOString(), checkedFiles: entries.length },
    groups: snapshot.groups.map(group => ({ ...group, files: group.files.map(file => ({ ...file, ...results.get(file) })) })) };
}
