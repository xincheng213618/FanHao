export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
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
