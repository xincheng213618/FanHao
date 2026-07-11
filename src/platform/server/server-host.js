import http from "node:http";
import os from "node:os";

export function createServerHost({
  requestHandler,
  port,
  host,
  getLibraryState,
  stop,
  logger = console,
  processRef = process,
  createServer = http.createServer,
  networkInterfaces = os.networkInterfaces,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  shutdownTimeoutMs = 5000
}) {
  const server = createServer(requestHandler);
  let shuttingDown = false;
  let signalsInstalled = false;

  const onSigint = () => shutdown("SIGINT");
  const onSigterm = () => shutdown("SIGTERM");

  function getLanAddresses() {
    const addresses = [];
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) {
          addresses.push(entry.address);
        }
      }
    }
    return addresses;
  }

  function installSignalHandlers() {
    if (signalsInstalled) return;
    signalsInstalled = true;
    processRef.once("SIGINT", onSigint);
    processRef.once("SIGTERM", onSigterm);
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] ${signal}`);
    const forceTimer = setTimeoutFn(() => processRef.exit(1), shutdownTimeoutMs);
    forceTimer.unref?.();
    server.close(async () => {
      try {
        await stop();
        clearTimeoutFn(forceTimer);
        processRef.exit(0);
      } catch (error) {
        logger.error("[shutdown]", error);
        processRef.exit(1);
      }
    });
  }

  function listen() {
    installSignalHandlers();
    server.listen(port, host, () => {
      logger.log(`Local:   http://127.0.0.1:${port}`);
      for (const address of getLanAddresses()) {
        logger.log(`LAN:     http://${address}:${port}`);
      }
      const library = getLibraryState();
      logger.log(`Library: ${library.availableRoots.join("; ")}`);
      if (library.missingRoots.length) {
        logger.log(`Missing: ${library.missingRoots.join("; ")}`);
      }
    });
    return server;
  }

  return { getLanAddresses, listen, server, shutdown };
}
