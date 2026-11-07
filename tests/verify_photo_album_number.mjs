import assert from "node:assert/strict";
import { parsePhotoAlbumNumber, photoAlbumNumber, photoCollectionHealth } from "../src/modules/content-index/server/photo-album-number.js";

const cases = [
  ["[XIUREN秀人网]2023.01.01 No.6123 小蛮妖[80P／600MB]", "NO.6123"],
  ["[分类 B]2026.05.03 N0.102 童颜少女", "NO.102"],
  ["[Beautyleg美腿写真]2022.07.12VOL.2191 Lola[48P／352MB]", "VOL.2191"],
  ["[Ugirls尤果网] 爱尤物专辑 VO.2636 箴言 李丽莎[35P／85MB]", "VOL.2636"],
  ["[TuiGirl推女郎] 第84期 陈秋雨", "NO.84"],
  ["009.乙醇子 – 微密圈系列 豹纹内裤[4V-438.3M]", "NO.009"],
  ["108.120斤的小王同学 – 仅有乳贴的秘书[54P2V-443M]", "NO.108"],
  ["[Espacia Korea]134 EXC#137 RAHEE[52P-468.4M]", "NO.134"],
  ["[魔镜街拍] 176 辉辉模拍作品 - 丝袜调查员[274P／230MB]", "NO.176"],
  ["学妹校园寝室短丝系列045 小青[94P／593MB]", "NO.045"],
  ["[高丝女子图鉴]袜小喵×一丝幻想 NZ058 星星 [59P-45MB]", "NZ058"],
  ["[紧急企划]Y-005 棕丝JK裙[99P+1V／3.33GB]", "Y005"],
  ["森萝财团写真 月下007 小夜 黑丝 10D 超薄[100P+1V／9.44GB]", "NO.007"],
  ["森萝财团写真 朝露 04E4K[112P+2V／6.97GB]", "NO.04"],
  ["[GALLI嘉丽]舞蹈生日记 109 - 羽[43P／292MB]", "NO.109"],
  ["青空ひかり　君に夢中　ｖｏｌ．２　FRIDAYデジタル写真集", "VOL.2"],
  // Dates and names are not issue numbers.
  ["[YITUYU艺图语]2023.04.30 诱惑 Yo[31+1P／101MB]", ""],
  ["[YITUYU艺图语]2022.12.16 余晖 33[36+1P／319MB]", ""],
  ["MetArt.com_23.11.24.Charlotte.Brooke.Play.My.Tune", ""],
  ["[XX]2019 夏日写真", ""],
  ["桃沢安", ""]
];
for (const [title, expected] of cases) assert.equal(photoAlbumNumber(title), expected, title);

const parsed = parsePhotoAlbumNumber("009.乙醇子 – 豹纹内裤");
assert.equal(parsed.text.slice(parsed.index, parsed.index + parsed.length), "009");

const album = (id, title, size, extra = {}) => ({ id, title, size, ...extra });
const health = photoCollectionHealth([
  album("a", "[X] NO.1 甲", 10), album("b", "[X] NO.2 乙", 20), album("c", "[X] NO.5 丙", 30),
  album("d", "[X] NO.6 丁", 40), album("e", "[X] NO.9 戊", 50), album("e2", "[X] NO.9 戊 高清", 70),
  album("f", "[X]2023.01.01 春", 5, { archiveDate: "2023-01-01", albumSubject: "春" }),
  album("f2", "[X]2023.01.01 春_[20P]", 3, { archiveDate: "2023-01-01", albumSubject: "春" }),
  album("g", "[X] 无号", 1)
]);
assert.equal(health.total, 9);
assert.equal(health.numbered, 6);
assert.deepEqual(health.numbering, [{ prefix: "NO.", count: 5, min: 1, max: 9, missing: 4,
  missingRanges: [[3, 4], [7, 8]], truncated: false }]);
assert.equal(health.duplicateGroupCount, 2);
assert.equal(health.duplicates[0].label, "NO.9");
assert.deepEqual(health.duplicates[0].items.map(item => item.id), ["e2", "e"], "the largest copy is listed first");
assert.equal(health.duplicates[0].reclaimableBytes, 50);
assert.equal(health.duplicateReclaimableBytes, 53);

// VOL. and NO. spell one series; the common spelling labels it.
const mixed = photoCollectionHealth([1, 2, 3, 4, 6].map(n => album(`v${n}`, `[X] VOL.${n}`, 1))
  .concat(album("n5", "[X] No.5", 1), album("n6", "[X] No.6", 2)));
assert.deepEqual(mixed.numbering.map(({ prefix, min, max, missing }) => ({ prefix, min, max, missing })),
  [{ prefix: "VOL.", min: 1, max: 6, missing: 0 }]);
assert.equal(mixed.duplicateGroupCount, 1, "VOL.6 and No.6 are the same issue");

// Small families are not treated as a numbering scheme.
assert.deepEqual(photoCollectionHealth([album("x", "NO.1", 1), album("y", "NO.40", 1)]).numbering, []);

console.log("photo-album-number: ok");
