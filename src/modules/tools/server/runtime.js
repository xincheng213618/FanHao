import { routeToolsApi } from "./routes.js";
import { createTxtFormatToolService } from "./txt-format-service.js";

export function createToolsRuntime({
  cwd,
  maxBodyBytes,
  maxFileBytes,
  previewBytes,
  readJsonBody,
  requireLocalAdmin = () => true,
  sendJson,
  toolDownloadDir,
  ttlMs
}) {
  const txtFormatToolService = createTxtFormatToolService({
    cwd,
    maxBodyBytes,
    maxFileBytes,
    previewBytes,
    sendJson,
    toolDownloadDir,
    ttlMs
  });
  const deps = { readJsonBody, requireLocalAdmin, sendJson, txtFormatToolService };

  async function routeApi(req, res, url) {
    return routeToolsApi(req, res, url, deps);
  }

  return {
    routeApi,
    start: () => txtFormatToolService.cleanup()
  };
}
