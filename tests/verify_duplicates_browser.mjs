import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const size = 2 * 1024 ** 3, hash = createHash("sha256").update("neutral equal file fixture").digest("hex");
const differentHash = createHash("sha256").update("neutral different file fixture").digest("hex");
const sourceGroups = Array.from({ length: 21 }, (_, index) => ({
  id: `g${index}`, code: `TEST-${String(index + 1).padStart(3, "0")}`, part: "whole", partLabel: "未标分卷", title: "中性文件比对样本", evidence: "same_code_part", totalBytes: size * 2.5, potentialExtraBytes: size * 1.5,
  files: ["a", "b", "c"].map((suffix, at) => ({ id: `${index}-${suffix}`, workId: `fixture-work-${index}`, videoId: null, codeSource: at === 2 ? "metadata" : "filename", path: `X:\\NeutralFixture\\${"用于验证完整路径换行的中性目录名".repeat(5)}\\TEST-${index + 1}-${suffix}.mp4`, name: `TEST-${String(index + 1).padStart(3, "0")}-${suffix}.mp4`, size: at < 2 ? size : size / 2, modifiedAt: "2026-10-24T01:00:00Z", editionLabels: at === 1 ? ["4K"] : [], resolutionLabel: "", duration: null, isLargest: at < 2, isLongest: false }))
}));
sourceGroups[20].files = Array.from({ length: 70 }, (_, index) => ({ ...sourceGroups[20].files[0], id: `20-${index}`, name: `TEST-021-version-${index}.mp4`, path: `X:\\NeutralFixture\\TEST-021-version-${index}.mp4` }));
sourceGroups[20].totalBytes = size * 70; sourceGroups[20].potentialExtraBytes = size * 69;
sourceGroups[10].files[1].path = "Y:\\OtherFixture\\TEST-011-b.mp4";
sourceGroups[10].files[2].path = sourceGroups[10].files[2].path.toLowerCase().replaceAll("\\", "/");
const summary = { indexedFiles: 200, candidateGroups: 21, candidateFiles: 130, potentialExtraBytes: size * 21 };
const jobs = new Map(), requests = [];
let failList = false, failProbe = true, failResolve = true, failProgress = true, failFolder = true, failCleanup = true;
let sequence = 0;
function jobFiles(group, status) { return group.files.map((file, at) => ({ id: file.id, status: at === 2 ? "size_distinct" : status, ...(status === "hashed" && at < 2 ? { sha256: hash } : {}) })); }
function snapshot(record) {
  const original = sourceGroups.find((item) => item.id === record.groupId), group = { ...original, files: record.files || original.files }, job = record.job;
  if (job.cancelRequested) return { ...job, status: "cancelled", files: jobFiles(group, "pending"), matches: [], finishedAt: new Date().toISOString() };
  if (record.groupId === "g1") return { ...job, status: "failed", error: "测试读取失败，请检查文件是否可用", files: [{ id: group.files[0].id, status: "unavailable", error: "测试文件不可用" }], finishedAt: new Date().toISOString() };
  if (record.groupId === "g3") return { ...job, status: "complete", progressBytes: job.totalBytes, files: group.files.map((file, at) => ({ id: file.id, status: "hashed", sha256: at ? differentHash : hash })), matches: [{ fileIds: group.files.slice(0, 2).map((file) => file.id), bytes: size }] };
  if (record.groupId === "g5") return { ...job, status: "complete", progressBytes: job.totalBytes, files: [{ id: group.files[0].id, status: "hashed", sha256: hash }, { id: group.files[1].id, status: "same_file", sameAs: group.files[0].id }, { id: group.files[2].id, status: "size_distinct" }], matches: [] };
  if (record.groupId === "g4") return { ...job, progressBytes: size, files: jobFiles(group, "hashing") };
  if (record.reads >= 2) return { ...job, status: "complete", progressBytes: job.totalBytes, files: jobFiles(group, "hashed"), matches: [{ fileIds: group.files.slice(0, 2).map((file) => file.id), bytes: size }], finishedAt: new Date().toISOString() };
  return { ...job, progressBytes: size, files: jobFiles(group, "hashing") };
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  let body = null;
  if (req.method === "POST") { let raw = ""; for await (const chunk of req) raw += chunk; body = raw ? JSON.parse(raw) : {}; }
  requests.push({ url, method: req.method, body });
  if (url.pathname.startsWith("/api/")) {
    let payload = {}, status = 200;
    if (url.pathname === "/api/fanhao/duplicates") {
      const query = (url.searchParams.get("q") || "").toLowerCase(), offset = Number(url.searchParams.get("offset")) || 0, limit = Number(url.searchParams.get("limit")) || 20;
      const selected = sourceGroups.filter((group) => `${group.code} ${group.title} ${group.files.map((file) => file.path).join(" ")}`.toLowerCase().includes(query));
      payload = failList ? { error: "候选索引读取测试失败" } : { summary, total: selected.length, offset, hasMore: offset + limit < selected.length, groups: selected.slice(offset, offset + limit) }; status = failList ? 503 : 200;
    } else if (url.pathname === "/api/open-folder") {
      if (failFolder) { failFolder = false; status = 400; payload = { error: "测试文件夹暂不可用" }; }
      else payload = { ok: true };
    } else if (url.pathname.endsWith("/cleanup")) {
      if (failCleanup) { failCleanup = false; status = 503; payload = { error: "索引清理测试失败" }; }
      else payload = { removedFileIds: [], removedLocalWorkIds: [], warnings: [], uncertainFiles: 0 };
    } else if (url.pathname.endsWith("/recheck")) {
      const group = structuredClone(sourceGroups.find(item => item.id === body.groupId));
      const removed = group.files.splice(1); payload = { group, missingFileIds: removed.map(file => file.id), warnings: [] };
    } else if (url.pathname.endsWith("/probe")) {
      await new Promise((resolve) => setTimeout(resolve, 130));
      if (failProbe && body.groupId === "g0") { payload = { error: "媒体参数读取测试失败" }; status = 503; failProbe = false; }
      else { const group = structuredClone(sourceGroups.find((item) => item.id === body.groupId)); group.files.forEach((file, index) => { if (body.fileIds && !body.fileIds.includes(file.id)) return; file.duration = index === 1 ? 3700 : 3600; file.resolutionLabel = index === 1 ? "3840×2160" : "1920×1080"; file.isLongest = index === 1; }); payload = { group }; }
    } else if (url.pathname.endsWith("/resolve")) {
      if (failResolve) { payload = { error: "预览文件已失效，请重试" }; status = 404; failResolve = false; }
      else payload = { url: `/player.html?workId=fixture-work&videoId=${encodeURIComponent(body.fileId)}` };
    } else if (url.pathname.endsWith("/check")) {
      const original = sourceGroups.find((item) => item.id === body.groupId), group = { ...original, files: body.fileIds ? original.files.filter((file) => body.fileIds.includes(file.id)) : original.files };
      const job = { id: `job-${++sequence}`, status: "running", progressBytes: 0, totalBytes: size * 2, files: jobFiles(group, "pending"), matches: [], startedAt: new Date().toISOString(), cancelRequested: false };
      jobs.set(job.id, { groupId: group.id, files: group.files, reads: 0, job }); payload = { job };
    } else if (url.pathname.includes("/checks/")) {
      const id = url.pathname.split("/")[5], record = jobs.get(id);
      if (!record) { status = 404; payload = { error: "校验任务已失效" }; }
      else if (url.pathname.endsWith("/cancel")) { record.job.cancelRequested = true; payload = { job: { ...record.job } }; }
      else if (record.groupId === "g4" && failProgress) { failProgress = false; status = 503; payload = { error: "测试进度暂不可读" }; }
      else { record.reads++; record.job = snapshot(record); payload = { job: record.job }; }
    }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(payload)); return;
  }
  if (url.pathname === "/player.html" || url.pathname === "/blank") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><html><body><p>Neutral fixture</p></body></html>"); return; }
  const pathname = url.pathname === "/fanhao/duplicates" ? "/modules/fanhao/duplicates/index.html" : url.pathname;
  const target = path.resolve(root, `.${pathname}`);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.statSync(target, { throwIfNoEntry: false })?.isFile()) { res.writeHead(404); res.end(); return; }
  const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` }); fs.createReadStream(target).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const executablePath = process.env.FANHAO_CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((candidate) => fs.existsSync(candidate));
  assert(executablePath, "a Chromium browser is required");
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], remoteImages = []; page.on("pageerror", (error) => errors.push(error.message)); page.on("request", (request) => { if (request.resourceType() === "image") remoteImages.push(request.url()); });
  const address = `http://127.0.0.1:${server.address().port}/fanhao/duplicates`;
  const screenshotIndex = process.argv.indexOf("--screenshots"), screenshotDir = screenshotIndex >= 0 ? path.resolve(process.argv[screenshotIndex + 1]) : null;
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
  const group = (id) => page.locator(`.duplicate-group[data-group-id="${id}"]`);
  async function search(code, id) { await page.getByRole("searchbox", { name: "搜索候选" }).fill(code); await page.getByRole("button", { name: "搜索", exact: true }).click(); await group(id).waitFor(); }
  async function start(id) { await group(id).getByRole("button", { name: "校验文件内容", exact: true }).click(); await group(id).getByRole("progressbar", { name: "文件内容校验进度" }).waitFor(); }
  const pollCount = (id) => requests.filter(({ url, method }) => method === "GET" && url.pathname === `/api/fanhao/duplicates/checks/${id}`).length;
  await page.goto(`http://127.0.0.1:${server.address().port}/blank`);
  await page.evaluate(file => {
    localStorage.setItem("fanhao.duplicates.references.v1", JSON.stringify({ g6: "6-b" }));
    localStorage.setItem("fanhao.duplicates.reviews.v1", JSON.stringify({ [JSON.stringify(["g9", file.id])]: { status: "ignore", fingerprint: JSON.stringify([file.path, Number(file.size), file.modifiedAt]) } }));
  }, sourceGroups[9].files[0]);
  await page.goto(address); await group("g0").waitFor();
  assert.equal(await group("g6").locator(".reference").count(), 1, "previous keep references migrate without losing choices");
  await group("g6").getByRole("button", { name: "取消保留", exact: true }).click();
  await page.reload(); await group("g0").waitFor();
  assert.equal(await group("g6").locator(".reference").count(), 0, "cancelled legacy choices must not reappear after reload");
  assert.equal(await group("g9").locator(".file-card.ignored").count(), 1, "old individual ignore decisions remain recoverable");
  await group("g9").getByRole("button", { name: "恢复旧版文件标记", exact: true }).click();
  assert.equal(await group("g9").locator(".file-card.ignored").count(), 0);
  assert.equal(await page.locator(".duplicate-group").count(), 20);
  assert.equal(await page.locator(".duplicate-group").first().getAttribute("data-group-id"), "g20", "the largest total group moves ahead of earlier API batches");
  assert.match(await page.locator("#summary").innerText(), /21/);
  assert.equal(await page.locator('.duplicate-group .group-code-row .verified').count(), 0, "candidate grouping must not claim byte identity");
  await group("g0").getByRole("button", { name: "忽略本组", exact: true }).click();
  assert.equal(await group("g0").count(), 0, "an ignored group moves beyond pending groups on later pages");
  assert.equal(await page.locator(".duplicate-group").first().getAttribute("data-group-id"), "g20");
  assert.equal(await group("g19").count(), 1, "the next pending group fills the page immediately");
  await page.reload(); await group("g1").waitFor();
  assert.equal(await group("g0").count(), 0, "refresh keeps ignored groups at the global end");
  await page.getByRole("button", { name: "下一页", exact: true }).click(); await group("g0").waitFor();
  assert.equal(await page.locator(".duplicate-group").count(), 1);
  await group("g0").getByRole("button", { name: "恢复本组比对", exact: true }).click(); await group("g19").waitFor();
  await page.getByRole("button", { name: "上一页", exact: true }).click(); await group("g0").waitFor();
  assert.equal(await page.locator(".duplicate-group").first().getAttribute("data-group-id"), "g20", "restored groups remain behind larger pending groups");
  await page.getByRole("button", { name: "下一页", exact: true }).click(); await group("g19").waitFor();
  assert.equal(await page.locator(".duplicate-group").count(), 1); assert.match(await page.locator("#pageLabel").innerText(), /2 \/ 2/);
  await search("TEST-021", "g20");
  assert.equal(await group("g20").locator(".file-card").count(), 6, "large groups initially render only six files");
  assert(await group("g20").getByRole("button", { name: "读取媒体参数", exact: true }).isDisabled());
  assert(await group("g20").getByRole("button", { name: "校验文件内容", exact: true }).isDisabled());
  assert.match(await group("g20").locator(".compare-message").innerText(), /超过 64 份，请先选择两份/);
  await group("g20").getByRole("button", { name: "展开其余 64 份", exact: true }).click();
  assert.equal(await group("g20").locator(".file-card").count(), 12, "expansion appends one bounded batch rather than the entire group");
  await group("g20").locator('[data-file-id="20-1"]').getByRole("button", { name: "加入重点对比", exact: true }).click();
  await group("g20").locator('[data-file-id="20-8"]').getByRole("button", { name: "加入重点对比", exact: true }).click();
  assert.deepEqual(await group("g20").locator(".file-card").evaluateAll((nodes) => nodes.slice(0, 2).map((node) => node.dataset.fileId)), ["20-1", "20-8"], "chosen files move first while retaining their source order");
  await group("g20").getByRole("button", { name: "读取媒体参数", exact: true }).click(); await group("g20").getByText("3840×2160", { exact: true }).waitFor();
  assert.deepEqual(requests.findLast(({ url, body }) => url.pathname.endsWith("/probe") && body.groupId === "g20").body.fileIds, ["20-1", "20-8"]);
  await start("g20"); await group("g20").locator(".group-code-row .verified").waitFor();
  assert.deepEqual(requests.findLast(({ url, body }) => url.pathname.endsWith("/check") && body.groupId === "g20").body.fileIds, ["20-1", "20-8"]);
  assert.match(await group("g20").locator(".hash-detail").innerText(), /本次范围 2 \/ 70 份，其余文件未纳入本次校验/);
  await search("TEST-001", "g0"); assert.equal(await page.locator(".duplicate-group").count(), 1);
  assert.equal(await group("g0").getByText("番号来自作品资料", { exact: true }).count(), 1, "metadata fallback codes remain visible for manual review");
  await group("g0").getByRole("button", { name: "加入重点对比", exact: true }).nth(0).click();
  await group("g0").getByRole("button", { name: "加入重点对比", exact: true }).nth(0).click();
  assert.equal(await group("g0").locator(".file-card.comparing").count(), 2);
  assert.equal(await group("g0").getByRole("button", { name: "加入重点对比", exact: true }).isDisabled(), true);
  await group("g0").getByRole("button", { name: "保留", exact: true }).nth(1).click();
  assert.match(await group("g0").locator(".file-card.reference").innerText(), /已标记保留/);
  await page.reload(); await group("g0").waitFor(); assert.equal(await group("g0").locator(".file-card.reference").count(), 1);
  await search("TEST-001", "g0");
  await group("g0").getByRole("button", { name: "读取媒体参数", exact: true }).dblclick();
  await group("g0").getByText("媒体参数读取测试失败", { exact: true }).waitFor();
  assert.equal(requests.filter(({ url, body }) => url.pathname.endsWith("/probe") && body.groupId === "g0").length, 1, "a pending probe must not submit twice");
  await group("g0").getByRole("button", { name: "读取媒体参数", exact: true }).click(); await group("g0").getByText("3840×2160", { exact: true }).waitFor();
  assert.equal(await group("g0").getByText("媒体参数读取测试失败", { exact: true }).count(), 0, "successful actions clear stale errors");
  const failedPopup = page.waitForEvent("popup"); await group("g0").getByRole("button", { name: "播放预览", exact: true }).first().click(); const failedWindow = await failedPopup;
  await group("g0").getByText("预览文件已失效，请重试", { exact: true }).waitFor(); await failedWindow.close().catch(() => {});
  const preview = page.waitForEvent("popup"); await group("g0").getByRole("button", { name: "播放预览", exact: true }).first().click(); const window = await preview; await window.waitForURL(/player\.html\?workId=fixture-work&videoId=0-a/); await window.close();
  assert.equal(await group("g0").getByText("预览文件已失效，请重试", { exact: true }).count(), 0);
  await group("g0").getByRole("button", { name: "打开文件夹", exact: true }).first().click();
  await group("g0").getByText("测试文件夹暂不可用", { exact: true }).waitFor();
  await group("g0").getByRole("button", { name: "打开文件夹", exact: true }).first().click();
  await group("g0").getByText(/已请求在运行 FanHao 的电脑上打开所在文件夹/).waitFor();
  failFolder = true;
  await group("g0").getByRole("button", { name: "打开文件夹", exact: true }).click();
  await group("g0").getByText("测试文件夹暂不可用", { exact: true }).waitFor();
  assert.equal(await group("g0").getByText(/已请求在运行 FanHao 的电脑上打开所在文件夹/).count(), 0, "a failed open must clear the previous success message");
  assert.equal(await group("g0").locator(".group-actions").getByRole("button", { name: "打开文件夹", exact: true }).count(), 1);
  assert.equal(await group("g0").locator(".file-card").getByRole("button", { name: "打开文件夹", exact: true }).count(), 0, "folder actions belong to the whole record");
  assert.deepEqual(requests.findLast(({ url }) => url.pathname === "/api/open-folder").body, { sourcePath: sourceGroups[0].files[0].path.replace(/[\\/][^\\/]*$/, "") });
  await search("TEST-011", "g10");
  const opensBeforeChoice = requests.filter(({ url }) => url.pathname === "/api/open-folder").length;
  await group("g10").getByRole("button", { name: "打开文件夹", exact: true }).click();
  await group("g10").getByRole("region", { name: "本组文件夹", exact: true }).waitFor();
  assert.equal(await group("g10").locator(".folder-choice").count(), 2, "Windows directory aliases and case variants must be deduplicated");
  assert.equal(requests.filter(({ url }) => url.pathname === "/api/open-folder").length, opensBeforeChoice, "multiple directories require a deliberate choice");
  await group("g10").locator(".folder-choice").nth(1).getByRole("button", { name: "打开此文件夹", exact: true }).click();
  await group("g10").getByText(/已请求在运行 FanHao 的电脑上打开所在文件夹/).waitFor();
  assert.deepEqual(requests.findLast(({ url }) => url.pathname === "/api/open-folder").body, { sourcePath: "Y:\\OtherFixture" });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "the directory picker must fit a narrow page");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await search("TEST-008", "g7");
  const reviewed = () => group("g7").locator('[data-file-id="7-a"]');
  await reviewed().getByRole("button", { name: "保留", exact: true }).click();
  await group("g7").locator('[data-file-id="7-b"]').getByRole("button", { name: "保留", exact: true }).click();
  assert.equal(await group("g7").locator(".reference").count(), 2, "different editions may both be kept");
  assert.equal(await group("g7").locator(".file-card").getByRole("button", { name: "忽略", exact: true }).count(), 0, "ignore decisions belong to the whole record");
  const postsBeforeIgnore = requests.filter(({ method }) => method === "POST").length;
  await group("g7").getByRole("button", { name: "忽略本组", exact: true }).click();
  assert.equal(await group("g7").locator(".file-card").count(), 0, "ignoring a record collapses all of its files");
  assert(await group("g7").getByRole("button", { name: "校验文件内容", exact: true }).isDisabled());
  assert(await group("g7").getByRole("button", { name: "读取媒体参数", exact: true }).isDisabled());
  assert.equal(requests.filter(({ method }) => method === "POST").length, postsBeforeIgnore, "ignore does not mutate media or start work");
  await page.reload(); await group("g0").waitFor();
  await page.getByRole("button", { name: "下一页", exact: true }).click(); await group("g7").waitFor();
  assert.equal(await group("g7").getByText("已忽略本组", { exact: true }).count(), 1);
  await group("g7").getByRole("button", { name: "恢复本组比对", exact: true }).click();
  await search("TEST-008", "g7");
  assert.equal(await group("g7").locator(".file-card").count(), 3);
  assert.equal(await group("g7").locator(".reference").count(), 2, "group ignore must preserve individual keep choices");
  assert.equal(await group("g7").getByRole("button", { name: "校验文件内容", exact: true }).isDisabled(), false);
  await group("g7").getByRole("button", { name: "忽略本组", exact: true }).click();
  sourceGroups[7].files[1].modifiedAt = "2026-10-24T02:00:00Z";
  await page.reload(); await group("g7").waitFor();
  assert.equal(await group("g7").getByText("已忽略本组", { exact: true }).count(), 0, "changed group identities must not inherit an old ignore decision");
  assert.equal(await group("g7").locator(".file-card").count(), 3);
  assert.equal(await group("g7").locator(".reference").count(), 1, "individual decisions also expire when that file changes");
  await search("TEST-009", "g8");
  await group("g8").getByRole("button", { name: "检查文件是否还在", exact: true }).click();
  await group("g8").getByText(/已移除 2 份确认不存在的文件/).waitFor();
  assert.equal(await group("g8").locator(".file-card").count(), 1);
  assert(await group("g8").getByRole("button", { name: "校验文件内容", exact: true }).isDisabled());
  await search("TEST-001", "g0");
  await start("g0");
  assert.equal(await group("g0").locator(".group-code-row .verified").count(), 0, "running hashes must not report identical content");
  await group("g0").locator(".group-code-row .verified").waitFor();
  assert.match(await group("g0").locator(".group-code-row .verified").innerText(), /^本次校验内容一致$/);
  assert.equal(await group("g0").locator(".file-badges .verified").count(), 2);
  await group("g0").getByRole("button", { name: "加入重点对比", exact: true }).first().click(); await group("g0").getByRole("button", { name: "加入重点对比", exact: true }).first().click();
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "duplicates-desktop-neutral.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "the 390px page must not overflow horizontally");
  assert(await group("g0").locator(".file-comparison").evaluate((element) => element.scrollWidth > element.clientWidth), "horizontal comparison remains scoped inside the group");
  assert((await group("g0").locator(".file-path").first().innerText()).includes("用于验证完整路径"), "full paths must remain present");
  if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, "duplicates-mobile-neutral.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await search("TEST-002", "g1"); await start("g1"); await group("g1").getByText("校验失败", { exact: true }).waitFor(); assert.equal(await group("g1").locator(".verified").count(), 0);
  await search("TEST-003", "g2"); await start("g2"); await group("g2").getByRole("button", { name: "取消校验", exact: true }).click();
  await group("g2").getByRole("button", { name: "取消中…", exact: true }).waitFor(); assert(await group("g2").getByRole("button", { name: "取消中…", exact: true }).isDisabled());
  await group("g2").getByText("校验已取消", { exact: true }).waitFor(); assert.equal(await group("g2").locator(".verified").count(), 0);
  await search("TEST-004", "g3"); await start("g3"); await group("g3").getByText("本次校验已完成", { exact: true }).waitFor();
  assert.equal(await group("g3").locator(".verified").count(), 0, "inconsistent server match lists cannot override different full hashes");
  await search("TEST-006", "g5"); await start("g5"); await group("g5").getByText("同一物理文件的路径引用", { exact: true }).waitFor();
  assert.equal(await group("g5").locator(".verified").count(), 0, "physical aliases do not become recoverable duplicate copies");
  assert.match(await group("g5").locator(".file-hash-state").nth(1).innerText(), /不计为可回收副本/);
  await search("TEST-005", "g4"); await start("g4"); await group("g4").getByRole("button", { name: "重试读取进度", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-group-id="g4"] .group-error'));
  const heldJobId = [...jobs.values()].find((record) => record.groupId === "g4").job.id;
  await search("TEST-001", "g0"); const pollsBefore = pollCount(heldJobId); await page.waitForTimeout(1250); assert.equal(pollCount(heldJobId), pollsBefore, "changing filters stops old progress polling");
  await search("TEST-005", "g4"); await page.waitForFunction(() => document.querySelector('[data-group-id="g4"] .hash-panel'));
  await page.goto(`http://127.0.0.1:${server.address().port}/blank`); const pollsOnExit = pollCount(heldJobId); await page.waitForTimeout(1250); assert.equal(pollCount(heldJobId), pollsOnExit, "leaving the page stops progress polling");
  assert.equal(requests.filter(({ url }) => url.pathname === `/api/fanhao/duplicates/checks/${heldJobId}/cancel`).length, 0, "leaving does not cancel a user-started server job");
  failList = true; await page.goto(address); await page.getByRole("button", { name: "重新读取候选", exact: true }).waitFor(); assert.equal(await page.locator(".duplicate-group").count(), 0);
  failList = false; await page.getByRole("button", { name: "重新读取候选", exact: true }).click(); await group("g0").waitFor(); assert.equal(await page.locator("#status.error").count(), 0);
  await page.getByRole("searchbox", { name: "搜索候选" }).fill("NO-MATCH"); await page.getByRole("button", { name: "搜索", exact: true }).click(); await page.locator("#status.empty").waitFor(); assert.equal(await page.locator(".duplicate-group").count(), 0);
  await page.getByRole("button", { name: "清理失效索引", exact: true }).click();
  await page.getByText("索引清理测试失败", { exact: true }).waitFor();
  await page.getByRole("button", { name: "清理失效索引", exact: true }).click();
  await page.getByText("已清理 0 条失效文件索引、0 条目录索引。作品资料、收藏和观看记录保留。", { exact: true }).waitFor();
  assert.equal(requests.filter(({ url }) => url.pathname.endsWith("/cleanup")).at(-1).body.q, "NO-MATCH", "cleanup follows the visible search scope");
  for (let index = 21; index <= 60; index++) {
    const extra = structuredClone(sourceGroups[0]); extra.id = `g${index}`; extra.code = `TEST-${String(index + 1).padStart(3, "0")}`;
    extra.files = extra.files.map((file, at) => ({ ...file, id: `${index}-${at}`, path: `X:\\NeutralBulk\\${extra.code}-${at}.mp4` })); sourceGroups.push(extra);
  }
  await page.goto(address); await group("g0").waitFor();
  assert(requests.some(({ url }) => url.pathname === "/api/fanhao/duplicates" && url.searchParams.get("offset") === "50"), "global ordering must load metadata beyond the first API batch");
  assert(requests.some(({ url }) => url.pathname === "/api/fanhao/duplicates" && url.searchParams.get("refresh") === "1"), "initial page loading must request current filesystem availability");
  await group("g0").getByRole("button", { name: "忽略本组", exact: true }).click();
  for (const first of ["g21", "g41", "g0"]) { await page.getByRole("button", { name: "下一页", exact: true }).click(); await group(first).waitFor(); }
  assert.equal(await page.locator(".duplicate-group").count(), 1, "ignored groups remain after every pending group across metadata batches");
  await group("g0").getByRole("button", { name: "恢复本组比对", exact: true }).click(); await group("g60").waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(remoteImages, [], "technical comparison must not request covers or photos");
  assert(requests.filter(({ method }) => method === "POST").every(({ url }) => /\/(?:probe|resolve|check|cancel|recheck|cleanup|open-folder)$/.test(url.pathname)), "comparison does not expose media deletion mutations");
  console.log("Duplicates browser checks passed: search/pagination, two-file comparison, record-level ignore/restore with identity checks, individual keeps and legacy recovery, one folder action per record with deduplicated directory choices, manual-delete recheck, probe/preview/retry, full-SHA identity, cancellation, scoped 390px layout, stopped polling and no image requests.");
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
