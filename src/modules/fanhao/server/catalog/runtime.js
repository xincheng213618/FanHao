import { routeCatalogApi } from "./routes.js";
import { createLtxCatalogService } from "./ltx-catalog-service.js";
import { MAX_CATALOG_BYTES } from "./ltx-snapshot-import.js";
import { createCachedJsonSender } from "../../../../platform/server/responses.js";

const LTX_PREVIEW_SIZE = 20;
const ltxCollator = new Intl.Collator("zh-CN", { numeric: true });

function recentFirst(left, right) {
  // The browser sees non-finite catalog dates as null after JSON encoding.
  const a = Number.isFinite(left.addedAt) ? left.addedAt : null;
  const b = Number.isFinite(right.addedAt) ? right.addedAt : null;
  const byDate = a === null ? -ltxCollator.compare(a, b) : b - a;
  return byDate || ltxCollator.compare(left.code, right.code);
}

function createLtxRecentPreview({ fetchedAt, libraryChecked, downloadsChecked, items, avatars }) {
  const counts = { total: items.length, local: 0, marked: 0, pending: 0 };
  const actorCounts = new Map();
  for (const { local, pending, waiting, missing, links, libraryOnly, actors } of items) {
    if (local.library || local.downloads) counts.local++;
    if (local.marked) counts.marked++;
    if (!libraryOnly && (pending || waiting || missing || !links.length)) counts.pending++;
    for (const actor of new Set(actors)) actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
  }
  return {
    preview: "recent", fetchedAt, libraryChecked, downloadsChecked, counts, avatars,
    items: items.toSorted(recentFirst).slice(0, LTX_PREVIEW_SIZE),
    actors: [...actorCounts].sort(([left, leftCount], [right, rightCount]) =>
      rightCount - leftCount || ltxCollator.compare(left, right))
  };
}

export function createCatalogRuntime(deps) {
  const ltxService = deps.ltx ? createLtxCatalogService(deps.ltx) : null;
  const sendLtxCatalog = ltxService && createCachedJsonSender();
  const ltxPreviews = new WeakMap();

  async function routeApi(req, res, url) {
    if (ltxService && url.pathname === "/api/fanhao/ltx/sync" && req.method === "POST") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      if (deps.ltx.requestAccess(req).mode !== "local") {
        deps.sendJson(res, 403, { error: "请在 FanHao 服务电脑上用 localhost 打开资源库，再更新目录。" });
        return true;
      }
      try {
        const catalog = await deps.readJsonBody(req, MAX_CATALOG_BYTES);
        deps.sendJson(res, 200, await ltxService.sync(catalog));
      } catch (error) {
        deps.sendJson(res, error.statusCode || 503, {
          error: error.publicMessage || (error.expose ? error.message : "同步 LTX 目录失败，原有快照仍可使用。")
        });
      }
      return true;
    }
    if (ltxService && url.pathname === "/api/fanhao/ltx/local-media" && req.method === "GET") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      try {
        deps.sendJson(res, 200, await ltxService.readLocalMedia(url.searchParams.get("code")));
      } catch {
        deps.sendJson(res, 503, { error: "暂时无法读取本地视频参数。" });
      }
      return true;
    }
    if (ltxService && url.pathname === "/api/fanhao/ltx" && req.method === "GET") {
      if (!deps.ltx.requireLocalAdmin(req, res)) return true;
      try {
        const { searchParams } = url;
        const payload = await ltxService.read({ refresh: searchParams.get("refresh") === "1" });
        if (searchParams.get("preview") === "recent" && !searchParams.has("refresh")) {
          let preview = ltxPreviews.get(payload);
          if (!preview) {
            preview = createLtxRecentPreview(payload);
            ltxPreviews.set(payload, preview);
          }
          sendLtxCatalog(res, 200, preview);
        } else {
          sendLtxCatalog(res, 200, payload);
        }
      } catch (error) {
        deps.sendJson(res, 503, { error: error.publicMessage || "读取 LTX 本地目录或文件索引失败，请重试。" });
      }
      return true;
    }
    return routeCatalogApi(req, res, url, deps);
  }

  function start() {
    deps.codePrefixService.prewarm();
    deps.studioService.prewarm();
    deps.rankingService.prewarm();
  }

  return {
    beginStop: () => ltxService?.beginStop(),
    findIntakeMetadata: ltxService?.findIntakeMetadata,
    routeApi,
    start,
    stop: () => ltxService?.stop()
  };
}
