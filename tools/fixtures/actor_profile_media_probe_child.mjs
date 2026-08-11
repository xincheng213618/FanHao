import { createMediaBlobWorkerClient } from "../../src/platform/server/media-blob-worker-client.js";

const [mainDbPath, imageDbPath, personId, operationId] = process.argv.slice(2);
const client = createMediaBlobWorkerClient({ dbPath: mainDbPath, imageDbPath });
try {
  const row = await client.actorAvatar(Number(personId), operationId);
  const wrong = await client.actorAvatar(Number(personId), "wrong-operation");
  console.log(JSON.stringify({ bytes: Buffer.from(row?.image_blob || []).toString(), wrong }));
} finally {
  await client.close();
}
