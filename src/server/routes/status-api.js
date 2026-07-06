export async function routeStatusApi(req, res, url, deps) {
  const {
    getLastScanError,
    library,
    requestAccess,
    sendJson
  } = deps;

  if (url.pathname === "/api/health" && req.method === "GET") {
    const lastScanError = getLastScanError();
    sendJson(res, 200, {
      ok: true,
      scannedAt: library.scannedAt,
      totals: library.totals,
      availableRootCount: library.availableRoots.length,
      missingRootCount: library.missingRoots.length,
      access: requestAccess(req),
      lastScanError: lastScanError?.message || null
    });
    return true;
  }

  return false;
}
