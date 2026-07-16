import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";

const JSON_COMPRESSION_MIN_BYTES = 4 * 1024;

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const encoding = acceptedJsonEncoding(res, body.length);
  if (!encoding) {
    writeJson(res, status, body);
    return;
  }

  const finish = (error, compressed) => {
    if (res.destroyed || res.writableEnded) return;
    if (error) {
      writeJson(res, status, body);
      return;
    }
    writeJson(res, status, compressed, encoding);
  };
  if (encoding === "br") {
    brotliCompress(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4
      }
    }, finish);
    return;
  }
  gzip(body, { level: 5 }, finish);
}

function acceptedJsonEncoding(res, size) {
  if (size < JSON_COMPRESSION_MIN_BYTES) return "";
  const accepted = String(res.req?.headers?.["accept-encoding"] || "").toLowerCase();
  const brotliQuality = acceptedEncodingQuality(accepted, "br");
  const gzipQuality = acceptedEncodingQuality(accepted, "gzip");
  if (brotliQuality <= 0 && gzipQuality <= 0) return "";
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

function acceptedEncodingQuality(header, encoding) {
  let wildcardQuality = 0;
  for (const item of header.split(",")) {
    const [rawName, ...params] = item.trim().split(";");
    const name = rawName.trim();
    if (name !== encoding && name !== "*") continue;
    const qualityParam = params.find((param) => param.trim().startsWith("q="));
    const quality = qualityParam ? Number(qualityParam.trim().slice(2)) : 1;
    const normalizedQuality = Number.isFinite(quality) ? Math.max(0, Math.min(1, quality)) : 0;
    if (name === encoding) return normalizedQuality;
    wildcardQuality = normalizedQuality;
  }
  return wildcardQuality;
}

function writeJson(res, status, body, encoding = "") {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    ...(encoding ? { "Content-Encoding": encoding, Vary: "Accept-Encoding" } : {})
  });
  res.end(body);
}

export function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(html),
    ...headers
  });
  res.end(html);
}

export function redirect(res, location, status = 303, headers = {}) {
  res.writeHead(status, {
    Location: location,
    "Cache-Control": "no-store",
    ...headers
  });
  res.end();
}

export function notFound(res) {
  sendJson(res, 404, { error: "Not found" });
}
