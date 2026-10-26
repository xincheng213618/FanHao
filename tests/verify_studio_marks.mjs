import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { createStudioMarkLookup, studioMarkForName } from "../lib/studio-marks.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";

const directory = new URL("../public/assets/studio-marks/", import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL("manifest.json", directory), "utf8"));
assert.equal(manifest.marks.length, 172);
for (const mark of manifest.marks) {
  assert.ok(!/[\\/]/u.test(mark.file));
  const content = fs.readFileSync(new URL(encodeURIComponent(mark.file), directory));
  assert.equal(createHash("sha256").update(content).digest("hex"), mark.sha256, `${mark.file}: unchanged source bytes`);
  assert.equal(content.byteLength, mark.bytes);
}
assert.match(fs.readFileSync(new URL("README.md", directory), "utf8"), /de22796c04919aaa057d77930c33c81313765569/u);
assert.match(fs.readFileSync(new URL("PEACH-LICENSE.txt", directory), "utf8"), /GNU AFFERO GENERAL PUBLIC LICENSE/u);

for (const names of [
  ["S1 NO.1 STYLE", "S1_NO_1_STYLE", "Ｓ１ ＮＯ．１ ＳＴＹＬＥ", "エスワン_ナンバーワンスタイル"],
  ["MOODYZ", "moodyz", "ムーディーズ"],
  ["SOD Create", "SODクリエイト"],
  ["IDEA POCKET", "Idea_Pocket", "アイデアポケット"],
  ["PRESTIGE", "プレステージ", "PRESTIGE,プレステージ", "PRESTIGE，プレステージ"],
  ["K_M_Produce", "ケイ・エム・プロデュース"],
  ["Wanz_Factory", "ワンズファクトリー"],
  ["ダスッ_", "ダスッ！", "ダスッ!"],
  ["Planet_Plus", "プラネットプラス"],
  ["Natural_High", "ナチュラルハイ"],
  ["Alice_JAPAN", "アリスJAPAN"],
  ["山と空_妄想族", "山と空"]
]) {
  const mark = studioMarkForName(names[0]);
  assert.ok(mark?.url, `${names[0]}: has an existing imported asset`);
  for (const name of names) assert.equal(studioMarkForName(name), mark, `${name}: explicit alias identity`);
  assert.equal(decodeURIComponent(mark.url.slice("/assets/studio-marks/".length)), mark.file);
}
for (const name of ["S1 NO.1 STYLE", "MOODYZ", "SOD Create", "PRESTIGE"]) {
  assert.equal(studioMarkForName(name).variant, "logo", "a clear logo wins over icon or a legacy small variant");
}
for (const name of ["", "Unknown studio", "S1", "MOODYZ XXX", "../MOODYZ", "SOD", "Prestige 2", null,
  "MOODYZ,プレステージ", "PRESTIGE,Unknown studio", "プレステージプレミアム(PRESTIGE PREMIUM)",
  "KMPVR-彩-", "Madonna", "マドンナ(Madonna)"]) {
  assert.equal(studioMarkForName(name), null, "unknown or partial identities never borrow another maker's logo");
}

const existingFile = manifest.marks[0].file;
const unsafe = createStudioMarkLookup({ assetDirectory: fileURLToPath(directory), manifest: { marks: [
  { studio: "Parent traversal", file: "../manifest.json" },
  { studio: "Windows traversal", file: "..\\manifest.json" },
  { studio: "Absolute path", file: "/manifest.json" },
  { studio: "Nonimage", file: "manifest.json" },
  { studio: "Missing", file: "does-not-exist.png" },
  { studio: "Encoded separator", file: "..%2Fmanifest.json" },
  { studio: "Control", file: "bad\u0000.png" },
  { studio: "Valid", file: existingFile }
] } });
for (const name of ["Parent traversal", "Windows traversal", "Absolute path", "Nonimage", "Missing", "Encoded separator", "Control"]) {
  assert.equal(unsafe(name), null);
}
assert.ok(unsafe("Valid")?.url);
assert.equal(createStudioMarkLookup({ manifest: null })("MOODYZ"), null);
assert.equal(createStudioMarkLookup({ assetDirectory: fileURLToPath(new URL("does-not-exist/", directory)), manifest })("MOODYZ"), null);

const service = createStudioService({ publicRemoteUrl: value => value || "" });
for (const method of ["publicMaker", "publicMakerSummary"]) {
  const result = service[method]({ maker_id: "123", name: "MOODYZ", work_count: 42, local_work_count: 9 });
  assert.equal(result.id, "123");
  assert.equal(result.workCount, 42);
  assert.equal(result.localWorkCount, 9);
  assert.equal(result.logoUrl, studioMarkForName("MOODYZ").url);
  assert.equal(result.logoSource.project, "peach");
  assert.equal(result.logoSource.sha256, studioMarkForName("MOODYZ").sha256);
  assert.ok(result.logoSource.sourceUrl);
  const unknown = service[method]({ maker_id: "456", name: "Unknown studio" });
  assert.equal(unknown.logoUrl, "");
  assert.equal(unknown.logoSource, null);
  assert.equal(service[method]({ maker_id: "789", name: "PRESTIGE,プレステージ" }).logoUrl,
    studioMarkForName("PRESTIGE").url, "known combined names use their explicit alias group");
}

const child = spawnSync(process.execPath, ["--input-type=module", "-e",
  `const { studioMarkForName } = await import(${JSON.stringify(new URL("../lib/studio-marks.js", import.meta.url).href)}); process.stdout.write(studioMarkForName('MOODYZ')?.url || '');`
], { cwd: os.tmpdir(), encoding: "utf8" });
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, studioMarkForName("MOODYZ").url, "lookup paths do not depend on the service working directory");
console.log(JSON.stringify({ ok: true, copiedMarks: manifest.marks.length, verifiedSourceHashes: manifest.marks.length,
  explicitAliasGroups: 12, deterministicVariantPreference: true, rejectsUnsafeOrMissingAssets: true,
  makerSummaryAndDetailProjection: true, independentOfWorkingDirectory: true }));
