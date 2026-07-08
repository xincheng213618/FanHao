import fs from "node:fs";

export function parseRange(rangeHeader, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!match) return null;

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : size - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= size) {
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

    const range = parseRange(req.headers.range, stat.size);
    const contentType = mimeTypes[file.ext] || "application/octet-stream";

    if (req.method === "HEAD" && !range) {
      res.writeHead(200, {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": stat.size,
        "Cache-Control": "no-store",
        "Content-Disposition": "inline"
      });
      res.end();
      return;
    }

    const responseRange = range || {
      start: 0,
      end: Math.min(stat.size - 1, defaultChunkBytes - 1)
    };

    res.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${stat.size}`,
      "Content-Length": responseRange.end - responseRange.start + 1,
      "Cache-Control": "no-store",
      "Content-Disposition": "inline"
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
