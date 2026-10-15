import { pathToFileURL } from "node:url";
import { once } from "node:events";
const { serverHost } = await import(pathToFileURL(process.argv[2]).href);
if (!serverHost.server.listening) await once(serverHost.server, "listening");
process.send?.({ port: serverHost.server.address().port });
process.on("message", (message) => { if (message === "stop") serverHost.shutdown("fixture"); });
