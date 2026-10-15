import assert from "node:assert/strict";

export async function verifyAndroidNavigationRestoration(browser, baseUrl, fixtureApi) {
  for (const scenario of ["navigate", "navigate-error", "wheel", "keyboard"]) {
    const page = await browser.newPage({ viewport: { width: 412, height: 820 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.addInitScript(() => {
        localStorage.setItem("fanhao.serverUrl", location.origin);
        localStorage.setItem("fanhao.android.lastView", JSON.stringify({ view: "channel", params: { mode: "photo", category: "我喜欢的" } }));
      });
      await page.route((url) => url.pathname === "/android-client/js/android-module-registry.js", async (route) => {
        const response = await route.fetch();
        const original = await response.text();
        const anchor = "return resolved?.route.render(params || {}, renderGuard);";
        assert.equal(original.split(anchor).length, 2, "fixture must delay the real module renderer at one well-defined boundary");
        const body = original.replace(anchor, `
          const task = resolved?.route.render(params || {}, renderGuard);
          const gate = window.fixtureNavigationRenderGate;
          if (!gate?.armed || view !== "channel" || params?.collection) return task;
          gate.armed = false;
          gate.started = true;
          return Promise.resolve(task).then(async (result) => {
            await gate.promise;
            return result;
          });
        `);
        await route.fulfill({ response, body });
      });
      await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname !== "/api/image-library/items") return route.fulfill({ json: await fixtureApi(url) });
        const collection = url.searchParams.get("collection") || "";
        const category = "我喜欢的";
        const collections = Array.from({ length: 24 }, (_, index) => ({
          id: `nav-${index + 1}`, collectionId: `nav-${index + 1}`, type: "photoCollection",
          title: `回归合集 ${index + 1}`, category, albumCount: 24 - index, coverUrl: ""
        }));
        await route.fulfill({ json: {
          mode: "photo", category, collection, photoView: collection ? "albums" : "collections",
          items: collection
            ? [{ id: "nav-album", type: "photo", title: "回归套图", category, imageCount: 0 }]
            : [{ type: "photoCollectionCategory", category, collections }],
          total: 1, collectionSummary: collection ? { title: "回归合集", category, count: 1 } : null,
          facets: { categories: [] }
        } });
      });
      await page.goto(`${baseUrl}/android-client/index.html`, { waitUntil: "domcontentloaded" });
      const card = page.getByRole("button", { name: /回归合集 12\b/ });
      await card.waitFor({ state: "visible", timeout: 10000 });
      await card.scrollIntoViewIfNeeded();
      const originalScroll = await page.evaluate(() => window.scrollY);
      assert.ok(originalScroll > 500, "the fixture must exercise a meaningful restored position");
      await card.click({ position: { x: 20, y: 20 } });
      await page.getByRole("button", { name: "返回分类", exact: true }).waitFor({ state: "visible" });
      await page.evaluate(() => {
        let release;
        let reject;
        const promise = new Promise((resolve, fail) => { release = resolve; reject = fail; });
        window.fixtureNavigationRenderGate = { armed: true, started: false, promise, release, reject };
      });
      await page.getByRole("button", { name: "返回分类", exact: true }).click();
      await page.waitForFunction(() => window.fixtureNavigationRenderGate?.started);
      await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) < 3, originalScroll);
      if (scenario.startsWith("navigate")) {
        await page.getByRole("button", { name: "我的", exact: true }).click();
        await page.waitForFunction(() => document.querySelector("#contentPanel")?.dataset.view === "tools" && window.scrollY === 0);
      } else if (scenario === "wheel") {
        await page.mouse.wheel(0, 250);
        await page.waitForFunction((previous) => window.scrollY > previous + 80, originalScroll);
      } else {
        await page.keyboard.press("PageUp");
        await page.waitForFunction((previous) => window.scrollY < previous - 80, originalScroll);
      }
      // Let native wheel/key smooth scrolling settle before recording its destination.
      await page.waitForTimeout(350);
      const before = await fingerprint(page);
      await page.evaluate((reject) => {
        const gate = window.fixtureNavigationRenderGate;
        if (reject) gate.reject(new Error("fixture late render failure"));
        else gate.release();
      }, scenario === "navigate-error");
      await page.waitForTimeout(150);
      assert.deepEqual(await fingerprint(page), before, `${scenario}: late renderer completion must not take over the current page or user scroll intent`);
      assert.deepEqual(errors, [], `${scenario}: late errors must not create an unhandled rejecting finalizer`);
    } finally {
      await page.close();
    }
  }
}

async function fingerprint(page) {
  return page.evaluate(() => ({
    view: document.querySelector("#contentPanel")?.dataset.view,
    href: location.href,
    scrollY: window.scrollY,
    content: document.querySelector("#viewContent")?.textContent
  }));
}
