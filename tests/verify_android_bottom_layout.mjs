import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

// Actual index/app/navigation/modules/CSS, private browser persistence and a
// synthetic-only loopback server. No production library, media or native bridge.
const root = path.resolve(import.meta.dirname, "..");
const noDynamic = process.argv.includes("--no-dynamic");
const noFocusMargin = process.argv.includes("--no-focus-margin");
const legacyMenuSuppression = process.argv.includes("--legacy-menu-suppression");
const noMenuBack = process.argv.includes("--no-menu-back");
const menusOnly = process.argv.includes("--menus-only") || legacyMenuSuppression || noMenuBack;
const menuNegativeCase = legacyMenuSuppression ? "menus: trusted long press cannot swallow the next native Enter or Space"
  : noMenuBack ? "menus: actual native Back closes only the menu and restores its trigger" : "";
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the actual Android shell fixture");
const service = spawn(process.execPath, ["tests/serve_android_gallery_navigation_fixture.mjs"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
const serviceExit = new Promise(resolve => service.once("exit", resolve));
let browser, checks = 0;
const errors = [], profiles = [];
const safeSessions = new WeakMap();
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
const run = async (name, task) => {
  if (menusOnly && !name.startsWith("menus:")) return;
  if (menuNegativeCase && name !== menuNegativeCase) return;
  if (noFocusMargin && !name.startsWith("real shell: native Tab")) return;
  await task(); checks++; console.log(`PASS ${name}`);
};
let runUrl;
try {
  const origin = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("actual shell fixture startup timed out")), 15000);
    service.stdout.on("data", bytes => { output += bytes; const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timer); resolve(match[0]); } });
    service.once("error", error => { clearTimeout(timer); reject(error); });
    service.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited before startup (${code})`)); });
  });
  const response = await fetch(`${origin}/fixture/new-run?scenario=music-bottom-layout`, { method: "POST" });
  assert.equal(response.status, 200);
  const frozen = await response.json(); runUrl = new URL(frozen.url, origin).href;
  assert.equal(frozen.scenario, "music-bottom-layout");
  browser = await chromium.launch({ executablePath, headless: true });

  await run("real shell: normal/font32 and native safe-area profiles keep navigation and mini controls separate", async () => {
    const page = await newPage();
    try {
      for (const viewport of [{ width: 568, height: 320 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        for (const font32 of [false, true]) {
          let baseline;
          for (const safe of [0, 24]) {
            await profile(page, { font32, safe });
            const result = await geometry(page); assertLayout(result);
            assert.equal(result.labelFont, font32 ? 32 : result.labelFont);
            if (safe === 0) baseline = result;
            else {
              assert(Math.abs(result.navHeight - baseline.navHeight - 24) <= 1, "safe area contributes once to the measured border box");
              assert(Math.abs(result.miniBottom - baseline.miniBottom + 24) <= 1, "mini offset must not add safe area a second time");
              assert(Math.abs(result.navPaddingBottom - baseline.navPaddingBottom - 24) <= 1, "the browser's actual env() override must take effect");
            }
            profiles.push({ ...viewport, font32, safe, ...result });
          }
        }
      }
    } finally { await page.close(); }
  });
  await run("real shell: search hides navigation without persisting zero and restores its measured height", async () => {
    const page = await newPage();
    try {
      await profile(page, { font32: true, safe: 24 }); const before = await geometry(page); assertLayout(before);
      await page.locator('.music-mobile-focused-library-search,.music-mobile-home-search').click();
      await page.waitForFunction(() => getComputedStyle(document.querySelector(".bottom-nav")).display === "none"); await frames(page);
      assert.equal(await page.evaluate(() => parseFloat(document.documentElement.style.getPropertyValue("--fanhao-bottom-nav-height"))), before.inlineHeight);
      assert.equal(await page.locator(".music-mobile-mini-player").count(), 0);
      await page.locator(".music-mobile-search-back").click(); await page.locator(".music-mobile-mini-player").waitFor(); await frames(page);
      const after = await geometry(page); assertLayout(after); assert(Math.abs(after.navHeight - before.navHeight) <= 1);
    } finally { await page.close(); }
  });
  await run("real shell: all three actual navigation pickers remain inside safe bounds and their last choice is clickable", async () => {
    const page = await newPage();
    try {
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
        for (const menu of [
          { trigger: "[data-home-switcher]", name: "选择首页类型", field: "homeModeCurrent", choice: "homeModeChoice" },
          { trigger: "[data-gallery-switcher]", name: "选择图库或影视", field: "galleryModeCurrent", choice: "galleryModeChoice" },
          { trigger: "[data-reading-switcher]", name: "选择阅读类型", field: "readingModeCurrent", choice: "readingModeChoice" }
        ]) {
          await page.goto(runUrl); await page.locator(".music-mobile-mini-player").waitFor(); await page.setViewportSize(viewport);
          await profile(page, { font32: true, safe: 24 });
          await page.locator(`.bottom-nav ${menu.trigger}`).click({ button: "right" });
          const picker = page.getByRole("menu", { name: menu.name, exact: true }); await picker.waitFor({ state: "visible" });
          const bounds = await picker.boundingBox(); assert(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1);
          assert(bounds.y >= (viewport.height <= 390 ? 32 : 20) - 1, "picker starts below the simulated safe top, including short landscape");
          const choices = picker.getByRole("menuitemradio"); assert(await choices.count() >= 2);
          for (const choice of [choices.first(), choices.last()]) assert.equal(await centerHit(page, choice), true, `${menu.name}: actual choice remains scrollable and unobscured`);
          const last = choices.last(), selected = await last.evaluate((node, key) => node.dataset[key], menu.choice);
          await last.click(); await frames(page);
          assert.equal(await page.locator(`.bottom-nav ${menu.trigger}`).evaluate((node, key) => node.dataset[key], menu.field), selected);
          assert.equal(await picker.isVisible(), false);
        }
      }
    } finally { await page.close(); }
  });
  await run("real shell: the deep last song stays clickable above both fixed bars", async () => {
    const page = await newPage();
    try {
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 568, height: 320 }]) {
        await page.goto(runUrl); await page.locator(".music-mobile-mini-player").waitFor(); await page.setViewportSize(viewport); await profile(page, { font32: true, safe: 24 });
        while (await page.locator(".music-mobile-track").count() < 200) {
          const count = await page.locator(".music-mobile-track").count(), more = page.locator(".music-mobile-load-more");
          assert.equal(await centerHit(page, more), true); await more.click();
          await page.waitForFunction(count => document.querySelectorAll(".music-mobile-track").length > count, count);
        }
        await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await frames(page);
        const last = page.locator('[data-track-id="fixture-bottom-track-200"]'), more = last.locator(".track-more");
        assert.equal(await centerHit(page, more), true, "the deep last row can actually scroll into the unobscured content band");
        await more.click(); const sheet = page.locator(".music-mobile-track-actions-sheet"); await sheet.waitFor();
        assert.equal(await centerHit(page, sheet.getByRole("button", { name: "完成", exact: true })), true);
        await sheet.getByRole("button", { name: "完成", exact: true }).click();
      }
    } finally { await page.close(); }
  });
  await run("real shell: no ResizeObserver still measures initially and refreshes on viewport resize", async () => {
    const page = await newPage({ noRO: true });
    try {
      assert.equal(await page.evaluate(() => typeof ResizeObserver), "undefined");
      for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport); await frames(page); assertLayout(await geometry(page));
      }
    } finally { await page.close(); }
  });
  await run("real shell: native Tab reveals the next row and its buttons above the fixed bars", async () => {
    const page = await newPage();
    try {
      for (const viewport of [{ width: 568, height: 320 }, { width: 320, height: 568 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport); await profile(page, { font32: true, safe: 24 });
        const preceding = page.locator('[data-track-id="fixture-bottom-track-010"] .track-more');
        await preceding.evaluate(node => {
          const b = node.getBoundingClientRect(), limit = document.querySelector(".music-mobile-mini-player").getBoundingClientRect().top;
          scrollBy(0, b.top + b.height / 2 - Math.max(90, limit - 50)); node.focus({ preventScroll: true });
        });
        await frames(page);
        assert.equal(await centerHit(page, preceding, { scroll: false }), true, "start from the visible preceding row's More control");
        const before = await page.evaluate(() => scrollY);
        for (const kind of ["music-mobile-track", "track-favorite", "track-more"]) {
          // Deliberately no scrollIntoView(), scrollBy(), or focus() after Tab.
          // The browser must honor the product's native focus scroll margin.
          await page.keyboard.press("Tab"); await frames(page);
          const focused = await page.evaluate(kind => {
            const node = document.activeElement, b = node.getBoundingClientRect(), mini = document.querySelector(".music-mobile-mini-player").getBoundingClientRect();
            const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
            return { kind: node.classList.contains(kind), row: node.closest(".music-mobile-track")?.dataset.trackId,
              top: b.top, bottom: b.bottom, miniTop: mini.top, centerHit: hit === node || node.contains(hit), scroll: scrollY };
          }, kind);
          assert.equal(focused.kind, true); assert.equal(focused.row, "fixture-bottom-track-011");
          assert.equal(focused.centerHit, true, `real Tab target is not covered by a bar: ${JSON.stringify(focused)}`);
          assert(focused.top >= 0 && focused.bottom <= focused.miniTop + 1, "the focused row/control lies completely above the mini player");
          assert(focused.scroll > before, "native focus automatically moves the occluded next row into the usable viewport");
        }
      }
    } finally { await page.close(); }
  });
  await verifyNavigationMenus();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ profiles, scope: "Actual app shell; synthetic read-only API; font32 is controlled rendering pressure, native env is CDP-emulated; no OS font-scale or device playback claim" }));
  console.log(`PASS Android bottom layout: ${checks} actual Chromium scenarios`);
} finally {
  await browser?.close(); service.kill("SIGTERM");
  await Promise.race([serviceExit, new Promise(resolve => setTimeout(resolve, 3000))]);
}

async function newPage({ noRO = false, touch = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: touch });
  page.on("pageerror", error => errors.push(error.message));
  if (noRO) await page.addInitScript(() => { window.ResizeObserver = undefined; });
  if (noDynamic || legacyMenuSuppression || noMenuBack) await page.route(url => /\/www\/app\.js$/.test(url.pathname), async route => {
    const response = await route.fetch(); let body = await response.text();
    const change = (marker, replacement) => { assert.equal(body.split(marker).length, 2, "negative control changes one actual app hook"); body = body.replace(marker, replacement); };
    if (noDynamic) change("const bottomLayout = installBottomLayout({ nav: els.bottomNavBar });", "const bottomLayout = { refresh() {} };");
    if (legacyMenuSuppression) change("if (suppressedBottomNavButton === button && event.detail !== 0)", "if (suppressedBottomNavButton === button)");
    if (noMenuBack) change("  if (closeActiveModePicker(true)) return true;", "  /* menu native-Back priority omitted */");
    await route.fulfill({ response, body });
  });
  if (noFocusMargin) await page.route(url => url.pathname.endsWith("/modules/music/home.css"), async route => {
    const response = await route.fetch(), source = await response.text(), marker = "  scroll-margin-block-end: calc(var(--fanhao-bottom-nav-height) + 76px);";
    assert.equal(source.split(marker).length, 2, "negative control removes one actual native-focus margin");
    await route.fulfill({ response, body: source.replace(marker, "  /* native-focus bottom margin omitted */") });
  });
  await page.goto(runUrl); await page.locator(".music-mobile-mini-player").waitFor(); await frames(page); return page;
}
async function verifyNavigationMenus() {
  const configs = [
    { key: "home", trigger: "[data-home-switcher]", name: "选择首页类型", field: "homeModeCurrent", choice: "homeModeChoice",
      previous: ".music-mobile-mini-queue", next: ".bottom-nav [data-gallery-switcher]" },
    { key: "gallery", trigger: "[data-gallery-switcher]", name: "选择图库或影视", field: "galleryModeCurrent", choice: "galleryModeChoice",
      previous: ".bottom-nav [data-home-switcher]", next: '.bottom-nav [data-open-view="shortVideos"]' },
    { key: "reading", trigger: "[data-reading-switcher]", name: "选择阅读类型", field: "readingModeCurrent", choice: "readingModeChoice",
      previous: '.bottom-nav [data-open-view="shortVideos"]', next: '.bottom-nav [data-bottom-key="tools"]' }
  ];
  const trigger = (page, config) => page.locator(`.bottom-nav ${config.trigger}`);
  const menu = (page, config) => page.getByRole("menu", { name: config.name, exact: true });
  const setup = async ({ touch = false, short = false } = {}) => {
    const page = await newPage({ touch });
    if (short) await page.setViewportSize({ width: 568, height: 320 });
    await profile(page, { font32: short, safe: short ? 24 : 0 });
    await page.waitForFunction(() => document.querySelectorAll(".music-mobile-track").length === 80);
    await page.mouse.move(20, 180); await page.mouse.wheel(0, 900); await frames(page);
    return page;
  };
  const fingerprint = page => page.evaluate(() => ({ url: location.href, view: document.getElementById("contentPanel").dataset.view,
    scroll: scrollY, history: history.length, rows: document.querySelectorAll(".music-mobile-track").length,
    modes: [document.querySelector("[data-home-switcher]")?.dataset.homeModeCurrent,
      document.querySelector("[data-gallery-switcher]")?.dataset.galleryModeCurrent, document.querySelector("[data-reading-switcher]")?.dataset.readingModeCurrent] }));
  const open = async (page, config, method = "right") => {
    const button = trigger(page, config);
    if (method === "right") await button.click({ button: "right" });
    else { await button.focus(); await page.keyboard.press(method); }
    const picker = menu(page, config); await picker.waitFor({ state: "visible" }); await frames(page); return picker;
  };
  const assertOpen = async (page, config, detail = "") => {
    const picker = menu(page, config), selected = picker.locator('[role="menuitemradio"][aria-checked="true"]');
    assert.equal(await page.getByRole("menu").count(), 1); assert.equal(await selected.count(), 1);
    assert.equal(await trigger(page, config).getAttribute("aria-expanded"), "true");
    const focus = await selected.evaluate(node => ({ selected: document.activeElement === node, checked: node.textContent,
      tag: document.activeElement.tagName, role: document.activeElement.getAttribute("role"), active: document.activeElement.className, text: document.activeElement.textContent.slice(0, 80) }));
    assert.equal(focus.selected, true, `${config.key} ${detail}: opening focuses the actual current option: ${JSON.stringify(focus)}`);
  };
  const assertClosed = async (page, config, { focus = true } = {}) => {
    await menu(page, config).waitFor({ state: "hidden" }); await frames(page);
    assert.equal(await trigger(page, config).getAttribute("aria-expanded"), "false");
    if (focus) assert.equal(await trigger(page, config).evaluate(node => node.isConnected && document.activeElement === node), true);
  };
  const focusedChoice = async (picker, index) => {
    assert.equal(await picker.getByRole("menuitemradio").nth(index).evaluate(node => document.activeElement === node), true);
    assert.equal(await picker.evaluate(node => {
      const active = document.activeElement, box = active.getBoundingClientRect(), panel = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return node.contains(active) && box.top >= panel.top && box.bottom <= panel.bottom
        && box.top >= 0 && box.bottom <= innerHeight && (hit === active || active.contains(hit));
    }), true, "keyboard focus itself reveals the option without scripted scroll");
  };
  await run("menus: context and trigger arrows focus current choices without changing the page", async () => {
    const page = await setup();
    try {
      for (const config of configs) for (const method of ["right", "ArrowDown", "ArrowUp"]) {
        const before = await fingerprint(page); await open(page, config, method); await assertOpen(page, config);
        assert.deepEqual(await fingerprint(page), before);
        await page.keyboard.press("Escape"); await assertClosed(page, config); assert.deepEqual(await fingerprint(page), before);
      }
      await open(page, configs[0]); await open(page, configs[1]);
      assert.equal(await menu(page, configs[0]).isVisible(), false); await assertOpen(page, configs[1]);
      await page.keyboard.press("Escape"); await assertClosed(page, configs[1]);
    } finally { await page.close(); }
  });
  await run("menus: trusted long press cannot swallow the next native Enter or Space", async () => {
    for (const config of configs) for (const key of ["Enter", "Space"]) {
      const page = await setup({ touch: true });
      try {
        if (config.key === "home" && key === "Space") await page.evaluate(() => {
          window.__menuTouchTrace = [];
          for (const type of ["touchstart", "focusin", "touchend", "mousedown", "mouseup", "click"]) document.addEventListener(type, event => {
            __menuTouchTrace.push({ type, detail: event.detail, target: event.target.getAttribute?.("class"),
              active: document.activeElement.getAttribute("class"), role: document.activeElement.getAttribute("role") });
          }, true);
        });
        const before = await fingerprint(page), box = await trigger(page, config).boundingBox(), cdp = safeSessions.get(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 1 }] });
        await menu(page, config).waitFor({ state: "visible", timeout: 3000 });
        const beforeRelease = await menu(page, config).evaluate(node => ({ menuVisible: !node.hidden, activeRole: document.activeElement.getAttribute("role"), active: document.activeElement.className }));
        // Cancel models the valid WebView path with no compatibility click;
        // touchEnd separately checks the path which does produce that click.
        await cdp.send("Input.dispatchTouchEvent", { type: key === "Enter" ? "touchCancel" : "touchEnd", touchPoints: [] }); await page.waitForTimeout(300);
        if (config.key === "home" && key === "Space") console.log(JSON.stringify(await page.evaluate(beforeRelease => ({ probe: "trusted-touch-release-focus",
          beforeRelease, afterRelease: { activeRole: document.activeElement.getAttribute("role"), active: document.activeElement.className }, events: __menuTouchTrace }), beforeRelease)));
        await assertOpen(page, config, `after trusted ${key === "Enter" ? "touchCancel" : "touchEnd"}`); assert.deepEqual(await fingerprint(page), before, "ending a long press must not navigate through a compatibility click");
        await page.keyboard.press("Escape"); await assertClosed(page, config);
        // No pointerdown between Escape and the next actual keyboard click.
        await page.keyboard.press(key);
        await frames(page); assert.equal(await page.getByRole("menu").count(), 0);
        const after = await fingerprint(page);
        if (config.key === "reading") assert.equal(after.scroll, 0, "the next native keyboard click must reach active-root scroll-to-top");
        else { assert.notEqual(after.url, before.url, "the next native keyboard click must reach real navigation"); await page.waitForFunction(() => document.getElementById("contentPanel").dataset.view !== "music"); }
      } finally { await page.close(); }
    }
    for (const method of ["Escape", "Back"]) {
      const page = await setup({ touch: true }), config = configs[1];
      try {
        const before = await fingerprint(page), box = await trigger(page, config).boundingBox(), cdp = safeSessions.get(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 8 }] });
        const picker = menu(page, config); await picker.waitFor({ state: "visible", timeout: 3000 });
        await page.keyboard.press("End"); await focusedChoice(picker, await picker.getByRole("menuitemradio").count() - 1);
        if (method === "Escape") await page.keyboard.press("Escape"); else assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
        await assertClosed(page, config);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await page.waitForTimeout(300);
        await assertClosed(page, config); assert.deepEqual(await fingerprint(page), before, "releasing after explicit close cannot reopen, navigate or recover focus into a stale menu");
      } finally { await page.close(); }
    }
  });
  await run("menus: Home End and arrow navigation reveal choices in a short-screen picker", async () => {
    const page = await setup({ short: true });
    try {
      for (const config of configs) {
        const before = await fingerprint(page), picker = await open(page, config, "ArrowDown"); await assertOpen(page, config);
        const last = await picker.getByRole("menuitemradio").count() - 1;
        const checked = await picker.locator('[aria-checked="true"]').evaluate((node, key) => node.dataset[key], config.choice);
        await page.keyboard.press("Home"); await focusedChoice(picker, 0);
        await page.keyboard.press("ArrowDown"); await focusedChoice(picker, 1);
        await page.keyboard.press("ArrowUp"); await focusedChoice(picker, 0);
        await page.keyboard.press("End"); await focusedChoice(picker, last);
        assert.deepEqual(await fingerprint(page), before, "roving focus must not navigate or scroll the document");
        assert.equal(await picker.locator('[aria-checked="true"]').count(), 1, "roving focus does not silently choose an option");
        assert.equal(await picker.locator('[aria-checked="true"]').evaluate((node, key) => node.dataset[key], config.choice), checked);
        await page.keyboard.press("Escape"); await assertClosed(page, config);
      }
    } finally { await page.close(); }
  });
  await run("menus: Tab and ShiftTab close then continue natively from the trigger", async () => {
    const page = await setup();
    try {
      for (const config of configs) for (const key of ["Tab", "Shift+Tab"]) {
        const before = await fingerprint(page); await open(page, config, "ArrowDown"); await assertOpen(page, config);
        await page.keyboard.press(key); await assertClosed(page, config, { focus: false });
        const destination = page.locator(key === "Tab" ? config.next : config.previous);
        assert.equal(await destination.evaluate(node => document.activeElement === node), true, "native Tab continues to the real adjacent control");
        assert.deepEqual(await fingerprint(page), before);
      }
    } finally { await page.close(); }
  });
  await run("menus: actual native Back closes only the menu and restores its trigger", async () => {
    const page = await setup();
    try {
      assert.equal(await page.evaluate(() => typeof window.fanhaoHandleNativeBack), "function");
      for (const config of configs) {
        const before = await fingerprint(page); await open(page, config); await assertOpen(page, config);
        assert.equal(await page.evaluate(() => window.fanhaoHandleNativeBack()), true);
        await assertClosed(page, config); assert.deepEqual(await fingerprint(page), before, "native Back consumes only the open menu");
      }
    } finally { await page.close(); }
  });
  await run("menus: choosing a different route never restores focus to the old navigation trigger", async () => {
    for (const config of configs) {
      const page = await setup();
      try {
        const before = await fingerprint(page), picker = await open(page, config, "ArrowDown"), choices = picker.getByRole("menuitemradio");
        const checkedLast = await choices.last().getAttribute("aria-checked") === "true";
        await page.keyboard.press(checkedLast ? "Home" : "End");
        const chosen = checkedLast ? choices.first() : choices.last(), mode = await chosen.evaluate((node, key) => node.dataset[key], config.choice);
        await trigger(page, config).evaluate(node => {
          window.__oldMenuTrigger = node; window.__oldMenuTriggerFocus = 0;
          document.addEventListener("focusin", event => { if (event.target === __oldMenuTrigger) __oldMenuTriggerFocus++; });
        });
        await page.keyboard.press("Enter");
        await page.waitForFunction(url => location.href !== url && document.getElementById("contentPanel").dataset.view !== "music", before.url); await frames(page);
        assert.equal(await trigger(page, config).evaluate((node, key) => node.dataset[key], config.field), mode);
        assert.equal(await page.evaluate(() => __oldMenuTriggerFocus), 0, "closing for navigation must not transiently focus the old trigger");
        assert.equal(await trigger(page, config).evaluate(node => document.activeElement === node), false);
      } finally { await page.close(); }
    }
  });
  await run("menus: outside dismissal consumes exactly one real underlying More click", async () => {
    for (const config of configs) {
      const page = await setup();
      try {
        await page.mouse.wheel(0, -900); await frames(page);
        const underlying = page.locator(".music-mobile-track").first().locator(".track-more");
        const before = await fingerprint(page); await open(page, config); await assertOpen(page, config);
        await underlying.click(); await assertClosed(page, config, { focus: false });
        assert.equal(await page.locator(".music-mobile-track-actions-sheet").count(), 0); assert.deepEqual(await fingerprint(page), before);
        await underlying.click(); const sheet = page.locator(".music-mobile-track-actions-sheet"); await sheet.waitFor({ state: "visible" });
        await sheet.getByRole("button", { name: "完成", exact: true }).click();
      } finally { await page.close(); }
    }
  });
  await run("menus: a trusted pending long press cannot reopen after an actual same-source route change", async () => {
    const page = await setup({ touch: true });
    try {
      const button = trigger(page, configs[1]), box = await button.boundingBox(), cdp = safeSessions.get(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2, id: 7 }] });
      await page.evaluate(() => { location.hash = "#tools"; });
      await page.waitForFunction(() => document.getElementById("contentPanel").dataset.view === "tools");
      await page.waitForTimeout(650); assert.equal(await page.getByRole("menu").count(), 0);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
      assert.equal(await page.evaluate(() => document.getElementById("contentPanel").dataset.view), "tools");
    } finally { await page.close(); }
  });
}
async function profile(page, { font32, safe }) {
  await page.evaluate(() => { document.getElementById("fixture-bottom-layout-pressure")?.remove(); document.getElementById("private-bottom-font")?.remove(); });
  if (font32) { const style = await page.addStyleTag({ content: ".bottom-nav .bottom-nav-label{font-size:32px!important;line-height:1.1!important}" }); await style.evaluate(node => { node.id = "private-bottom-font"; }); }
  let cdp = safeSessions.get(page);
  if (!cdp) { cdp = await page.context().newCDPSession(page); safeSessions.set(page, cdp); }
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: safe ? 20 : 0, bottom: safe, left: 0, right: 0 } }); await frames(page);
}
async function geometry(page) {
  return page.evaluate(() => {
    const nav = document.querySelector(".bottom-nav"), mini = document.querySelector(".music-mobile-mini-player"), n = nav.getBoundingClientRect(), m = mini.getBoundingClientRect();
    const buttons = parent => [...parent.querySelectorAll(":scope > button")];
    const navButtons = buttons(nav), miniButtons = buttons(mini), overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > .5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > .5;
    const hit = node => { const b = node.getBoundingClientRect(), target = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return b.width >= 44 && b.height >= 44 && (target === node || node.contains(target)); };
    return { navHeight: n.height, navTop: n.top, miniBottom: m.bottom, navPaddingBottom: parseFloat(getComputedStyle(nav).paddingBottom),
      labelFont: parseFloat(getComputedStyle(nav.querySelector(".bottom-nav-label")).fontSize), inlineHeight: parseFloat(document.documentElement.style.getPropertyValue("--fanhao-bottom-nav-height")),
      controlsOverlap: miniButtons.some(node => navButtons.some(other => overlap(node.getBoundingClientRect(), other.getBoundingClientRect()))),
      centers: [...miniButtons, ...navButtons].every(hit), navButtons: navButtons.length, miniButtons: miniButtons.length,
      overflow: document.documentElement.scrollWidth > innerWidth, inside: n.left >= -1 && n.right <= innerWidth + 1 && m.left >= -1 && m.right <= innerWidth + 1 };
  });
}
function assertLayout(result) {
  assert.equal(result.controlsOverlap, false, "grown navigation must not cover the mini player's actual controls");
  assert.equal(result.centers, true, "both fixed bars retain reachable 44px controls");
  assert.equal(result.inside, true); assert.equal(result.overflow, false);
  assert.equal(result.navButtons, 5); assert.equal(result.miniButtons, 4);
  assert(Math.abs(result.miniBottom - result.navTop) <= 1, "mini uses the complete measured navigation height without counting safe area twice");
  if (Number.isFinite(result.inlineHeight)) assert(Math.abs(result.inlineHeight - result.navHeight) <= 1, "published height matches the actual border box");
}
async function centerHit(page, locator, { scroll = true } = {}) {
  if (scroll) {
    await locator.evaluate(node => node.scrollIntoView({ block: "center", behavior: "instant" })); await frames(page);
    await locator.evaluate(node => {
      if (node.closest('[role="menu"],.music-mobile-track-actions-sheet')) return;
      const bars = [document.querySelector(".bottom-nav"), document.querySelector(".music-mobile-mini-player")]
        .filter(bar => bar && getComputedStyle(bar).display !== "none");
      const limit = Math.min(innerHeight, ...bars.map(bar => bar.getBoundingClientRect().top));
      const box = node.getBoundingClientRect();
      if (box.bottom > limit - 8) scrollBy(0, box.bottom - limit + 8);
    });
  }
  await frames(page);
  const result = await locator.evaluate(node => { const b = node.getBoundingClientRect(), target = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { okay: b.width >= 44 && b.height >= 44 && b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && (target === node || node.contains(target)),
      label: node.getAttribute("aria-label") || node.textContent, width: b.width, height: b.height, top: b.top, bottom: b.bottom,
      hit: target?.className || target?.tagName || "none", viewport: [innerWidth, innerHeight] }; });
  if (!result.okay) console.log(JSON.stringify({ geometryFailure: result }));
  return result.okay;
}
