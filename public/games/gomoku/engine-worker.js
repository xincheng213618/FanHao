let engineInstance = null;
let initializing = false;
const engineHashes = {
  "rapfi-single.js": "d5991f22fe6b2442c76eb0637e5eae5595c858930f3f4585e8a8d86c8b3771c1",
  "rapfi-single.wasm": "20bb495aff65ff3e7ebc46e70890e9d1f98bf5023ee0e2c7378651f5f36a5820",
  "rapfi.data": "2fa58b1c9e005a7b39bbddb798097a8f1ff9ceaba4c9339d87ba7d324b9d846d"
};

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type === "init") {
    await initializeEngine();
    return;
  }
  if (message.type === "command" && engineInstance) {
    engineInstance.sendCommand(String(message.command || ""));
  }
};

async function initializeEngine() {
  if (engineInstance || initializing) return;
  initializing = true;
  try {
    self.importScripts(versionedAssetUrl("rapfi-single.js"));
    const wasmMemory = new WebAssembly.Memory({
      initial: 64 * 1024 * 1024 / 65536,
      maximum: 2 * 1024 * 1024 * 1024 / 65536,
      shared: false
    });
    engineInstance = await self.Rapfi({
      locateFile(fileName) {
        const normalized = /^rapfi.*\.data$/i.test(fileName) ? "rapfi.data" : fileName;
        return versionedAssetUrl(normalized);
      },
      onReceiveStdout(line) {
        self.postMessage({ type: "stdout", line });
      },
      onReceiveStderr(line) {
        self.postMessage({ type: "stderr", line });
      },
      onExit(code) {
        self.postMessage({ type: "exit", code });
      },
      setStatus(status) {
        self.postMessage({ type: "status", status });
      },
      wasmMemory
    });
    self.postMessage({ type: "ready" });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    initializing = false;
  }
}

function versionedAssetUrl(fileName) {
  const url = new URL(`./engine/${fileName}`, self.location.href);
  const hash = engineHashes[fileName];
  if (hash) url.searchParams.set("v", `sha256-${hash}`);
  return url.href;
}
