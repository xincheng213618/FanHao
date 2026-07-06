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

  function serveRangedFile(req, res, file) {
    const stat = safeStat(file.path);
    if (!stat) {
      notFound(res);
      return;
    }

    const range = parseRange(req.headers.range, stat.size);
    const contentType = mimeTypes[file.ext] || "application/octet-stream";
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
    pipeFileRange(req, res, file.path, responseRange);
  }

  return {
    serveInlineFile,
    serveRangedFile
  };
}
