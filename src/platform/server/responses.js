import { constants as zlibConstants, brotliCompress, gzip } from "node:zlib";

const JSON_COMPRESSION_MIN_BYTES = 4 * 1024;

export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const { encoding, identityAllowed } = acceptedJsonEncoding(res, body.length);
  if (encoding === null) {
    writeJson(res, 406, Buffer.alloc(0));
    return;
  }
  if (!encoding) {
    writeJson(res, status, body);
    return;
  }

  const finish = (error, compressed) => {
    if (res.destroyed || res.writableEnded) return;
    if (error) {
      // A compressor failure may only fall back to a representation the
      // client accepts. Negotiation succeeded, so this is not a 406.
      writeJson(res, identityAllowed ? status : 500, identityAllowed ? body : Buffer.alloc(0));
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
  const accepted = String(res.req?.headers?.["accept-encoding"] || "").trim().toLowerCase();
  const qualities = new Map();
  for (const entry of accepted.split(",")) {
    const [name, ...parameters] = entry.split(";");
    const coding = name.trim();
    if (!["br", "gzip", "identity", "*"].includes(coding)) continue;
    const weight = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameters.join(";").trim());
    const quality = parameters.length ? (weight ? Number(weight[1]) : 0) : 1;
    // Match static responses: malformed or duplicate preferences cannot undo q=0.
    qualities.set(coding, Math.min(qualities.get(coding) ?? 1, quality));
  }
  let encoding = "", quality = 0;
  if (size >= JSON_COMPRESSION_MIN_BYTES) {
    for (const coding of ["br", "gzip"]) {
      const candidate = qualities.get(coding) ?? qualities.get("*") ?? 0;
      if (candidate > quality) { encoding = coding; quality = candidate; }
    }
  }
  // Implicit identity is a fallback. An explicit preference competes by
  // weight, while *;q=0 also excludes identity unless explicitly allowed.
  const identity = qualities.get("identity") ?? (qualities.get("*") === 0 ? 0 : 1);
  const identityAllowed = identity > 0;
  if (quality > 0 && (!qualities.has("identity") || quality >= identity)) return { encoding, identityAllowed };
  return { encoding: identityAllowed ? "" : null, identityAllowed };
}

function writeJson(res, status, body, encoding = "") {
  const vary = String(res.getHeader?.("Vary") || "").split(",").map(value => value.trim()).filter(Boolean);
  if (!vary.some(value => value === "*" || value.toLowerCase() === "accept-encoding")) vary.push("Accept-Encoding");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
    Vary: vary.join(", "),
    ...(encoding ? { "Content-Encoding": encoding } : {})
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
