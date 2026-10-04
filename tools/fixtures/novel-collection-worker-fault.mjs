// Only used by the temporary, synthetic collection Worker fixture.
import { parentPort, workerData } from "node:worker_threads";
const send = parentPort.postMessage.bind(parentPort);
let taskRequest = null;
parentPort.on("message", (message) => {
  if (message.type === "request" && message.method === "createTask") taskRequest = message.id;
});
parentPort.postMessage = (message) => {
  if (workerData.fixtureFault === "commit-no-reply" && message.type === "result" && message.id === taskRequest && message.ok) {
    process.exit(7);
  }
  send(message);
  if (workerData.fixtureFault === "exit-on-import" && message.type === "import") process.exit(9);
  if (workerData.fixtureFault === "exit-with-child" && message.type === "child-spawn" && message.args.includes("--result")) {
    process.exit(8);
  }
};
await import("../../src/modules/novels/server/collection-worker.js");
