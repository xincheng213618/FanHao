import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { organizeGroup, saveOrganizationPlan, writeOrganizationSidecar, reserveOrganizationPaths, releaseOrganizationPaths, organizationMutationMode, cleanupOrganizationSidecars, cleanupOrganizationWorkCovers, setOrganizationFolderReleaseDate } from "../src/modules/fanhao/server/people/person-organization-service.js";

const { values } = parseArgs({ options: { plan: { type: "string" }, db: { type: "string" }, "image-db": { type: "string" } } });
const planFile = path.resolve(values.plan);
const lockFile = `${planFile}.lock`;
if (fs.existsSync(lockFile)) {
  const owner = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  let alive = true;
  try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  if (alive) throw new Error("该整理任务仍在运行，请勿重复执行");
  fs.unlinkSync(lockFile);
}
fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: "wx" });
const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
const db = new DatabaseSync(values.db);
db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
attachCoreImageStore(db, { dbPath: values["image-db"] });
const taskDir = planFile.slice(0, -5);

function runMetadata() {
  fs.mkdirSync(taskDir, { recursive: true });
  const args = ["-u", "tools/fetch_person_organization_metadata.py", "--plan", planFile, "--output", taskDir];
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { windowsHide: true, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, PYTHONUTF8: "1" } });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`资料下载进程退出：${code}`)));
  });
}

try {
  if (plan.groups.some((group) => !group.done)) reserveOrganizationPaths(db, plan);
  plan.status = "running";
  saveOrganizationPlan(planFile, plan);
  for (const group of plan.groups) {
    if (!group.done) await organizeGroup(db, group, plan, planFile);
    console.log(`目录已整理：${group.code}`);
  }
  console.log("PERSON_ORGANIZATION_PATHS_SYNCED");
  const warnings = [];
  if (plan.refreshMetadata) {
    await runMetadata();
    for (const group of plan.groups) {
      if (group.metadataDone) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, `${group.localWorkId}.json`), "utf8"));
      if (meta.error) { warnings.push(`${group.code}: ${meta.error}`); continue; }
      writeOrganizationSidecar(group, path.join(group.target, "info.txt"), `${meta.rawText}\n`);
      // Remove the duplicate only after the canonical info.txt has been written.
      const javdbInfo = path.join(group.target, "javdb-info.txt");
      if (fs.existsSync(javdbInfo) && fs.lstatSync(javdbInfo).isFile() && !fs.lstatSync(javdbInfo).isSymbolicLink()) fs.unlinkSync(javdbInfo);
      const coverFile = path.join(taskDir, `${group.localWorkId}.jpg`);
      if (!meta.coverError && fs.existsSync(coverFile)) {
        const bytes = fs.readFileSync(coverFile);
        writeOrganizationSidecar(group, path.join(group.target, "cover.jpg"), bytes);
        // Refresh cached covers too: the UI may prefer an existing SQLite blob.
        db.exec("BEGIN IMMEDIATE");
        organizationMutationMode(db, plan, "organize");
        db.prepare(`UPDATE fanhao_images.images SET image_blob = ?, mime = 'image/jpeg', byte_size = ?,
          status = 'ok', updated_at = ? WHERE owner_type = 'work' AND owner_id = ? AND kind = 'cover'`)
          .run(bytes, bytes.length, new Date().toISOString(), group.workId);
        organizationMutationMode(db, plan, "");
        db.exec("COMMIT");
      } else warnings.push(`${group.code}: 封面下载失败 · ${meta.coverError}`);
      group.metadataDone = !meta.coverError;
      saveOrganizationPlan(planFile, plan);
      if (group.metadataDone) {
        if (fs.existsSync(coverFile)) fs.unlinkSync(coverFile);
        fs.unlinkSync(path.join(taskDir, `${group.localWorkId}.json`));
      }
      console.log(`资料已写入：${group.code}`);
    }
  }
  plan.warnings = warnings;
  for (const group of plan.groups) {
    const cleaned = cleanupOrganizationWorkCovers(db, group, plan);
    for (const file of cleaned.removed) console.log(`旧封面已清理：${file}`);
    for (const file of cleaned.retained) console.log(`WARN 旧封面仍被引用或已改变，保留：${file}`);
  }
  plan.cleanup = cleanupOrganizationSidecars(db, plan);
  for (const file of plan.cleanup.removed) console.log(`遗留资料已清理：${file}`);
  for (const file of plan.cleanup.retained) console.log(`WARN 遗留资料仍被引用、已改变或根目录仍有视频，保留：${file}`);
  // Set last: writing or removing sidecars changes the containing directory's mtime.
  for (const group of plan.groups) {
    group.releaseDate ||= db.prepare("SELECT release_date FROM works WHERE id = ?").get(group.workId)?.release_date || "";
    const applied = setOrganizationFolderReleaseDate(group);
    console.log(applied ? `目录修改日期：${group.code} → ${group.releaseDate} 00:00`
      : `目录修改日期未调整：${group.code} · 未登记有效发布日期`);
  }
  plan.status = warnings.length ? "error" : "done";
  // Path work is finished even if the external metadata request failed.
  releaseOrganizationPaths(db, plan);
  saveOrganizationPlan(planFile, plan);
  for (const warning of warnings) console.log(`WARN ${warning}`);
  console.log(`整理结果：${plan.groups.length} 部 · 跳过 ${plan.skipped.length} 部 · 资料失败 ${warnings.length} 项`);
  if (warnings.length) { console.log("ERROR 目录已整理，部分封面或 info 下载失败；再次点击重新整理可继续失败项"); process.exitCode = 1; }
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  if (plan.groups.every((group) => group.done)) releaseOrganizationPaths(db, plan);
  plan.status = "error";
  plan.error = error.message;
  saveOrganizationPlan(planFile, plan);
  console.error(`ERROR ${error.message} · 再次点击重新整理可继续`);
  process.exitCode = 1;
} finally { db.close(); fs.unlinkSync(lockFile); }
