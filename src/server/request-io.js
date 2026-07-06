import fs from "node:fs";
import path from "node:path";

export function readBodyText(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let done = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > maxBytes) {
        done = true;
        reject(new Error("请求体太大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(body);
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

export async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const body = await readBodyText(req, maxBytes);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("JSON 格式无效");
  }
}

export function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function safeChildPath(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const normalizedRelative = String(relativePath || "").replace(/[\\/]+/g, path.sep);
  const target = path.resolve(root, normalizedRelative);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return target;
}
