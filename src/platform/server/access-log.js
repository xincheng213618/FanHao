import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
const SLOW_REQUEST_MS = 5_000;
const QUIET_MUSIC_PATH_PREFIXES = ["/media/music/", "/modules/music/"];
const QUIET_MUSIC_FILES = new Set(["/vendor/plyr/plyr.svg"]);

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
    range: String(req.headers.range || ""),
    responseRange: String(res.getHeader("Content-Range") || ""),
    responseLength: Number(res.getHeader("Content-Length") || 0),
    userAgent: String(req.headers["user-agent"] || "").slice(0, 180)
  };
}

export function shouldWriteAccessLog(entry) {
  if (entry.status >= 400 || entry.ms >= SLOW_REQUEST_MS) return true;
  const pathname = String(entry.path || "").split("?", 1)[0];
  if (QUIET_MUSIC_FILES.has(pathname)) return false;
  return !QUIET_MUSIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function createAccessLogger({
  accessLogPath,
  maxBytes = DEFAULT_MAX_BYTES,
  maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES
}) {
  const backupPath = `${accessLogPath}.1`;
  let queuedLines = [];
  let queuedBytes = 0;
  let flushScheduled = false;
  let flushing = false;
  let currentBytes = 0;
  let droppedEntries = 0;

  try {
    fs.mkdirSync(path.dirname(accessLogPath), { recursive: true });
    currentBytes = fs.statSync(accessLogPath).size;
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("[access-log]", error.message || error);
  }

  async function rotateIfNeeded(incomingBytes) {
    if (currentBytes === 0 || currentBytes + incomingBytes <= maxBytes) return;
    await fs.promises.rm(backupPath, { force: true });
    try {
      await fs.promises.rename(accessLogPath, backupPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    currentBytes = 0;
  }

  async function appendLines(lines) {
    let output = "";
    let outputBytes = 0;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line);
      if (output && outputBytes + lineBytes > maxBytes) {
        await rotateIfNeeded(outputBytes);
        await fs.promises.appendFile(accessLogPath, output, "utf8");
        currentBytes += outputBytes;
        output = "";
        outputBytes = 0;
      }
      output += line;
      outputBytes += lineBytes;
    }
    if (!output) return;
    await rotateIfNeeded(outputBytes);
    await fs.promises.appendFile(accessLogPath, output, "utf8");
    currentBytes += outputBytes;
  }

  async function flush() {
    if (flushing) return;
    flushScheduled = false;
    flushing = true;
    try {
      while (queuedLines.length) {
        const lines = queuedLines;
        queuedLines = [];
        queuedBytes = 0;
        const dropped = droppedEntries;
        droppedEntries = 0;
        if (dropped > 0) {
          lines.unshift(`${JSON.stringify({
            time: new Date().toISOString(),
            type: "access-log-overflow",
            dropped
          })}\n`);
        }
        await appendLines(lines);
      }
    } catch (error) {
      console.warn("[access-log]", error.message || error);
    } finally {
      flushing = false;
      if (queuedLines.length) scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushScheduled || flushing) return;
    flushScheduled = true;
    setImmediate(flush);
  }

  function enqueue(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (queuedBytes + lineBytes > maxQueueBytes) {
      droppedEntries += 1;
      return;
    }
    queuedLines.push(line);
    queuedBytes += lineBytes;
    scheduleFlush();
  }

  return function attachAccessLogger(req, res, url, authState, startedAt) {
    res.on("finish", () => {
      const entry = accessLogEntry(req, res, url, authState, startedAt);
      if (shouldWriteAccessLog(entry)) enqueue(entry);
    });
  };
}
