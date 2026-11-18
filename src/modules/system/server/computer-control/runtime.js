import { routeComputerControlApi } from "./routes.js";
import { createComputerControlService } from "./service.js";
import { createComputerControlSettings } from "./settings.js";

export function createComputerControlRuntime({
  canUseLanGuestSleep = () => false,
  readJsonBody,
  requireLocalAdmin,
  sendJson,
  service = createComputerControlService()
}) {
  const deps = {
    canUseLanGuestSleep,
    computerControlService: service,
    readJsonBody,
    requireLocalAdmin,
    sendJson
  };

  async function routeApi(req, res, url) {
    return routeComputerControlApi(req, res, url, deps);
  }

  return {
    routeApi,
    settings: createComputerControlSettings(service)
  };
}
