import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePhotoSourceUrl,
  parsePhotoImportManifest,
  parsePhotoSourcePage
} from "../src/modules/photos/server/photo-catalog-source.js";

const origin = "https://www.5280k.com";
const categoryUrl = `${origin}/category/studios/fixture`;

function card(id, title, { classes = "", label = "", href = `/${id}.html`, body = "" } = {}) {
  return `<article class="post-item ${classes}" id='post-${id}'>
    <span class='girl-nums'><b>${label}</b></span>
    <a href="${href}"><h2 class="entry-title">${title}</h2></a>
    ${body}
  </article>`;
}

function detail(id, title, { classes = "", body = "" } = {}) {
  return `<article id="post-${id}" class="type-post ${classes}"><h1 class="entry-title">${title}</h1>${body}</article>`;
}

test("a category keeps the sticky collection apart from issues with the same title issue number", () => {
  const html = `
    ${card(11, "样例图集合集[113套/330G]", { classes: "category-zzhj category-sticky", label: "113+" })}
    ${card(12, "样例 VOL.113 A &amp; B [189P+1V／2.74GB]", { label: "113-2" })}
    ${card(13, "样例 VOL.113 C [155P+1V／4.34GB]", { label: "113" })}
    ${card(14, "样例 NO.008 [82+1P+1V/2.4 GB]")}
    ${card(15, "样例 第 9 期 [1V/36.0M]")}
    ${card(16, "样例 2025-04-01 <i>未标注</i>")}
    ${card(12, "重复链接")}
    ${card(17, "跨站标题", { href: "https://other.test/17.html" })}
    ${card(18, "帖子号不匹配", { href: "/99.html" })}
    <!-- ${card(19, "注释中不读取") } -->
    <script type="text/template">${card(20, "脚本中不读取")}</script>
    <template>${card(21, "模板中不读取")}</template>
    <a rel="next" href="/category/studios/fixture/page/8">跳页</a>
    <a rel="next" href="/category/other/page/2">其他分类</a>
    <a rel="next" href="https://other.test/category/studios/fixture/page/2">外站</a>
    <a class="nextpostslink" rel="next" href="${categoryUrl}/page/2">下一页</a>`;

  const result = parsePhotoSourcePage(categoryUrl, html);
  assert.deepEqual(result.collection, {
    provider: "5280k", externalId: "11", url: `${origin}/11.html`, name: "样例图集合集[113套/330G]",
    declaredCount: 113, declaredCountLabel: "113+", declaredSizeLabel: "330G", issueListUrl: categoryUrl
  });
  assert.deepEqual(result.collections, [result.collection]);
  assert.equal(result.nextPage, `${categoryUrl}/page/2`);
  assert.deepEqual(result.entries, [
    { provider: "5280k", externalId: "12", url: `${origin}/12.html`, title: "样例 VOL.113 A & B [189P+1V／2.74GB]", issueCode: "VOL.113", issueLabel: "113-2", declaredImageCount: 189, declaredVideoCount: 1, declaredSizeLabel: "2.74GB" },
    { provider: "5280k", externalId: "13", url: `${origin}/13.html`, title: "样例 VOL.113 C [155P+1V／4.34GB]", issueCode: "VOL.113", issueLabel: "113", declaredImageCount: 155, declaredVideoCount: 1, declaredSizeLabel: "4.34GB" },
    { provider: "5280k", externalId: "14", url: `${origin}/14.html`, title: "样例 NO.008 [82+1P+1V/2.4 GB]", issueCode: "NO.008", declaredImageCount: 83, declaredVideoCount: 1, declaredSizeLabel: "2.4GB" },
    { provider: "5280k", externalId: "15", url: `${origin}/15.html`, title: "样例 第 9 期 [1V/36.0M]", issueCode: "第9期", declaredVideoCount: 1, declaredSizeLabel: "36.0M" },
    { provider: "5280k", externalId: "16", url: `${origin}/16.html`, title: "样例 2025-04-01 未标注", issueCode: "" }
  ]);

  const secondPage = parsePhotoSourcePage(result.nextPage, `${card(22, "样例 VOL.001 [0P+2V/0.2G]")}
    <a rel='next' href='/category/studios/fixture/page/2'>同一页</a>`);
  assert.equal(secondPage.collection, null);
  assert.equal(secondPage.nextPage, undefined);
  assert.equal(secondPage.entries[0].declaredImageCount, 0);
});

test("collection directory, individual collection post and issue post remain distinct", () => {
  const list = parsePhotoSourcePage(`${origin}/category/zzhj`, `
    ${card(11, "样例合集[113套/330G]", { classes: "category-zzhj", label: "113+" })}
    ${card(23, "样例合集(更新001-089期/2.1T)", { classes: "category-zzhj" })}
    ${card(24, "样例 VOL.100")}`);
  assert.equal(list.collection, null);
  assert.deepEqual(list.entries, []);
  assert.deepEqual(list.collections.map(row => row.externalId), ["11", "23"]);
  assert.equal(list.collections[1].declaredCount, undefined);
  assert.equal(list.collections[1].declaredCountLabel, "001-089期");

  const collection = parsePhotoSourcePage(`${origin}/11.html`, `${detail(12, "边栏单期")}
    ${detail(11, "样例合集[113套/330G]", { classes: "category-zzhj", body: `
      <a href='${categoryUrl}' rel='category tag'>分类</a>
      <a href='/category/zzhj' rel='category tag'>资源合集</a>
      <a href='/category/not-a-source'>普通导航</a>` })}`);
  assert.equal(collection.collection.issueListUrl, categoryUrl);
  assert.equal(collection.collection.declaredCountLabel, "113套");
  assert.deepEqual(collection.entries, []);

  const issue = parsePhotoSourcePage(`${origin}/12.html`, detail(12, "样例 VOL.113 &#x41; [189P+1V／2.74GB]", {
    body: `<a href='${categoryUrl}' rel='category tag'>出品机构</a><img src='/image.jpg'>`
  }));
  assert.equal(issue.collection, null);
  assert.equal(issue.entries[0].title, "样例 VOL.113 A [189P+1V／2.74GB]");
  assert.equal(issue.entries[0].publishedAt, undefined);
  assert.equal(issue.entries[0].personName, undefined);
});

test("compact and hyphenated source declarations keep a badge separate from the title issue code", () => {
  const fixtures = [
    ["[80P-1.16GB]", "147", 80, undefined, "1.16GB"],
    ["[80P1V-2.66GB]", "146", 80, 1, "2.66GB"],
    ["[100P-1V-2.3G]", "143", 100, 1, "2.3G"],
    ["[26P-263.9M]", "164", 26, undefined, "263.9M"],
    ["[1V／2.74GB]", "5799", undefined, 1, "2.74GB"],
    ["[82+1P + 1V / 2.40GB]", "105", 83, 1, "2.40GB"]
  ];
  const markup = fixtures.map(([suffix, label], index) => card(31 + index, `样例 ${suffix}`, { label })).join("");
  const page = parsePhotoSourcePage(categoryUrl, markup);
  assert.deepEqual(page.entries.map(issue => [issue.issueCode, issue.issueLabel, issue.declaredImageCount,
    issue.declaredVideoCount, issue.declaredSizeLabel]), fixtures.map(([, ...fields]) => ["", ...fields]));

  const direct = parsePhotoSourcePage(`${origin}/32.html`, detail(32, "样例 [80P1V-2.66GB]"));
  assert.equal(direct.entries[0].issueLabel, undefined);
  assert.equal(direct.entries[0].declaredImageCount, 80);
  assert.equal(direct.entries[0].declaredVideoCount, 1);
});

test("category collection needs a unique association and next links need an explicit marker", () => {
  const unrelated = card(41, "无关合集", { classes: "category-zzhj",
    body: `<a href="/category/studios/other" rel="category tag">其他分类</a>` });
  const unmarked = card(42, "同类样式但无明确关联", { classes: "category-zzhj category-fixture" });
  const associated = card(43, "关联合集", { classes: "category-zzhj", body: `
    <a href="/category/studios/fixture/" rel="category tag">本分类</a>
    <a href="/category/studios/other" rel="category tag">其他分类</a>` });
  const sticky = card(44, "另一个关联合集", { classes: "category-zzhj category-sticky" });
  const next = `${categoryUrl}/page/2`;

  const withoutAssociation = parsePhotoSourcePage(categoryUrl, `${unrelated}${unmarked}`);
  assert.equal(withoutAssociation.collection, null);
  assert.deepEqual(withoutAssociation.collections.map(row => row.externalId), ["41", "42"]);

  const result = parsePhotoSourcePage(categoryUrl, `${unrelated}${unmarked}${associated}
    <a class="nextpostslink" href="/category/studios/other/page/2">其他分类</a>
    <a class="nextpostslink" href="/category/studios/fixture/page/9">跳页</a>
    <a class="nextpostslink" href="${next}">下一页</a>`);
  assert.equal(result.collection.externalId, "43");
  assert.equal(result.collection.issueListUrl, categoryUrl);
  assert.deepEqual(result.collections.map(row => row.externalId), ["41", "42", "43"]);
  assert.equal(result.nextPage, next);
  assert.equal(parsePhotoSourcePage(categoryUrl, `${associated}${sticky}`).collection, null);

  const secondPage = parsePhotoSourcePage(next, `${sticky}
    <a class="page-numbers next" href="${categoryUrl}/page/3">下一页</a>`);
  assert.equal(secondPage.collection.issueListUrl, categoryUrl);
  assert.equal(secondPage.nextPage, `${categoryUrl}/page/3`);
});

test("source URLs and document structure fail closed", () => {
  assert.equal(normalizePhotoSourceUrl(`${categoryUrl}/page/1/`), categoryUrl);
  assert.equal(normalizePhotoSourceUrl(`${categoryUrl}/page/2/`), `${categoryUrl}/page/2`);
  assert.equal(normalizePhotoSourceUrl(`${origin}/12.html`), `${origin}/12.html`);
  for (const url of [
    "http://www.5280k.com/12.html", "https://www.5280k.com.evil.test/12.html", "https://user@www.5280k.com/12.html",
    "https://www.5280k.com:444/12.html", `${origin}/12.html?redirect=http://127.0.0.1`, `${origin}/12.html#media`,
    `${origin}/wp-content/12.jpg`, `${origin}/wp-login.php`, `${origin}/12.rar`, `${origin}/?p=12`,
    `${categoryUrl}/page/9999999`, "//www.5280k.com/12.html"
  ]) {
    assert.equal(normalizePhotoSourceUrl(url), "", url);
    assert.throws(() => parsePhotoSourcePage(url, ""), /URL/);
  }
  assert.throws(() => parsePhotoSourcePage(`${origin}/12.html`, detail(13, "其他帖子")), /无法识别/);
  assert.throws(() => parsePhotoSourcePage(categoryUrl, "<html>unexpected gateway response</html>"), /无法识别/);
  assert.throws(() => parsePhotoSourcePage(categoryUrl, "字".repeat(1024 * 1024)), /过大/);
});

test("version 1 Tuimzz manifests expose collection provenance and historical archive facts only", () => {
  const result = parsePhotoImportManifest({
    schema_version: 1,
    complete: false,
    plan: { roots: [
      { root_name: "88A", legacy_code: "88", post_id: "101", destination_name: "样例合集" },
      { root_name: "88B", legacy_code: "88", post_id: "101", destination_name: "样例合集" }
    ] },
    results: [
      { status: "imported", post_id: "101", sequence: 113, bytes: 1500, image_count: 10, rar_path: "T:/Synthetic/Sample 1.rar", source_path: "D:/private/download.7z" },
      { status: "identical_existing", post_id: "101", sequence: 114, bytes: 2000, image_count: 0, rar_path: "T:\\Synthetic\\Sample 2.RAR" },
      { status: "conflict", post_id: "101", sequence: 115, rar_path: "T:/Synthetic/conflict.rar" },
      { status: "error", post_id: "101", sequence: 116, rar_path: "T:/Synthetic/error.rar" },
      { status: "imported", post_id: "101", sequence: 117, rar_path: "T:/Synthetic/../outside.rar" },
      { status: "imported", post_id: "101", sequence: 118, rar_path: "T:Synthetic/drive-relative.rar" },
      { status: "imported", post_id: "101", sequence: 119, rar_path: "T:/Synthetic/file.rar:stream.rar" },
      { status: "imported", post_id: "101", sequence: 120, rar_path: "T:/Synthetic/download.7z" }
    ]
  });
  assert.deepEqual(result, {
    collections: [{ provider: "tuimzz", externalId: "101", name: "样例合集" }],
    archives: [
      { archivePath: "T:\\Synthetic\\Sample 1.rar", archiveName: "Sample 1.rar", status: "imported", collectionExternalId: "101", importSequence: 113, archiveBytes: 1500, observedImageCount: 10 },
      { archivePath: "T:\\Synthetic\\Sample 2.RAR", archiveName: "Sample 2.RAR", status: "identical_existing", collectionExternalId: "101", importSequence: 114, archiveBytes: 2000, observedImageCount: 0 }
    ]
  });
  assert.throws(() => parsePhotoImportManifest({ schema_version: 2, plan: { roots: [] }, results: [] }), /不支持/);
});
