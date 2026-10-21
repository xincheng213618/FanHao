import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { attachCoreImageStore } from "../src/platform/server/core-image-store.js";
import { organizeGroup, saveOrganizationPlan, refreshOrganizationCatalogueSnapshot, syncOrganizationMetadata, reserveOrganizationPaths, releaseOrganizationPaths, cleanupOrganizationSidecars, cleanupOrganizationWorkCovers, setOrganizationFolderReleaseDate } from "../src/modules/fanhao/server/people/person-organization-service.js";

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

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-u", ...args], { windowsHide: true, stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PYTHONUTF8: "1", FANHAO_CORE_IMAGE_DB: values["image-db"] } });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`资料更新进程退出：${code}`)));
  });
}

function runMetadata() {
  fs.mkdirSync(taskDir, { recursive: true });
  return runPython(["tools/fetch_person_organization_metadata.py", "--plan", planFile, "--output", taskDir]);
}

try {
  const warnings = [];
  if (plan.refreshMetadata && plan.refreshActorMovies && !plan.actorRefreshDone) {
    console.log("正在更新人物全部作品列表（包含后续分页）");
    plan.actorRefreshStartedAt = new Date().toISOString();
    saveOrganizationPlan(planFile, plan);
    try {
      await runPython(["tools/refresh_core_javdb_actor_movies.py", "--db", values.db, "--person-id", String(plan.personId),
        "--profile-dir", path.resolve("data/selenium-person-organization-profile", String(plan.personId)), "--write", "--max-pages", "0",
        "--actor-wait-seconds", "45", "--fast", "--headless", "--sleep", "1", "--jitter", "0"]);
      plan.actorRefreshDone = true;
      saveOrganizationPlan(planFile, plan);
    } catch (error) { warnings.push(`人物作品列表更新失败 · ${error.message}`); }
  }
  // Upgrade old retry plans: their completed groups only used stored URLs.
  if (plan.refreshMetadata && plan.metadataVersion !== 2) {
    for (const group of plan.groups) group.metadataDone = false;
    plan.metadataVersion = 2;
    saveOrganizationPlan(planFile, plan);
  }
  if (plan.groups.some((group) => !group.done || (plan.refreshMetadata && !group.metadataDone))) reserveOrganizationPaths(db, plan);
  plan.status = "running";
  saveOrganizationPlan(planFile, plan);
  for (const group of plan.groups) {
    if (!group.done) await organizeGroup(db, group, plan, planFile);
    console.log(`目录已整理：${group.code}`);
  }
  console.log("PERSON_ORGANIZATION_PATHS_SYNCED");
  if (plan.refreshMetadata) {
    if (plan.refreshActorMovies) {
      refreshOrganizationCatalogueSnapshot(db, plan);
      saveOrganizationPlan(planFile, plan);
    }
    await runMetadata();
    for (const group of plan.groups) {
      if (group.metadataDone) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(taskDir, `${group.localWorkId}.json`), "utf8"));
      if (meta.error) { warnings.push(`${group.code}: ${meta.error}`); continue; }
      if (meta.metadataError) warnings.push(`${group.code}: 作品资料更新失败 · ${meta.metadataError}`);
      const coverFile = path.join(taskDir, `${group.localWorkId}.jpg`);
      const bytes = !meta.coverError && fs.existsSync(coverFile) ? fs.readFileSync(coverFile) : null;
      syncOrganizationMetadata(db, group, plan, meta, bytes);
      // Remove the duplicate only after the canonical info.txt has been written.
      const javdbInfo = path.join(group.target, "javdb-info.txt");
      if (!meta.metadataError && fs.existsSync(javdbInfo) && fs.lstatSync(javdbInfo).isFile() && !fs.lstatSync(javdbInfo).isSymbolicLink()) fs.unlinkSync(javdbInfo);
      if (!bytes) warnings.push(`${group.code}: 封面下载失败 · ${meta.coverError || "未生成有效封面文件"}`);
      group.metadataDone = !meta.metadataError && Boolean(bytes);
      saveOrganizationPlan(planFile, plan);
      if (group.metadataDone) {
        if (fs.existsSync(coverFile)) fs.unlinkSync(coverFile);
        fs.unlinkSync(path.join(taskDir, `${group.localWorkId}.json`));
      }
      console.log(`${group.metadataDone ? "资料已更新" : "资料部分更新，失败项待重试"}：${group.code}`);
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
