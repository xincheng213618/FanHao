// Pre-generates photo-set covers through the running server's cover route, so
// generation, validation and SQLite writes stay owned by the service itself.
// Order follows what people browse first: every collection cover, then the
// albums of each collection in collection-list order. Cached covers return
// from the service's fast path, so re-running resumes cheaply after a stop.

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}
const baseUrl = String(option("--base-url", `http://127.0.0.1:${process.env.PORT || 29998}`)).replace(/\/+$/, "");
const concurrency = Math.min(8, Math.max(1, Number.parseInt(option("--concurrency", "2"), 10) || 2));
const scope = option("--scope", "all") === "collections" ? "collections" : "all";
const listLimit = 5000;

async function getJson(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} -> HTTP ${response.status}`);
  return response.json();
}

// Without collectionPage the collections view lists top-level categories; with
// it, the flat collection page the browser shows inside them.
async function listAll(query) {
  const items = [];
  for (let offset = 0; ; offset += listLimit) {
    const page = await getJson(`/api/image-library/items?mode=photo&photoView=collections&sort=count${query}&limit=${listLimit}&offset=${offset}`);
    items.push(...(page.items || []));
    if (!page.items?.length || items.length >= Number(page.total || 0)) return items;
  }
}
const categoryList = () => listAll("");
const collectionList = () => listAll("&collectionPage=1&collectionLocale=zh-CN");

async function collectionAlbums(collectionId) {
  const items = [];
  const id = encodeURIComponent(collectionId);
  for (let offset = 0; ; offset += listLimit) {
    const page = await getJson(`/api/image-library/items?mode=photo&photoView=albums&collection=${id}&sort=updated&limit=${listLimit}&offset=${offset}`);
    items.push(...(page.items || []));
    if (!page.items?.length || items.length >= Number(page.total || 0)) return items;
  }
}

const stats = { ok: 0, missing: 0, failed: 0, done: 0, total: 0 };
const seen = new Set();
const startedAt = Date.now();
let lastReport = 0;

function report(label, force = false) {
  const now = Date.now();
  if (!force && now - lastReport < 5000) return;
  lastReport = now;
  const minutes = ((now - startedAt) / 60000).toFixed(1);
  console.log(`[photo-covers] ${label} ${stats.done}/${stats.total} ok=${stats.ok} missing=${stats.missing} failed=${stats.failed} elapsed=${minutes}min`);
}

async function warm(urls, label) {
  const queue = urls.filter((url) => url && !seen.has(url));
  queue.forEach((url) => seen.add(url));
  stats.total += queue.length;
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      const url = queue[next++];
      try {
        const response = await fetch(`${baseUrl}${url}`);
        await response.arrayBuffer();
        if (response.ok) stats.ok += 1;
        else if (response.status === 404) stats.missing += 1;
        else {
          stats.failed += 1;
          // 503 means the cover pool is stopping (service restart); stop cleanly.
          if (response.status === 503) throw new Error("cover service is stopping");
        }
      } catch (error) {
        if (error.message === "cover service is stopping") throw error;
        stats.failed += 1;
      }
      stats.done += 1;
      report(label);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  report(label, true);
}

console.log(`[photo-covers] server=${baseUrl} concurrency=${concurrency} scope=${scope}`);
const categories = await categoryList();
console.log(`[photo-covers] categories=${categories.length}`);
await warm(categories.map((item) => item.coverUrl), "category covers");
const collections = await collectionList();
console.log(`[photo-covers] collections=${collections.length}`);
await warm(collections.map((item) => item.coverUrl), "collection covers");

if (scope === "all") {
  for (const [index, collection] of collections.entries()) {
    const albums = await collectionAlbums(collection.id);
    await warm(albums.map((item) => item.coverUrl), `collection ${index + 1}/${collections.length}`);
  }
}

report("complete", true);
if (stats.failed) process.exitCode = 1;
