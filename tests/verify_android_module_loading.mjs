import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

// Actual complete production loader, native ESM imports and private file URLs.
// Synthetic modules use top-level await gates, not sleeps or replaced import().
// This proves overlap and order; it does not measure WebView startup latency.
const args = process.argv.slice(2);
assert(args.every(value => value === "--legacy-serial-import"), "known arguments");
const repository = fileURLToPath(new URL("../", import.meta.url));
const ownerPath = "android-client/www/js/android-module-registry.js";
const beforeSource = execFileSync("git", ["show", `63c5fab243233e142cfd62c4eaf13812feb92405:${ownerPath}`], {
  cwd: repository, encoding: "utf8"
}).replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(beforeSource).digest("hex"),
  "01dc256cbd23901cc40405c2139af629cd804c53e1216a77e77708a6ade5446e", "fixed complete pre-feature owner");
const currentSource = fs.readFileSync(path.join(repository, ownerPath), "utf8").replaceAll("\r\n", "\n");
const serialAnchor = "const MODULE_IMPORT_BATCH_SIZE = 7;";
assert.equal(currentSource.split(serialAnchor).length, 2, "one bounded-import mechanism");
const serialSource = currentSource.replace(serialAnchor, "const MODULE_IMPORT_BATCH_SIZE = 1;");
assert.equal(serialSource.replace("const MODULE_IMPORT_BATCH_SIZE = 1;", serialAnchor), currentSource,
  "negative control only restores serial import/creation batches");
const temporary = createVerifiedTempDir("fanhao-android-module-loading-");
const controlKey = "__fanhaoAndroidModuleLoadingFixture";
assert.equal(globalThis[controlKey], undefined, "private fixture control owner");
const controls = new Map();
globalThis[controlKey] = controls;
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
let sequence = 0, comparisons = 0;

try {
  const before = await importOwner(beforeSource, "before");
  const current = await importOwner(currentSource, "current");
  const selected = args.includes("--legacy-serial-import") ? await importOwner(serialSource, "selected") : current;
  verifyCatalogs(before, selected);
  await compareScenario(before, selected, "registry", registrySpecs(), async run => {
    const registry = await run.load();
    return exerciseRegistry(registry, run);
  });
  for (const specs of [[], [{ definition: null }, { definition: undefined }, { definition: {} },
    { definition: { id: "no-entry", client: { android: {} } } }, { definition: { id: "falsy-entry", client: { android: { entry: 0 } } } }]]) {
    await compareScenario(before, selected, "skipped-surfaces", specs, async run => {
      const registry = await run.load();
      assert.equal(registry.modules.length, 0);
      assert.equal(run.started.length + run.factories.length + run.errors.length, 0, "missing Android surfaces/entries are skipped");
      return run.snapshot(registry);
    });
  }
  await compareScenario(before, selected, "errors", errorSpecs(), async run => {
    const registry = await run.load();
    assert.deepEqual(registry.modules.map(module => module.id), ["good-first", "good-last"]);
    assert.deepEqual(run.errors.map(error => error.id), ["invalid-path", "invalid-origin", "invalid-dot", "missing-file", "top-throw",
      "top-undefined", "top-null", "no-export", "factory-sync", "factory-async", "null-contract", "no-routes", "bad-route",
      "empty-view", "no-render", "normalize-throw"]);
    return run.snapshot(registry);
  });
  await compareScenario(before, selected, "urls", [
    { id: "slash", entry: "  .\\modules\\entry-0.mjs?keep=a%20b&client=old#hash  " },
    { id: "reuse", reuse: 0 }, { id: "skip", entry: "" }, { id: "no-android", definition: { id: "no-android", client: { web: { entry: "https://invalid.test/never" } } } }
  ], async run => {
    const registry = await run.load({ clientVersion: "release 中文 & +" });
    assert.equal(registry.modules.length, 2);
    assert.equal(run.started.length, 1, "same final URL is evaluated once by native ESM");
    const url = new URL(run.urls[0]);
    assert.equal(url.protocol, "file:");
    assert.equal(url.searchParams.get("keep"), "a b");
    assert.equal(url.searchParams.get("client"), "release 中文 & +");
    assert.equal(url.hash, "#hash");
    assert.equal(run.factories.length, 2, "a cached namespace still creates each declared instance");
    return run.snapshot(registry);
  });
  for (const clientVersion of ["", 0, "0"]) await compareScenario(before, selected, `version-${clientVersion}`, [{ id: "version" }], async run => {
    const registry = await run.load({ clientVersion });
    assert.equal(new URL(run.urls[0]).searchParams.get("client"), clientVersion ? String(clientVersion) : null);
    return run.snapshot(registry);
  });
  await compareScenario(before, selected, "callback-throws", [
    { id: "bad", entry: "./outside.mjs" }, { id: "later-reject", topError: "later" }, { id: "not-created" }
  ], async (run, concurrent) => {
    await assert.rejects(run.load({ onModuleError(definition, error) {
      run.errors.push({ id: definition.id, error: run.errorValue(error) });
      throw new Error("host callback stopped loading");
    } }), /host callback stopped loading/);
    if (concurrent) await until(() => run.finished.length === 2, "already-started imports settle after the host callback throws");
    await nextTurn(); await nextTurn();
    assert.equal(run.factories.length, 0);
    assert.equal(run.consoleErrors.length, 0, "a throwing host callback still precedes console.error");
    return { errors: run.errors, factories: run.factories };
  });
  await verifyBlockedRejection(selected);
  await verifyPrefixProgress(selected);
  console.log(`android module loading: ${comparisons} complete old-owner contracts passed`);
  const seven = await verifyConcurrency(selected, 7);
  const bounded = await verifyConcurrency(selected, 15);
  await nextTurn(); await nextTurn();
  assert.deepEqual(unhandled, [], "every speculative import rejection is observed immediately");
  console.log(JSON.stringify({ normalModules: seven, extendedModules: bounded, unhandledRejections: unhandled.length,
    evidence: "native ESM/top-level-await overlap; sequential factories/normalization/errors; no startup timing claim" }));
} finally {
  process.off("unhandledRejection", onUnhandled);
  delete globalThis[controlKey];
  temporary.cleanup();
}

async function importOwner(source, label) {
  const owner = path.join(temporary.tempDir, `${label}.mjs`);
  fs.writeFileSync(owner, source);
  return import(pathToFileURL(owner).href);
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(predicate, label, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${label} (bounded ${timeout}ms timeout)`);
    await nextTurn();
  }
}

async function scenario(loader, name, specs, action) {
  const key = `${++sequence}-${name}`;
  const dir = path.join(temporary.tempDir, key), modulesDir = path.join(dir, "modules");
  fs.mkdirSync(modulesDir, { recursive: true });
  const definitions = specs.map((spec, index) => Object.hasOwn(spec, "definition") ? spec.definition : {
    id: spec.id, title: `Synthetic ${spec.id}`, order: index,
    client: { android: { entry: spec.entry ?? `./modules/entry-${spec.reuse ?? index}.mjs`, bottomKey: `bottom-${spec.id}` } }
  });
  if (name === "urls") definitions[1].client.android.entry = definitions[0].client.android.entry;
  const run = {
    key, dir, specs, definitions, started: [], finished: [], urls: [], factories: [], events: [], errors: [], consoleErrors: [],
    topGates: specs.map(() => deferred()), factoryGates: specs.map(() => deferred()), active: 0, peak: 0, loading: null,
    topStart(index, url) {
      this.started.push(index); this.urls.push(url); this.active++; this.peak = Math.max(this.peak, this.active);
    },
    topEnd(index) { this.finished.push(index); this.active--; },
    factorySyncStart(index, context) {
      assert.ok(definitions.includes(context.definition));
      assert.equal(context.host, this.host);
      this.factories.push(context.definition.id); this.events.push(`factory-start:${context.definition.id}`);
    },
    async create(index, context) {
      const spec = specs[index], id = context.definition.id;
      assert.equal(context.definition, definitions.find(value => value === context.definition));
      assert.equal(context.host, this.host, "factory receives the real supplied host");
      this.factories.push(id); this.events.push(`factory-start:${id}`);
      if (spec.factoryGate) await this.factoryGates[index].promise;
      if (spec.factoryError) throw new TypeError(spec.factoryError);
      this.events.push(`factory-end:${id}`);
      return makeContract(spec, context.definition, this);
    },
    errorValue(error) {
      if (error instanceof Error) return { name: error.name, code: error.code || "", message: this.clean(error.message) };
      return { type: typeof error, value: error === undefined ? "<undefined>" : error };
    },
    clean(value) {
      return String(value).replaceAll(pathToFileURL(dir).href, "<case-url>").replaceAll(dir, "<case>")
        .replaceAll(pathToFileURL(temporary.tempDir).href, "<temp-url>").replaceAll(temporary.tempDir, "<temp>")
        .replace(/(?:before|current|selected)\.mjs/g, "owner.mjs");
    },
    load(overrides = {}, options) {
      assert.equal(this.loading, null, "one load per private module namespace");
      this.host = { clientVersion: "fixture-v1", onModuleError: (definition, error) => {
        this.errors.push({ id: definition.id, error: this.errorValue(error) }); this.events.push(`error:${definition.id}`);
      }, ...overrides };
      this.loading = loader.loadAndroidModules(definitions, this.host, undefined, options);
      return this.loading;
    },
    snapshot(registry) {
      return { modules: registry.modules.map(module => ({ id: module.id, keys: Object.keys(module), bottomKey: module.bottomKey,
        rootViews: [...module.rootViews], routes: module.routes.map(route => ({ keys: Object.keys(route), view: route.view, match: !!route.match })),
        api: module.api, search: !!module.search, chrome: !!module.renderChrome, back: !!module.handleBack, deactivate: !!module.deactivate })),
      events: this.events, errors: this.errors, consoleErrors: this.consoleErrors,
      urls: this.urls.map(url => this.clean(url)).sort() };
    }
  };
  controls.set(key, run);
  for (let index = 0; index < specs.length; index++) {
    const spec = specs[index];
    if (spec.missing || spec.reuse !== undefined) continue;
    fs.writeFileSync(path.join(modulesDir, `entry-${index}.mjs`), [
      `const control = globalThis[${JSON.stringify(controlKey)}].get(${JSON.stringify(key)});`,
      `control.topStart(${index}, import.meta.url);`,
      spec.topGate ? `await control.topGates[${index}].promise;` : "",
      `control.topEnd(${index});`,
      Object.hasOwn(spec, "topError") ? `throw ${spec.topError === undefined ? "undefined" : JSON.stringify(spec.topError)};` : "",
      spec.noExport ? "export const unrelated = true;" : spec.factorySyncError
        ? `export function createAndroidModule(context) { control.factorySyncStart(${index}, context); throw new Error(${JSON.stringify(spec.factorySyncError)}); }`
        : `export function createAndroidModule(context) { return control.create(${index}, context); }`
    ].join("\n"));
  }
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document"), originalError = console.error;
  Object.defineProperty(globalThis, "document", { value: { baseURI: pathToFileURL(path.join(dir, "index.html")).href }, configurable: true });
  console.error = (prefix, error) => run.consoleErrors.push({ prefix, error: run.errorValue(error) });
  try { return await action(run); }
  finally {
    for (const gate of [...run.topGates, ...run.factoryGates]) gate.resolve();
    await run.loading?.catch(() => {});
    await nextTurn();
    console.error = originalError;
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument); else delete globalThis.document;
    controls.delete(key);
  }
}

async function compareScenario(before, selected, name, specs, action) {
  const expected = await scenario(before, name, specs, run => action(run, false));
  const actual = await scenario(selected, name, specs, run => action(run, !args.includes("--legacy-serial-import")));
  assert.deepEqual(actual, expected, `${name}: complete observable old registry contract`);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${name}: observable field and callback order`);
  comparisons++;
}

function makeContract(spec, definition, run) {
  if (spec.nullContract) return null;
  const tag = spec.tag || definition.id;
  const route = { view: spec.view || `view-${definition.id}`,
    match: spec.matchFirst ? params => params.which === "first" : null,
    render: (params, guard) => { run.events.push(["render", tag, params, guard]); return { tag, params, guard }; } };
  const routes = spec.noRoutes ? [] : spec.badRoute ? [null] : [{ ...route,
    ...(spec.emptyView ? { view: " " } : {}), ...(spec.noRender ? { render: false } : {}) }];
  const value = {
    get routes() { run.events.push(`normalize:${definition.id}`); if (spec.normalizeError) throw new Error("normalize getter failed"); return routes; },
    rootViews: ["root", 3], isRootView: view => view === "root", bottomKey: spec.customBottom || "",
    api: { tag },
    search: spec.rich ? { marker: tag, matches: (_view, params) => !!params.search } : "ignored",
    renderChrome: spec.rich ? ({ container, view, params }) => {
      run.events.push(["chrome", tag, view, params, container.marker]); return container.result;
    } : null,
    deactivate: () => run.events.push(`deactivate:${tag}`),
    handleBack: spec.rich ? (_view, params) => params.back && "handled" : null
  };
  return value;
}

function registrySpecs() {
  return [{ id: "duplicate", tag: "first", view: "shared", matchFirst: true, rich: true, customBottom: "custom" },
    { id: "second", view: "shared" }, { id: "duplicate", tag: "last", view: "other" }];
}

function exerciseRegistry(registry, run) {
  assert.ok(Object.isFrozen(registry) && Object.isFrozen(registry.modules));
  for (let index = 0; index < registry.modules.length; index++) {
    const module = registry.modules[index];
    assert.equal(module.definition, run.definitions[index]);
    assert.ok(Object.isFrozen(module) && Object.isFrozen(module.routes) && Object.isFrozen(module.routes[0]));
    assert.equal(module.isRootView("root"), true);
    assert.deepEqual([...module.rootViews], ["root", "3"]);
  }
  assert.equal(registry.get("duplicate").api.tag, "last", "get uses the last duplicate id");
  assert.equal(registry.get("missing"), null);
  assert.equal(registry.resolve("shared", { which: "first" }).module.api.tag, "first", "route priority retains definition order");
  assert.equal(registry.resolve("shared", { which: "second" }).module.id, "second");
  assert.equal(registry.resolve("missing"), null);
  const params = { which: "first", search: true, back: true }, guard = { token: 1 };
  const rendered = registry.render("shared", params, guard);
  assert.equal(rendered.params, params); assert.equal(rendered.guard, guard);
  assert.equal(registry.render("missing"), undefined);
  assert.equal(registry.searchFor("shared", params), registry.modules[0].search);
  assert.equal(registry.searchFor("shared", { which: "first", search: false }), null);
  assert.equal(registry.searchFor("shared", { which: "second" }), null);
  assert.equal(registry.searchFor("missing"), null);
  assert.equal(registry.renderChrome("shared", params, { marker: "yes" }), true, "undefined chrome result is handled");
  assert.equal(registry.renderChrome("shared", params, { marker: "no", result: false }), false);
  assert.equal(registry.renderChrome("shared", params, null), false);
  assert.equal(registry.renderChrome("missing", {}, {}), false);
  assert.equal(registry.handleBack("shared", params), true);
  assert.equal(registry.handleBack("shared", { which: "first" }), false);
  assert.equal(registry.handleBack("missing"), false);
  registry.deactivateExcept("shared", params);
  registry.deactivateExcept("missing");
  return { keys: Object.keys(registry), ...run.snapshot(registry), rendered };
}

function errorSpecs() {
  return [{ id: "skip-no-surface", definition: { id: "skip-no-surface" } }, { id: "skip-empty", entry: "" },
    { id: "invalid-path", entry: "./outside.mjs" }, { id: "invalid-origin", entry: "https://invalid.test/modules/x.mjs" },
    { id: "invalid-dot", entry: "./modules/contains..dots.mjs" }, { id: "good-first" }, { id: "missing-file", missing: true },
    { id: "top-throw", topError: "top rejection" }, { id: "top-undefined", topError: undefined }, { id: "top-null", topError: null },
    { id: "no-export", noExport: true }, { id: "factory-sync", factorySyncError: "sync factory failed" },
    { id: "factory-async", factoryError: "async factory failed" }, { id: "null-contract", nullContract: true },
    { id: "no-routes", noRoutes: true }, { id: "bad-route", badRoute: true }, { id: "empty-view", emptyView: true },
    { id: "no-render", noRender: true }, { id: "normalize-throw", normalizeError: true }, { id: "good-last" }];
}

function verifyCatalogs(before, selected) {
  assert.deepEqual(selected.androidModuleFallbackCatalog(), before.androidModuleFallbackCatalog());
  const first = selected.androidModuleFallbackCatalog();
  assert.equal(first.length, 7);
  first[0].title = "changed"; first[0].client.android.entry = "./modules/changed.mjs";
  assert.deepEqual(selected.androidModuleFallbackCatalog(), before.androidModuleFallbackCatalog(), "catalog copies isolate callers");
  for (const remote of [undefined, null, [], [{ id: "music", title: "Remote music", order: 5, client: { android: { bottomKey: "remote" } } },
    { id: "extension", order: 11, client: { android: { entry: "./modules/extension.mjs" } } },
    { id: "not-android", client: { web: { entry: "./elsewhere" } } }]]) {
    assert.deepEqual(selected.mergeAndroidModuleCatalog(remote), before.mergeAndroidModuleCatalog(remote));
    comparisons++;
  }
}

async function verifyBlockedRejection(loader) {
  await scenario(loader, "blocked-rejection", [{ id: "first", factoryGate: true }, { id: "early-rejection", topError: "observed while factory awaits" }], async run => {
    const loading = run.load();
    await until(() => run.factories.length === 1, "first asynchronous factory starts");
    // Serial imports intentionally cannot reach the later module while this
    // factory is gated; their negative control fails the overlap gate below.
    if (!args.includes("--legacy-serial-import")) await until(() => run.finished.includes(1), "later rejected module has actually evaluated");
    await nextTurn(); await nextTurn();
    assert.equal(run.errors.length, 0, "later import errors wait for the earlier asynchronous factory");
    assert.deepEqual(unhandled, [], "later rejected import is handled while the first factory is blocked");
    run.factoryGates[0].resolve();
    const registry = await loading;
    assert.deepEqual(registry.modules.map(module => module.id), ["first"]);
    assert.deepEqual(run.errors.map(error => error.id), ["early-rejection"]);
  });
}

async function verifyPrefixProgress(loader) {
  await scenario(loader, "ordered-prefix", [
    { id: "owner", tag: "preferred", view: "shared", matchFirst: true },
    { id: "failed", factoryError: "fixture factory failure" },
    { id: "fallback", view: "shared", factoryGate: true },
    { id: "owner", tag: "last", view: "other" }
  ], async (run) => {
    const progress = [];
    const loading = run.load({}, { onProgress(module, getRegistry) {
      progress.push({ module, getRegistry });
    } });
    await until(() => run.factories.includes("fallback"), "the suffix factory starts and remains held");
    assert.deepEqual(progress.map(({ module }) => module.api.tag), ["preferred"], "only normalized successes are published");
    assert.deepEqual(run.errors.map(({ id }) => id), ["failed"]);
    const first = progress[0].getRegistry();
    assert(Object.isFrozen(first) && Object.isFrozen(first.modules));
    assert.equal(first.resolve("shared", { which: "first" }).module, progress[0].module);
    assert.equal(first.resolve("shared", { which: "second" }), null);

    run.factoryGates[2].resolve();
    const complete = await loading;
    assert.deepEqual(run.factories, ["owner", "failed", "fallback", "owner"]);
    assert.deepEqual(progress.map(({ module }) => module.api.tag), ["preferred", "fallback", "last"]);
    assert.equal(complete.resolve("shared", { which: "first" }).module, progress[0].module, "a later match cannot take over an earlier route");
    assert.equal(complete.get("owner").api.tag, "last", "the final registry retains last duplicate ID lookup");
    assert.equal(first, progress[0].getRegistry());
    assert.equal(first.get("owner").api.tag, "preferred");
    assert.equal(first.resolve("shared", { which: "second" }), null, "an existing prefix never acquires suffix routes");

    const second = progress[1].getRegistry();
    assert.deepEqual(second.modules.map((module) => module.api.tag), ["preferred", "fallback"], "a deferred getter remains anchored to the reported prefix");
    assert.equal(second.resolve("shared", { which: "second" }).module, progress[1].module);
    assert.equal(second.resolve("other"), null);
    assert.equal(second, progress[1].getRegistry());
  });

  const failure = new Error("progress observer stopped loading");
  for (const asynchronous of [false, true]) {
    await scenario(loader, `observer-failure-${asynchronous}`, [{ id: "first" }, { id: "unreached" }], async (run) => {
      const onProgress = asynchronous ? () => Promise.reject(failure) : () => { throw failure; };
      await assert.rejects(run.load({}, { onProgress }), (error) => error === failure);
      assert.deepEqual(run.factories, ["first"]);
      assert.deepEqual(run.errors, [], "observer failure is not a module failure");
      assert.deepEqual(run.consoleErrors, []);
    });
  }
  console.log("android module progress: ordered, immutable lazy prefixes and observer error propagation passed");
}

async function verifyConcurrency(loader, count) {
  return scenario(loader, `concurrent-${count}`, Array.from({ length: count }, (_, index) => ({
    id: `module-${index}`, topGate: true, factoryGate: true
  })), async run => {
    const loading = run.load();
    for (let first = 0; first < count; first += 7) {
      const size = Math.min(7, count - first), end = first + size;
      await until(() => run.started.length >= end, `${count} modules: ${size} imports start before any in their batch is released`);
      assert.equal(run.started.length, end, "imports beyond the current seven wait for batch creation");
      assert.deepEqual([...run.started.slice(first)].sort((a, b) => a - b), Array.from({ length: size }, (_, index) => first + index));
      for (let index = end - 1; index > first; index--) run.topGates[index].resolve();
      await until(() => run.finished.length === end - 1, "later top-level awaits finish first");
      assert.equal(run.factories.length, first, "import completion order cannot reorder factories");
      run.topGates[first].resolve();
      for (let index = first; index < end; index++) {
        await until(() => run.factories.length === index + 1, `factory ${index} starts in definition order`);
        assert.deepEqual(run.factories, Array.from({ length: index + 1 }, (_, n) => `module-${n}`));
        assert.equal(run.started.length, end, "a blocked factory cannot launch the next import batch");
        run.factoryGates[index].resolve();
      }
    }
    const registry = await loading;
    assert.deepEqual(registry.modules.map(module => module.id), Array.from({ length: count }, (_, index) => `module-${index}`));
    assert.equal(run.peak, Math.min(7, count), "at most seven top-level imports are active");
    assert.equal(run.active, 0);
    const expectedEvents = Array.from({ length: count }, (_, index) => [
      `factory-start:module-${index}`, `factory-end:module-${index}`, `normalize:module-${index}`, `normalize:module-${index}`
    ]).flat();
    assert.deepEqual(run.events, expectedEvents, "each asynchronous factory completes and normalizes before the next begins");
    return { count, peakImports: run.peak, orderedFactories: run.factories.length };
  });
}
