import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fetchPublicPhotoSource, photoCatalogError, publicPhotoSourceUrl } from "./photo-catalog-fetch.js";
import { photoIssueCode, rankPhotoArchiveCandidates } from "./photo-catalog-matching.js";
import { photoCatalogCollectionKey, photoCatalogMergeFieldConflicts } from "./photo-catalog-service.js";
import { parsePhotoImportManifest, parsePhotoSourcePage } from "./photo-catalog-source.js";

const SAMPLE_SOURCE_URL = "https://www.5280k.com/category/zzhj";
const BATCH_SIZE = 40;
const PLAN_TTL_MS = 10 * 60_000;
const MAX_PLANS = 24;
const MAX_CANDIDATES = 12;

function archivePathKey(value) {
  if (typeof value !== "string" || !value) return "";
  if (path.win32.isAbsolute(value) && (/^[a-z]:/i.test(value) || value.startsWith("\\\\"))) {
    return path.win32.normalize(value).toLowerCase();
  }
  return path.posix.isAbsolute(value) ? path.posix.normalize(value) : "";
}

function sourceCategory(value) {
  const url = publicPhotoSourceUrl(value);
  if (!url.pathname.startsWith("/category/")) return "";
  return new URL(url.pathname.replace(/\/page\/\d+\/?$|\/$/, ""), url).href;
}

function localAlbum(album) {
  return { id: album.id, title: album.title, size: album.size, updatedAt: album.updatedAt || "", personName: album.personName || "" };
}

export function scannedPhotoCatalogCollection({ key, title }) {
  const externalId = createHash("sha256").update(key).digest("base64url").slice(0, 24);
  return { provider: "local", externalId, name: title };
}

export function createPhotoCatalogIntake({ catalog, getPhotoSets, describePhotoCollection, archivePath,
  loadPublicSource = fetchPublicPhotoSource, now = Date.now }) {
  const plans = new Map();

  function localGroups() {
    const groups = new Map();
    for (const album of getPhotoSets()) {
      const { key, ...description } = describePhotoCollection(album);
      let group = groups.get(key);
      if (!group) {
        const collection = scannedPhotoCatalogCollection({ key, ...description });
        group = { id: collection.externalId, legacyKey: key, collection, ...description, albums: [] };
        groups.set(key, group);
      }
      group.albums.push(album);
    }
    return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id));
  }

  function options() {
    return {
      localCollections: localGroups().map(({ albums, collection, ...group }) => ({
        ...group, catalogKey: photoCatalogCollectionKey(collection), count: albums.length
      })),
      sampleSourceUrl: SAMPLE_SOURCE_URL
    };
  }

  function selectedGroup(id) {
    const group = localGroups().find((item) => item.id === id);
    if (!group) throw photoCatalogError("所选本地合集已不存在，请重新选择", 404);
    return group;
  }

  function sourceRows(entries, collection, group, archiveQuery) {
    const albums = group?.albums || [];
    return entries.map((entry) => {
      const candidates = rankPhotoArchiveCandidates(entry, albums, { limit: MAX_CANDIDATES, query: archiveQuery });
      return {
        title: entry.title,
        issueCode: entry.issueCode || "",
        source: entry,
        collections: collection ? [collection] : [],
        localCollection: group?.collection,
        localAlbums: candidates.albums.map(localAlbum),
        archiveIds: [],
        warnings: candidates.total > MAX_CANDIDATES ? [`找到 ${candidates.total} 个本地候选，可按包名缩小范围`] : []
      };
    });
  }

  function localRows(group) {
    return group.albums.map((album) => {
      const suggestedIssueCode = photoIssueCode(album.title);
      return { title: album.title, issueCode: suggestedIssueCode, suggestedIssueCode, collections: [group.collection],
        localAlbums: [localAlbum(album)], archiveIds: [album.id] };
    });
  }

  function manifestRows(manifest) {
    let parsed;
    try {
      parsed = parsePhotoImportManifest(manifest);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw photoCatalogError(error.message);
    }
    const { collections, archives } = parsed;
    const collectionsById = new Map(collections.map((collection) => [collection.externalId, collection]));
    const indexed = new Map();
    for (const album of getPhotoSets()) {
      const key = archivePathKey(archivePath(album));
      if (key && !indexed.has(key)) indexed.set(key, album);
    }
    return archives.map((entry) => {
      const album = indexed.get(archivePathKey(entry.archivePath));
      const collection = collectionsById.get(entry.collectionExternalId);
      const matches = album && entry.archiveBytes != null && Number(album.size) === entry.archiveBytes;
      const suggestedIssueCode = album ? photoIssueCode(album.title) : "";
      return {
        title: album?.title || entry.archiveName,
        issueCode: suggestedIssueCode,
        suggestedIssueCode,
        collections: collection ? [collection] : [],
        localCollection: matches ? scannedPhotoCatalogCollection(describePhotoCollection(album)) : undefined,
        localAlbums: matches ? [localAlbum(album)] : [],
        archiveIds: matches ? [album.id] : [],
        manifestObservation: {
          importSequence: entry.importSequence,
          observedImageCount: entry.observedImageCount,
          archiveBytes: entry.archiveBytes
        },
        blocked: matches ? "" : !album ? "当前套图索引未找到清单中的压缩包" : entry.archiveBytes == null
          ? "清单缺少归档大小，无法校对" : "本地压缩包大小与清单记录不同"
      };
    });
  }

  function rowInput(row, change = {}) {
    const archiveIds = change.archiveIds ?? row.archiveIds;
    const collections = row.localCollection && archiveIds.length ? [...row.collections, row.localCollection] : row.collections;
    return {
      ...(change.title !== undefined ? { title: change.title } : {}),
      ...(change.issueCode !== undefined ? { issueCode: change.issueCode } : {}),
      ...(row.suggestedIssueCode ? { suggestedIssueCode: row.suggestedIssueCode } : {}),
      ...(change.mergeWorkIds ? { mergeWorkIds: change.mergeWorkIds } : {}),
      archiveIds,
      sources: row.source ? [row.source] : [],
      collections,
      ...(change.people?.length ? { people: change.people } : {}),
      ...(change.releaseDate ? { releaseDate: change.releaseDate } : {})
    };
  }

  function clearExpiredPlans() {
    const timestamp = now();
    for (const [id, plan] of plans) if (plan.expiresAt <= timestamp) plans.delete(id);
  }

  async function readSource(url) {
    const page = await loadPublicSource(url);
    try {
      return parsePhotoSourcePage(page.url, page.html);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      throw photoCatalogError(error.message, 502);
    }
  }

  async function collectionForCategory(firstPage, category) {
    if (firstPage.collection) return firstPage.collection;
    if (firstPage.collections.length !== 1) return null;
    try {
      const { collection } = await readSource(firstPage.collections[0].url);
      return collection?.issueListUrl && sourceCategory(collection.issueListUrl) === category ? collection : null;
    } catch (error) {
      if (error.statusCode !== 502) throw error;
      return null;
    }
  }

  async function sourceBatch(input) {
    const url = publicPhotoSourceUrl(input.url);
    const category = sourceCategory(url.href);
    let verifiedCollection;
    let sourceCollectionUrl;
    if (input.sourceCollectionUrl !== undefined) {
      const anchor = publicPhotoSourceUrl(input.sourceCollectionUrl);
      if (!category || sourceCategory(anchor.href)) throw photoCatalogError("合集与本次预览分类不匹配");
      const { collection } = await readSource(anchor.href);
      if (!collection?.issueListUrl || sourceCategory(collection.issueListUrl) !== category) {
        throw photoCatalogError("合集与本次预览分类不匹配");
      }
      verifiedCollection = collection;
      sourceCollectionUrl = anchor.href;
    }

    let parsed = await readSource(url.href);
    if (!category && parsed.collection?.issueListUrl) {
      verifiedCollection = parsed.collection;
      sourceCollectionUrl = url.href;
      parsed = await readSource(verifiedCollection.issueListUrl);
    }

    let collection = verifiedCollection || parsed.collection;
    if (!collection && category && parsed.entries.length) {
      const firstPage = url.href.replace(/\/$/, "") === category ? parsed : await readSource(category);
      collection = await collectionForCategory(firstPage, category);
      if (!collection) {
        const categoryPath = new URL(category).pathname;
        collection = { provider: "5280k", externalId: `category:${categoryPath}`, url: category, name: categoryPath.split("/").at(-1) };
      }
    }
    const sourceCollections = parsed.collections.filter((item) => item.externalId !== collection?.externalId || !parsed.entries.length);
    return { ...parsed, collection, sourceCollections, sourceCollectionUrl };
  }

  async function preview(input) {
    if (!input || !["source", "local", "manifest"].includes(input.mode)) throw photoCatalogError("请选择套图入库方式");
    const warnings = [];
    let collection, nextPage, sourceCollections, sourceCollectionUrl;
    let rows;
    if (input.mode === "source") {
      const group = input.localCollectionId ? selectedGroup(input.localCollectionId) : null;
      if (input.archiveQuery !== undefined && (typeof input.archiveQuery !== "string" || input.archiveQuery.length > 240)) {
        throw photoCatalogError("本地压缩包搜索词无效");
      }
      const parsed = await sourceBatch(input);
      ({ collection, nextPage, sourceCollections, sourceCollectionUrl } = parsed);
      rows = sourceRows(parsed.entries, collection, group, input.archiveQuery);
      if (!rows.length && !collection && !sourceCollections?.length) warnings.push("该公开页面没有识别到套图单期或合集");
      const issueFrequency = new Map();
      for (const row of rows) {
        const key = row.issueCode;
        if (key) issueFrequency.set(key, (issueFrequency.get(key) || 0) + 1);
      }
      if ([...issueFrequency.values()].some((count) => count > 1)) {
        warnings.push("本页有不同帖子使用同一期号，请分别核对要关联的压缩包");
      }
    } else {
      rows = input.mode === "local" ? localRows(selectedGroup(input.localCollectionId)) : manifestRows(input.manifest);
      if (input.mode === "manifest" && input.manifest.complete === false) warnings.push("这份清单记录的导入尚未完成，预览仅包含已确认的压缩包");
    }
    const offset = input.offset === undefined ? 0 : input.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && offset >= rows.length)) {
      throw photoCatalogError("预览批次偏移无效");
    }
    const localOwners = new Map();
    const changes = rows.slice(offset, offset + BATCH_SIZE).map((row) => {
      const key = randomUUID();
      if (row.blocked) return { ...row, key, conflicts: [row.blocked], canCommit: false };
      const initial = catalog.preview(rowInput(row));
      const conflicts = initial.conflicts || [];
      if (row.manifestObservation && initial.archives?.[0]?.size !== row.manifestObservation.archiveBytes && !conflicts.length) {
        conflicts.push("本地压缩包大小与清单记录不同");
      }
      const initialArchives = new Map(initial.archives?.map((archive) => [archive.id, archive]));
      const localAlbums = row.localAlbums.map((album) => {
        const verified = initialArchives.get(album.id);
        return verified ? { ...album, size: verified.size, updatedAt: verified.modifiedAt } : album;
      });
      const currentWork = initial.plan?.workId ? catalog.detail(initial.plan.workId) : null;
      const mergeCandidates = [];
      if (row.source && currentWork && !currentWork.archives.length) {
        for (const album of localAlbums) {
          if (!localOwners.has(album.id)) localOwners.set(album.id, catalog.detail(album.id));
          const localWork = localOwners.get(album.id);
          if (localWork && !localWork.sources.length) {
            const fieldConflicts = photoCatalogMergeFieldConflicts(localWork, currentWork);
            mergeCandidates.push({ archiveId: album.id, localWorkId: localWork.id, sourceWorkId: currentWork.id,
              localTitle: localWork.title, sourceTitle: currentWork.title, ...(fieldConflicts.length ? { fieldConflicts } : {}) });
          }
        }
      }
      return { ...row, key, localAlbums, conflicts, candidates: initial.candidates, mergeCandidates, canCommit: conflicts.length === 0,
        workId: currentWork?.id || undefined, title: currentWork?.title || row.title, issueCode: currentWork?.issueCode || row.issueCode };
    });
    const canCommit = changes.some((row) => row.canCommit);
    let planId = "";
    if (canCommit) {
      clearExpiredPlans();
      if (plans.size >= MAX_PLANS) plans.delete(plans.keys().next().value);
      planId = randomUUID();
      plans.set(planId, { expiresAt: now() + PLAN_TTL_MS, rows: new Map(changes.map((row) => [row.key, row])), receipts: new Map() });
    }
    return { planId, changes, warnings, canCommit, collection, sourceCollections, sourceCollectionUrl, nextPage,
      nextOffset: offset + changes.length < rows.length ? offset + changes.length : null };
  }

  function commit(input) {
    if (input?.confirmed !== true) throw photoCatalogError("请先确认套图入库预览");
    clearExpiredPlans();
    const batch = plans.get(input.planId);
    if (!batch) throw photoCatalogError("预览已失效，请重新预览", 409);
    if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > BATCH_SIZE) {
      throw photoCatalogError("请选择有效的预览条目");
    }
    const rowKeys = new Set();
    const usedArchives = new Set();
    const selected = input.changes.map((change) => {
      const row = batch.rows.get(change?.key);
      if (!row || rowKeys.has(row.key)) throw photoCatalogError("条目不属于本次预览或被重复选择");
      rowKeys.add(row.key);
      const archiveIds = change.archiveIds ?? row.archiveIds;
      const candidateIds = new Set(row.localAlbums.map((album) => album.id));
      if (!Array.isArray(archiveIds) || archiveIds.length > MAX_CANDIDATES || archiveIds.some((id) => !candidateIds.has(id))) {
        throw photoCatalogError("请选择预览中的本地压缩包");
      }
      for (const id of archiveIds) {
        if (usedArchives.has(id)) throw photoCatalogError("同一批次的一个压缩包只能配对到一个条目");
        usedArchives.add(id);
      }
      if ((change.title !== undefined && typeof change.title !== "string") ||
          (change.issueCode !== undefined && typeof change.issueCode !== "string") ||
          (change.releaseDate !== undefined && typeof change.releaseDate !== "string") ||
          (change.people !== undefined && !Array.isArray(change.people))) throw photoCatalogError("条目校对字段格式无效");
      if (change.mergeWorkIds !== undefined && (!Array.isArray(change.mergeWorkIds) || change.mergeWorkIds.length !== 2 ||
          !row.mergeCandidates?.some(({ archiveId, localWorkId, sourceWorkId }) => archiveIds.includes(archiveId) &&
            change.mergeWorkIds[0] === localWorkId && change.mergeWorkIds[1] === sourceWorkId))) {
        throw photoCatalogError("请先在本次预览中选择要合并的本地作品与来源作品");
      }
      return { row, values: rowInput(row, change) };
    });
    const results = selected.map(({ row, values }) => {
      const key = row.key;
      if (!row.canCommit) return { key, status: "failed", error: "请先解决该条目的预览冲突" };
      try {
        const fingerprint = JSON.stringify(values);
        const receipt = batch.receipts.get(key);
        if (receipt) {
          if (fingerprint !== receipt.fingerprint) throw photoCatalogError("此条目已入库，修改前请重新预览", 409);
          return { key, status: "replayed", work: receipt.work };
        }
        const { plan, confirmationToken, conflicts, archives } = catalog.preview(values);
        if (conflicts?.length) return { key, status: "failed", error: "来源或本地压缩包关联有冲突", conflicts };
        if (archives?.some((archive) => {
          const reviewed = row.localAlbums.find((album) => album.id === archive.id);
          return reviewed && (Number(reviewed.size) !== archive.size || (reviewed.updatedAt && reviewed.updatedAt !== archive.modifiedAt));
        })) return { key, status: "failed", error: "本地压缩包已变更，请更新套图索引后重新预览" };
        const { work, replayed } = catalog.confirm({ plan, confirmationToken, requestId: `${input.planId}:${key}` });
        batch.receipts.set(key, { fingerprint, work });
        return { key, status: replayed ? "replayed" : "imported", work };
      } catch (error) {
        return { key, status: "failed", error: error.statusCode && error.statusCode < 500 ? error.message : "该条目入库失败，请重试" };
      }
    });
    return {
      imported: results.filter((result) => result.status === "imported").length,
      replayed: results.filter((result) => result.status === "replayed").length,
      failed: results.filter((result) => result.status === "failed").length,
      results
    };
  }

  return { options, preview, commit, clear: () => plans.clear() };
}
