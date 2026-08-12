import http from "node:http";
import os from "node:os";

export function createServerHost({
  requestHandler,
  port,
  host,
  getLibraryState,
  beginStop = async () => {},
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
  let shutdownPromise = null;
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
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    logger.log(`[shutdown] ${signal}`);
    const forceTimer = setTimeoutFn(() => processRef.exit(1), shutdownTimeoutMs);
    forceTimer.unref?.();

    // close() synchronously stops accepting new connections. The pre-close
    // hook can then cancel long-running work so existing requests are able to
    // drain before the full module shutdown runs.
    const serverClosed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    shutdownPromise = (async () => {
      let shutdownError = null;
      try {
        await beginStop();
      } catch (error) {
        shutdownError = error;
        logger.error("[shutdown:begin]", error);
      }
      try {
        await serverClosed;
      } catch (error) {
        shutdownError ||= error;
        logger.error("[shutdown:drain]", error);
      }
      try {
        await stop();
      } catch (error) {
        shutdownError ||= error;
        logger.error("[shutdown:stop]", error);
      }
      clearTimeoutFn(forceTimer);
      processRef.exit(shutdownError ? 1 : 0);
    })();
    return shutdownPromise;
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
