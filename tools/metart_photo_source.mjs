const origin = "https://www.metart.com";
const cdn = "https://gccdn.metartnetwork.com";
const site = "E6B595104E3411DF98790800200C9A66";
const modelPath = /^\/model\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/u;
const uuid = /^[A-F0-9]{32}$/u;
const pageSize = 24;

export function metartModelSlug(value) {
  const url = new URL(value.includes("://") ? value : `${origin}/model/${value}`);
  const match = modelPath.exec(url.pathname);
  if (url.origin !== origin || url.username || url.password || !match || match[1].length > 100) {
    throw new Error("请输入 MetArt 官网人物页 URL 或人物标识");
  }
  return match[1];
}

async function publicBytes(url, { mime, maxBytes, fetchImpl }) {
  const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || type !== mime || Number(response.headers.get("content-length")) > maxBytes || !response.body) {
    await response.body?.cancel();
    throw new Error(`MetArt 公开资源不可用（HTTP ${response.status}，${type || "无类型"}）：${url}`);
  }
  const parts = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`MetArt 公开资源超过大小限制：${url}`);
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

export async function fetchMetartModel(slug, fetchImpl = fetch) {
  if (metartModelSlug(slug) !== slug) throw new Error("MetArt 人物标识无效");
  const canonicalPath = `/model/${slug}`;
  let model, total;
  const galleries = new Map();
  for (let after = 0; total === undefined || after < total; after += pageSize) {
    const url = `${origin}/api/model?${new URLSearchParams({ name: slug, after, order: "DATE", direction: "DESC" })}`;
    const page = JSON.parse(await publicBytes(url, { mime: "application/json", maxBytes: 3 * 1024 * 1024, fetchImpl }));
    const count = page?.latestGalleriesCount;
    if (page?.siteUUID !== site || page.path !== canonicalPath || !uuid.test(page.UUID) || !page.name?.trim?.()
      || !Number.isSafeInteger(count) || count < 0 || count > 5000 || !Array.isArray(page.latestGalleries)
      || page.latestGalleries.length !== Math.min(pageSize, count - after)
      || (model && (total !== count || page.UUID !== model.id || page.name !== model.name))) {
      throw new Error("MetArt 人物身份或分页结构有变化，停止导入");
    }
    if (!model) {
      const headshot = `/media/headshots/${slug}.jpg`;
      model = { id: page.UUID, name: page.name, page: `${origin}${canonicalPath}`,
        asset: page.headshotImagePath === headshot ? `${cdn}/${site}${headshot}` : null };
      total = count;
    }
    for (const row of page.latestGalleries) {
      if (row?.type !== "GALLERY" || row.siteUUID !== site || !uuid.test(row.UUID) || !row.name?.trim?.()
        || !Array.isArray(row.models) || !row.models.some(person => person?.UUID === model.id && person.path === canonicalPath)) continue;
      const date = typeof row.publishedAt === "string" ? row.publishedAt.slice(0, 10) : "";
      const pathPrefix = `${canonicalPath}/gallery/${date.replaceAll("-", "")}/`;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !row.path?.startsWith?.(pathPrefix)
        || !/^[A-Z0-9_%-]+$/iu.test(row.path.slice(pathPrefix.length))) continue;
      const cover = `/media/${row.UUID}/cover_${row.UUID}.jpg`;
      if (galleries.has(row.UUID)) throw new Error("MetArt 分页重复，停止导入");
      galleries.set(row.UUID, { id: row.UUID, title: row.name, date, page: `${origin}${row.path}`,
        asset: row.hasCover && row.coverImagePath === cover ? `${cdn}/${site}${cover}` : null });
    }
  }
  return { ...model, galleries: [...galleries.values()] };
}

export async function fetchMetartCover(url, { maxBytes, fetchImpl = fetch }) {
  const allowed = new RegExp(`^${cdn.replaceAll(".", "\\.")}/${site}/media/(?:headshots/[a-z0-9-]+|([A-F0-9]{32})/cover_\\1)\\.jpg$`, "u");
  if (!allowed.test(url)) throw new Error("MetArt 封面地址不在公开 CDN 的允许范围内");
  const bytes = await publicBytes(url, { mime: "image/jpeg", maxBytes, fetchImpl });
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error(`MetArt 返回的 JPEG 不完整：${url}`);
  return bytes;
}
