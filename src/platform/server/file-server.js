import fs from "node:fs";

export function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || "").trim());
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

function normalizedEntityMtimeMs(file, stat) {
  for (const value of [file?.entityMtimeMs, stat?.mtimeMs, file?.cacheVersion]) {
    if (value === null || value === undefined || value === "") continue;
    const candidate = Number(value);
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function normalizedEntityTag(value) {
  const candidate = String(value || "").trim();
  if (!candidate || /[\r\n]/.test(candidate)) return "";
  return /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(candidate) ? candidate : "";
}

export function entityValidators(file, stat, entitySize = Number(stat?.size || 0)) {
  const size = Math.max(0, Math.floor(Number(entitySize || 0)) || 0);
  const mtimeMs = normalizedEntityMtimeMs(file, stat);
  const explicitTag = normalizedEntityTag(file?.entityTag);
  const versionMicros = Math.max(0, Math.round(mtimeMs * 1000));
  // Size and timestamps are revision hints, not byte identity. Only a caller
  // with a trusted entity tag may opt into a strong validator.
  const etag = explicitTag || `W/"${size.toString(16)}-${versionMicros.toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  return { ETag: etag, "Last-Modified": lastModified };
}

export function ifRangeMatches(ifRangeHeader, validators) {
  const candidate = String(ifRangeHeader || "").trim();
  if (!candidate) return true;
  if (/^W\//i.test(candidate)) return false;

  if (candidate.startsWith('"')) {
    const etag = String(validators?.ETag || "");
    return Boolean(etag) && !/^W\//i.test(etag) && candidate === etag;
  }

  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(candidate)) {
    return false;
  }
  const candidateTime = Date.parse(candidate);
  const lastModifiedTime = Date.parse(String(validators?.["Last-Modified"] || ""));
  return Number.isFinite(candidateTime)
    && Number.isFinite(lastModifiedTime)
    && lastModifiedTime <= candidateTime;
}

function diagnosticResponseHeaders(headers) {
  const protectedNames = new Set([
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-length",
    "content-range",
    "content-type",
    "etag",
    "last-modified"
  ]);
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([name]) => !protectedNames.has(String(name).toLowerCase()))
  );
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

export function createFileServer({ mimeTypes, normalizeExt, notFound, safeStat }) {
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
    const validators = entityValidators(file, stat, entitySize);
    const rangeHeader = String(req.headers?.range || "").trim();
    const ifRangeHeader = String(req.headers?.["if-range"] || "").trim();
    const rangeConditionMatches = !ifRangeHeader || ifRangeMatches(ifRangeHeader, validators);
    const requestedRange = rangeHeader && rangeConditionMatches
      ? parseRange(rangeHeader, entitySize)
      : null;
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
      ? diagnosticResponseHeaders(file.responseHeaders)
      : {};

    if (rangeHeader && rangeConditionMatches && !requestedRange) {
      res.writeHead(416, {
        ...responseHeaders,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${entitySize}`,
        "Content-Length": 0,
        "Cache-Control": cacheControl,
        "Content-Disposition": "inline",
        ...validators
      });
      res.end();
      return;
    }

    if (!range) {
      // A physical startup-prefix file cannot satisfy a full representation.
      // Callers must fall back to the source entity when If-Range fails.
      if (stat.size < entitySize) {
        res.writeHead(503, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": 0,
          "Cache-Control": "no-store"
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        ...responseHeaders,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": entitySize,
        "Cache-Control": cacheControl,
        "Content-Disposition": "inline",
        ...validators
      });
      if (req.method === "HEAD" || stat.size === 0) {
        res.end();
        return;
      }
      pipeFileRange(req, res, file.path);
      return;
    }

    if (range.start >= stat.size) {
      res.writeHead(503, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": 0,
        "Cache-Control": "no-store"
      });
      res.end();
      return;
    }

    const responseRange = {
      start: range.start,
      end: Math.min(range.end, stat.size - 1)
    };

    res.writeHead(206, {
      ...responseHeaders,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${entitySize}`,
      "Content-Length": responseRange.end - responseRange.start + 1,
      "Cache-Control": cacheControl,
      "Content-Disposition": "inline",
      ...validators
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
