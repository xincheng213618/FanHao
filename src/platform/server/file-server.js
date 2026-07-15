import fs from "node:fs";

export function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  const sizeValue = Math.max(0, Number(size || 0) || 0);
  if (!sizeValue || (!match[1] && !match[2])) return null;

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    return {
      start: Math.max(0, sizeValue - suffixLength),
      end: sizeValue - 1
    };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : sizeValue - 1;
  const end = Math.min(requestedEnd, sizeValue - 1);

  if (!Number.isFinite(start) || !Number.isFinite(requestedEnd) || start > end || start < 0 || start >= sizeValue) {
    return null;
  }

  return { start, end };
}

export function pipeFileRange(req, res, filePath, range) {
  const stream = fs.createReadStream(filePath, range);
  let closed = false;
  const closeStream = () => {
    if (closed) return;
    closed = true;
    stream.destroy();
  };

  req.on("aborted", closeStream);
  res.on("close", closeStream);
  stream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end();
  });
  stream.pipe(res);
}

export function createFileServer({ defaultChunkBytes, mimeTypes, normalizeExt, notFound, safeStat }) {
  function attachmentDisposition(fileName = "download") {
    const fallback = String(fileName || "download").replace(/[^\w.-]+/g, "_").slice(0, 180) || "download";
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(String(fileName || fallback))}`;
  }

  function serveInlineFile(res, filePath, contentType = "") {
    const stat = safeStat(filePath);
    if (!stat?.isFile()) {
      notFound(res);
      return false;
    }

    const ext = normalizeExt(filePath);
    res.writeHead(200, {
      "Content-Type": contentType || mimeTypes[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": "inline"
    });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }

  function serveDownloadFile(req, res, file, fileName = "") {
    const stat = safeStat(file?.path);
    if (!stat?.isFile()) {
      notFound(res);
      return false;
    }

    const ext = file.ext || normalizeExt(file.path);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "Content-Disposition": attachmentDisposition(fileName || file.name || file.fileName || "download")
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    fs.createReadStream(file.path).pipe(res);
    return true;
  }

  function serveRangedFile(req, res, file) {
    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
      return;
    }

    // A short-video startup cache may contain only the first chunk while still
    // representing the original media entity. Keep the HTTP range total and
    // validators tied to that original entity, but never read past the cached
    // physical prefix.
    const entitySize = Math.max(stat.size, Math.floor(Number(file.totalSize || 0)) || 0);
    const entityMtimeMs = Math.max(0, Number(file.entityMtimeMs || stat.mtimeMs || 0));
    const entityMtime = new Date(entityMtimeMs || stat.mtimeMs || Date.now());
    const requestedRange = parseRange(req.headers.range, entitySize);
    const maxRangeBytes = Math.max(0, Math.floor(Number(file.maxRangeBytes || 0)));
    const range = requestedRange && maxRangeBytes
      ? {
          start: requestedRange.start,
          end: Math.min(requestedRange.end, requestedRange.start + maxRangeBytes - 1)
        }
      : requestedRange;
    const contentType = mimeTypes[file.ext] || "application/octet-stream";
    const cacheControl = String(file.cacheControl || "").trim() || "no-store";
    const responseHeaders = file.responseHeaders && typeof file.responseHeaders === "object"
      ? file.responseHeaders
      : {};
    const validators = {
      ETag: `"${entitySize.toString(16)}-${Math.floor(entityMtimeMs).toString(16)}"`,
      "Last-Modified": entityMtime.toUTCString()
    };

    if (req.method === "HEAD" && !range) {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": entitySize,
        "Cache-Control": cacheControl,
        "Content-Disposition": "inline",
        ...validators,
        ...responseHeaders
      });
      res.end();
      return;
    }

    const requestedResponseRange = range || {
      start: 0,
      end: file.fullResponse ? entitySize - 1 : Math.min(entitySize - 1, defaultChunkBytes - 1)
    };
    const responseRange = {
      start: requestedResponseRange.start,
      end: Math.min(requestedResponseRange.end, stat.size - 1)
    };

    res.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${entitySize}`,
      "Content-Length": responseRange.end - responseRange.start + 1,
      "Cache-Control": cacheControl,
      "Content-Disposition": "inline",
      ...validators,
      ...responseHeaders
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    pipeFileRange(req, res, file.path, responseRange);
  }

  return {
    serveDownloadFile,
    serveInlineFile,
    serveRangedFile
  };
}
