import path from "node:path";

export function createLibraryPathServices({ libraryRoots, extraOpenRoots = [], getAvailableRoots = () => [] }) {
  function rootLabel(rootPath) {
    return rootPath.replace(/[\\/]+$/, "").replaceAll(path.sep, "/");
  }

  function relativeFromRoot(fullPath) {
    const matchingRoot = [...libraryRoots]
      .sort((a, b) => b.length - a.length)
      .find((rootPath) => {
        const relative = path.relative(rootPath, fullPath);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      });

    if (!matchingRoot) {
      return fullPath.replaceAll(path.sep, "/");
    }

    const relative = path.relative(matchingRoot, fullPath).replaceAll(path.sep, "/");
    const label = rootLabel(matchingRoot);
    return relative ? `${label}/${relative}` : label;
  }

  function sourcePathToAbsolute(sourcePath) {
    const raw = String(sourcePath || "").trim();
    if (!raw) return "";
    return path.resolve(raw.replaceAll("/", path.sep));
  }

  function pathWithinRoot(targetPath, rootPath) {
    const target = path.resolve(targetPath).toLowerCase();
    const root = path.resolve(rootPath).toLowerCase();
    const relative = path.relative(root, target);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function libraryOpenRoots() {
    return [...new Set([...(getAvailableRoots() || []), ...libraryRoots, ...extraOpenRoots])];
  }

  return {
    libraryOpenRoots,
    pathWithinRoot,
    relativeFromRoot,
    rootLabel,
    sourcePathToAbsolute
  };
}
