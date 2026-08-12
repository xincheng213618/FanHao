import fs from "node:fs";
import path from "node:path";

export class RequestBodyError extends Error {
  constructor(message, { code, statusCode }) {
    super(message);
    this.name = "RequestBodyError";
    this.code = code;
    this.statusCode = statusCode;
    this.expose = true;
  }
}

export function readBodyText(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let done = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      bodyBytes += Buffer.byteLength(chunk, "utf8");
      if (bodyBytes > maxBytes) {
        done = true;
        body = "";
        reject(new RequestBodyError("请求体太大", {
          code: "REQUEST_BODY_TOO_LARGE",
          statusCode: 413
        }));
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
    throw new RequestBodyError("JSON 格式无效", {
      code: "INVALID_JSON_BODY",
      statusCode: 400
    });
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
