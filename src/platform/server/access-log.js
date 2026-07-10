import fs from "node:fs";
import path from "node:path";

function accessLogEntry(req, res, url, authState, startedAt) {
  return {
    time: new Date().toISOString(),
    method: req.method,
    path: `${url.pathname}${url.search || ""}`,
    status: res.statusCode,
    ms: Date.now() - startedAt,
    host: authState.access.host,
    remote: authState.access.clientAddress,
    access: authState.access.mode,
    auth: authState.reason,
    userAgent: String(req.headers["user-agent"] || "").slice(0, 180)
  };
}

export function createAccessLogger({ accessLogPath }) {
  return function attachAccessLogger(req, res, url, authState, startedAt) {
    res.on("finish", () => {
      try {
        fs.mkdirSync(path.dirname(accessLogPath), { recursive: true });
        fs.appendFileSync(accessLogPath, `${JSON.stringify(accessLogEntry(req, res, url, authState, startedAt))}\n`, "utf8");
      } catch (error) {
        console.warn("[access-log]", error.message || error);
      }
    });
  };
}
