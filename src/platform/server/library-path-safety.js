import fs from "node:fs";
import path from "node:path";

function isWithinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingAncestor(filePath) {
  let current = path.resolve(filePath);
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function projectedRealPath(filePath) {
  const fullPath = path.resolve(filePath);
  const ancestor = existingAncestor(fullPath);
  const realAncestor = fs.realpathSync.native(ancestor);
  return path.resolve(realAncestor, path.relative(ancestor, fullPath));
}

export function ensureRealPathWithinRoots(filePath, roots, label = "文件夹") {
  const fullPath = path.resolve(String(filePath || ""));
  const allowedRoots = (Array.isArray(roots) ? roots : [])
    .map((root) => String(root || "").trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));
  const lexicalRoots = allowedRoots.filter((root) => isWithinRoot(fullPath, root));
  if (!lexicalRoots.length) {
    const error = new Error(`${label}不在资料库根目录内`);
    error.statusCode = 400;
    throw error;
  }

  const realCandidate = projectedRealPath(fullPath);
  const physicallyAllowed = lexicalRoots.some((root) => isWithinRoot(realCandidate, projectedRealPath(root)));
  if (!physicallyAllowed) {
    const error = new Error(`${label}经过链接后逃出资料库根目录`);
    error.statusCode = 400;
    throw error;
  }
  return fullPath;
}
