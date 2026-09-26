import path from "node:path";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { createFileWorkflowService } from "../src/modules/fanhao/server/workflows/file-workflow-service.js";

// The CLI and Web UI share one plan/journal protocol. No legacy hard-coded
// drive list, overwrite, duplicate removal or online metadata request is run.
const { values } = parseArgs({ options: {
  "data-dir": { type: "string" }, root: { type: "string", multiple: true },
  "core-db": { type: "string" },
  source: { type: "string" }, target: { type: "string" }, kind: { type: "string", default: "organize" },
  run: { type: "string" }, help: { type: "boolean" }
} });
if (values.help || !values["data-dir"] || !values["core-db"] || !values.root?.length) {
  console.log("Preview: node tools/fanhao_file_workflows.mjs --data-dir <state> --core-db <catalogue> --root <allowed> --source <source> --target <target> --kind organize|migrate\nExecute approved plan: same --data-dir, --core-db and --root options, with --run <plan-id>\nThe initialized core database is opened read-only to protect indexed files. Move indexed works through the application.");
  process.exitCode = values.help ? 0 : 2;
} else {
  const db = new DatabaseSync(path.resolve(values["core-db"]), { readOnly: true });
  const indexedPaths = () => db.prepare("SELECT file_path FROM local_files").all().map((row) => row.file_path);
  const service = createFileWorkflowService({ dataDir: path.resolve(values["data-dir"]), roots: values.root, indexedPaths });
  try {
    if (values.run) {
      let job = service.run(values.run);
      while (["running", "stopping"].includes(job.status)) { await delay(300); job = service.detail(job.id); }
      console.log(JSON.stringify(job, null, 2));
      if (job.status !== "completed") process.exitCode = 1;
    } else {
      console.log(JSON.stringify(await service.preview(values), null, 2));
    }
  } finally { await service.close(); db.close(); }
}
