import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAccountLibraryFixture } from "./fixtures/account-library.mjs";

const fixture = createAccountLibraryFixture();
const base = await fixture.listen();
const password = "Personal-library-fixture-123";

async function api(route, { token, cookie, body, method = body ? "POST" : "GET", headers = {} } = {}) {
  const response = await fetch(base + route, { method, headers: {
    Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}), ...headers
  }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}
async function good(route, options) {
  const result = await api(route, options);
  assert.equal(result.status, options?.expectedStatus || 200, `${route}: ${JSON.stringify(result.body)}`);
  return result;
}
const items = (payload) => payload.work ? [payload.work] : payload.works || [];
const item = (payload, id) => items(payload).find((work) => work.id === id);
const workIds = (payload) => items(payload).map((work) => work.id).sort();
const owner = (account) => account ? `account:${account.user.id}` : "guest";
const options = (account) => ({ token: account?.token });

try {
  const status = (await good("/api/accounts/status")).body;
  assert.equal(status.invitationRequired, false);
  assert.equal(status.registrationEnabled, true);
  const alice = (await good("/api/accounts/register", { expectedStatus: 201, body: { username: "personal-alice", password, client: "android" } })).body;
  const bob = (await good("/api/accounts/register", { expectedStatus: 201, body: { username: "personal-bob", password, client: "android" },
    headers: { "X-FanHao-Account-Owner": owner(alice) } })).body;
  for (const account of [alice, bob]) {
    const initial = (await good("/api/library", options(account))).body.user;
    assert.equal(initial.favoriteCount, 0, "New accounts must not inherit guest favorites");
    assert.equal(initial.historyCount, 0, "New accounts must not inherit guest history");
  }
  const aliceFolder = (await good("/api/favorite-folders", { ...options(alice), body: { name: "Alice private folder" } })).body.folder.id;
  const bobFolder = (await good("/api/favorite-folders", { ...options(bob), body: { name: "Bob private folder" } })).body.folder.id;
  await good("/api/favorites/101", { ...options(alice), body: { folderId: aliceFolder } });
  await good("/api/progress/v101", { ...options(alice), body: { workId: "101", position: 41, duration: 120 } });
  await good("/api/favorites/102", { ...options(bob), body: { folderId: bobFolder } });
  await good("/api/progress/v102", { ...options(bob), body: { workId: "102", position: 72, duration: 120 } });
  const stampA = fixture.scoped.runForUser(alice.user, () => JSON.parse(fixture.scoped.revision()));
  const stampB = fixture.scoped.runForUser(bob.user, () => JSON.parse(fixture.scoped.revision()));
  assert.equal(stampA[1], stampB[1], "Exercise accounts with equal persisted revisions");
  assert.notEqual(stampA[0], stampB[0]);

  const allRoutes = ["/api/works?sort=title", "/api/search?q=ABC&sort=title", "/api/people/p1?sort=title",
    "/api/rankings/works?key=all", "/api/studios/1?sort=title", "/api/code-prefixes/ABC?sort=title"];
  const savedAlicePage = fixture.scoped.runForUser(alice.user, () => fixture.query.listPayload(new URL(base + allRoutes[0])));
  const savedAliceText = JSON.stringify(savedAlicePage);
  fixture.scoped.runForUser(alice.user, () => assert.strictEqual(fixture.query.listPayload(new URL(base + allRoutes[0])), savedAlicePage, "Repeated same-owner request did not exercise a warm page cache"));
  const expected = [
    { account: alice, id: "101", position: 41, folder: aliceFolder, folderName: "Alice private folder" },
    { account: bob, id: "102", position: 72, folder: bobFolder, folderName: "Bob private folder" },
    { account: null, id: "101", position: 12, folder: "default", folderName: "默认收藏" }
  ];
  for (let cycle = 0; cycle < 2; cycle += 1) for (const current of expected) {
    const auth = options(current.account);
    const otherId = current.id === "101" ? "102" : "101";
    const library = await good("/api/library", auth);
    assert.equal(library.headers.get("x-fanhao-account-owner"), owner(current.account));
    assert.equal(library.headers.get("cache-control"), "no-store");
    assert.equal(library.body.user.favoriteCount, 1);
    assert.equal(library.body.user.historyCount, 1);
    assert(library.body.user.favoriteFolders.some((folder) => folder.id === current.folder && folder.count === 1));
    const folders = (await good("/api/favorite-folders", auth)).body.folders;
    assert(folders.every((folder) => folder.id === "default" || folder.id === current.folder));
    for (const route of ["/api/favorites", "/api/history", `/api/favorites?folder=${encodeURIComponent(current.folder)}`]) {
      const payload = (await good(route, auth)).body;
      assert.deepEqual(workIds(payload), [current.id], `${route} leaked another owner's work`);
      assert.equal(item(payload, current.id).progress.position, current.position);
    }
    for (const route of allRoutes) {
      const result = await good(route, auth);
      assert.equal(result.headers.get("x-fanhao-account-owner"), owner(current.account));
      assert.deepEqual(workIds(result.body), ["101", "102"], route);
      assert.equal(item(result.body, current.id).favorite, true, route);
      assert.equal(item(result.body, current.id).favoriteFolderId, current.folder, route);
      assert.equal(item(result.body, current.id).favoriteFolderName, current.folderName, route);
      assert.equal(item(result.body, current.id).progress.position, current.position, route);
      assert.equal(item(result.body, otherId).favorite, false, route);
      assert.equal(item(result.body, otherId).progress, null, route);
      if (result.body.facets) {
        assert.equal(result.body.facets.favorite, 1, route);
        assert.equal(result.body.facets.progress, 1, route);
      }
    }
    for (const filter of ["favorite", "progress", "favorite,progress"]) {
      for (const route of ["/api/works?", "/api/search?q=ABC&", "/api/people/p1?", "/api/studios/1?", "/api/code-prefixes/ABC?"]) {
        const result = await good(`${route}filter=${encodeURIComponent(filter)}&sort=progress`, auth);
        assert.deepEqual(workIds(result.body), [current.id], `${route} ${filter}`);
      }
    }
    for (const route of ["/api/works?sort=progress", "/api/search?q=ABC&sort=progress", "/api/studios/1?sort=progress"]) {
      assert.equal(items((await good(route, auth)).body)[0].id, current.id, `${route} reused another owner's ordering`);
    }
    for (const id of ["101", "102"]) {
      const work = (await good(`/api/works/${id}`, auth)).body.work;
      assert.equal(work.progress?.position || null, id === current.id ? current.position : null);
      assert.equal(work.videos[0].progress?.position || null, id === current.id ? current.position : null, "Video detail progress crossed accounts");
    }
  }
  assert.equal(JSON.stringify(savedAlicePage), savedAliceText, "Another owner's cache overlay mutated an earlier response object");
  assert.equal(fs.readFileSync(path.join(fixture.root, "user-state.json"), "utf8"), fixture.originalLegacy);

  // Both browser Cookie sessions and Android bearer sessions select the same account.
  const webLogin = await good("/api/accounts/login", { body: { username: "personal-alice", password } });
  const cookie = webLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await good("/api/works/101", { cookie })).body.work.progress.position, 41);
  assert.equal((await good("/api/library", { cookie })).headers.get("x-fanhao-account-owner"), owner(alice));

  // An old account tab must not change the newly signed-in user's account.
  const staleTabHeaders = { "X-FanHao-Account-Owner": owner(alice) };
  const bobBefore = (await good("/api/accounts/status", options(bob))).body.user;
  for (const [route, method, body] of [
    ["/api/accounts/me", "PATCH", { displayName: "Wrong account edit" }],
    ["/api/accounts/logout", "POST", {}],
    ["/api/accounts/password", "POST", { currentPassword: password, newPassword: "Must-not-replace-123" }],
    ["/api/accounts/sessions", "GET", undefined],
    ["/api/accounts/admin/settings", "PATCH", { invitationRequired: true }]
  ]) {
    const rejected = await api(route, { ...options(bob), method, body, headers: staleTabHeaders });
    assert.equal(rejected.status, 409, `${route} accepted a stale account tab`);
    assert.equal(rejected.body.code, "ACCOUNT_CHANGED");
  }
  const bobAfter = (await good("/api/accounts/status", { ...options(bob), headers: staleTabHeaders })).body.user;
  assert.equal(bobAfter.id, bob.user.id, "Public identity status must remain available while the owner changes");
  assert.equal(bobAfter.displayName, bobBefore.displayName);
  assert.equal((await good("/api/library", options(bob))).headers.get("x-fanhao-account-owner"), owner(bob), "Rejected logout revoked the new user's token");
  assert.equal((await good("/api/accounts/status")).body.invitationRequired, false);
  const identitySwitch = await good("/api/accounts/login", { body: { username: "personal-bob", password, client: "android" }, headers: staleTabHeaders });
  assert.equal(identitySwitch.body.user.id, bob.user.id, "Public login must allow an intentional account switch");

  const preflight = await api("/api/progress/v101", { method: "OPTIONS", headers: {
    Origin: "http://localhost", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-FanHao-Account-Owner,Authorization,Content-Type"
  } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-headers"), /X-FanHao-Account-Owner/i);
  const cors = await good("/api/library", { ...options(alice), headers: { Origin: "http://localhost", "X-FanHao-Account-Owner": owner(alice) } });
  assert.match(cors.headers.get("access-control-expose-headers"), /X-FanHao-Account-Owner/i);
  for (const [account, claim] of [[alice, owner(bob)], [alice, "guest"], [null, owner(alice)]]) {
    const rejected = await api("/api/favorites/101", { ...options(account), body: {}, headers: { "X-FanHao-Account-Owner": claim } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "ACCOUNT_CHANGED");
    assert.equal(rejected.headers.get("x-fanhao-account-owner"), owner(account));
  }
  assert.equal((await good("/api/works/101", options(alice))).body.work.favorite, true, "Rejected stale-owner write still mutated data");

  const hold = fixture.pauseNextBody();
  const pending = good("/api/favorites/102", { ...options(alice), body: { fixtureHold: true, folderId: aliceFolder, userId: bob.user.id, accountId: bob.user.id },
    headers: { "X-User-Id": bob.user.id, "X-FanHao-Account-Owner": owner(alice) } });
  try {
    await hold.entered;
    await good("/api/favorites/101", { ...options(bob), body: { folderId: bobFolder } });
    assert.equal((await good("/api/library", options(bob))).body.user.favoriteCount, 2);
  } finally { hold.release(); }
  await pending;
  assert.equal((await good("/api/works/102", options(alice))).body.work.favoriteFolderId, aliceFolder);
  assert.equal((await good("/api/works/101", options(bob))).body.work.favoriteFolderId, bobFolder);
  assert.equal((await good("/api/library")).body.user.favoriteCount, 1, "Interleaved account writes escaped into guest state");
  await good("/api/favorites/102/folder", { ...options(alice), method: "PUT", body: { folderId: bobFolder } });
  assert.equal((await good("/api/works/102", options(alice))).body.work.favoriteFolderId, "default", "Foreign folder id was accepted");
  assert.equal((await good("/api/works/102", options(bob))).body.work.favoriteFolderId, bobFolder);
  await good("/api/progress/v102", { ...options(alice), body: { workId: "102", position: 33, duration: 120, userId: bob.user.id }, headers: { "X-User-Id": bob.user.id } });
  assert.equal((await good("/api/works/102", options(alice))).body.work.progress.position, 33);
  assert.equal((await good("/api/works/102", options(bob))).body.work.progress.position, 72);
  assert.equal((await good("/api/works/102")).body.work.progress, null);

  // Manual covers remain shared metadata and invalidate all personalized pages.
  fixture.legacy.state.manualCovers["101"] = { imageId: "next-shared-cover", updatedAt: "2026-09-01" };
  fixture.legacy.save();
  for (const account of [alice, bob, null]) {
    for (const route of [...allRoutes, "/api/works/101"]) {
      const work = item((await good(route, options(account))).body, "101");
      assert.equal(work.coverId, "next-shared-cover", route);
      assert.equal(work.progress?.position || null, account === alice ? 41 : account === bob ? null : 12);
    }
  }
  fixture.scoped.runForUser(alice.user, () => {
    const projected = fixture.presenter.publicWork(fixture.library.worksById.get("101"), true, { includeUserState: false });
    assert.equal(projected.favorite, false);
    assert.equal(projected.favoriteFolderId, "");
    assert.equal(projected.favoriteFolderName, "");
    assert.equal(projected.progress, null);
    assert(projected.videos.every((video) => video.progress === null), "Shared job projection persisted per-video progress");
    assert.equal(projected.coverId, "next-shared-cover");
  });
  for (const nextCover of ["same-time-shared-cover", null, "next-shared-cover"]) {
    const coverRevision = fixture.legacy.manualCoverRevision();
    if (nextCover) fixture.legacy.state.manualCovers["101"] = { imageId: nextCover, updatedAt: "2026-09-01" };
    else delete fixture.legacy.state.manualCovers["101"];
    fixture.legacy.save();
    assert.equal(fixture.legacy.manualCoverRevision(), coverRevision + 1, "Cover counter missed same-time replacement/removal");
    for (const account of [alice, bob, null]) {
      const work = item((await good("/api/works?sort=title", options(account))).body, "101");
      assert.equal(work.coverId || null, nextCover, "Same-time replacement/removal retained an old manual cover");
    }
  }

  // Legacy clients may omit the owner assertion; they still write only their own scope.
  const beforeGuestCoverRevision = fixture.legacy.manualCoverRevision();
  const guestFolder = (await good("/api/favorite-folders", { body: { name: "Guest folder" } })).body.folder.id;
  await good("/api/favorites/102", { body: { folderId: guestFolder } });
  await good("/api/progress/v101", { body: { workId: "101", position: 25, duration: 120 } });
  assert.equal(fixture.legacy.manualCoverRevision(), beforeGuestCoverRevision, "Guest favorite/progress saves invalidated shared cover metadata");
  assert.equal((await good("/api/works/102")).body.work.favoriteFolderId, guestFolder);
  assert.equal((await good("/api/works/101", options(alice))).body.work.progress.position, 41);
  assert(!(await good("/api/favorite-folders", options(bob))).body.folders.some((folder) => folder.id === guestFolder));
  assert.equal(fixture.legacy.state.manualCovers["101"].imageId, "next-shared-cover");

  await good("/api/accounts/logout", { ...options(bob), body: {} });
  for (const route of ["/api/library", "/api/favorites", "/api/history", "/api/works/101"]) {
    const rejected = await api(route, options(bob));
    assert.equal(rejected.status, 401, "Expired account token fell back to guest data");
  }
  const rejectedWrite = await api("/api/favorites/101", { ...options(bob), body: {} });
  assert.equal(rejectedWrite.status, 401);
  const again = (await good("/api/accounts/login", { body: { username: "personal-bob", password, client: "android" } })).body;
  assert.equal((await good("/api/works/102", options(again))).body.work.progress.position, 72);
  assert.equal((await good("/api/library", options(again))).body.user.favoriteCount, 2);
  await verifyFolderManagement(alice, again);
  assert.equal(fixture.errors.length, 0);
  console.log("Account personal library HTTP fixtures passed: account isolation, cache projections, owner assertions, folder rename/delete, hidden favorites and storage rollback.");
} finally {
  await fixture.close();
}

async function verifyFolderManagement(alice, bob) {
  const folderA = (await good("/api/favorite-folders", { ...options(alice), body: { name: "Managed folder" } })).body.folder;
  const folderB = (await good("/api/favorite-folders", { ...options(bob), body: { name: "Managed folder" } })).body.folder;
  assert.equal(folderA.id, folderB.id, "Exercise equal folder ids in separate accounts");
  const route = `/api/favorite-folders/${encodeURIComponent(folderA.id)}`;
  await good("/api/favorites/101/folder", { ...options(alice), method: "PUT", body: { folderId: folderA.id } });
  await good("/api/favorites/101/folder", { ...options(bob), method: "PUT", body: { folderId: folderB.id } });
  fixture.scoped.runForUser(alice.user, () => {
    fixture.scoped.state().favorites["temporarily-unavailable-work"] = { folderId: folderA.id, createdAt: "2025-06-01T10:00:00Z" };
    fixture.scoped.save();
  });
  const before = fixture.scoped.runForUser(alice.user, () => structuredClone(fixture.scoped.state()));
  const renamed = "Renamed " + "n".repeat(24);
  await good("/api/works?sort=title", options(alice));
  await good(`/api/favorites?folder=${encodeURIComponent(folderA.id)}`, options(alice));
  const rename = await good(route, { ...options(alice), method: "PATCH", body: { name: "  Renamed    " + "n".repeat(40), userId: bob.user.id } });
  assert.equal(rename.body.ok, true);
  assert.deepEqual(rename.body.folder, { id: folderA.id, name: renamed, count: 1, createdAt: folderA.createdAt });
  assert(rename.body.folders.some((folder) => folder.name === renamed));
  assert(rename.body.user.favoriteFolders.some((folder) => folder.name === renamed));
  const sameNameRevision = fixture.scoped.runForUser(alice.user, fixture.scoped.revision);
  await good(route, { ...options(alice), method: "PATCH", body: { name: `  ${renamed}  ` } });
  assert.equal(fixture.scoped.runForUser(alice.user, fixture.scoped.revision), sameNameRevision, "Idempotent rename persisted an unnecessary revision");
  for (const current of [alice, bob, alice]) {
    const name = current === alice ? renamed : "Managed folder";
    for (const url of ["/api/works?sort=title", "/api/search?q=ABC", "/api/works/101", "/api/people/p1", "/api/rankings/works?key=all", "/api/studios/1", "/api/code-prefixes/ABC", "/api/favorites"]) {
      assert.equal(item((await good(url, options(current))).body, "101").favoriteFolderName, name, `Rename did not refresh ${url}`);
    }
  }
  const unique = (await good("/api/favorite-folders", { ...options(alice), body: { name: "Only Alice folder" } })).body.folder;
  for (const method of ["PATCH", "DELETE"]) {
    const foreign = await api(`/api/favorite-folders/${encodeURIComponent(unique.id)}`, { ...options(bob), method, body: { name: "Take over", userId: alice.user.id } });
    assert.equal(foreign.status, 404, "A foreign folder was found through userId");
    for (const id of ["missing", "toString", "constructor", "__proto__"]) {
      assert.equal((await api(`/api/favorite-folders/${id}`, { ...options(alice), method, body: { name: "Changed" } })).status, 404);
    }
    assert.equal((await api("/api/favorite-folders/default", { ...options(alice), method, body: { name: "Changed" } })).status, 400);
  }
  assert.equal((await api(route, { ...options(alice), method: "PATCH", body: { name: "  " } })).status, 400);
  for (const duplicate of [unique.name, "默认收藏"]) assert.equal((await api(route, { ...options(alice), method: "PATCH", body: { name: duplicate } })).status, 409);

  const database = new DatabaseSync(path.join(fixture.root, "account-user-state.sqlite"));
  try {
    const committedRow = database.prepare("SELECT state_json FROM account_user_state WHERE account_id=?").get(alice.user.id).state_json;
    const committedMemory = fixture.scoped.runForUser(alice.user, () => JSON.stringify(fixture.scoped.state()));
    database.exec("CREATE TRIGGER reject_folder_update BEFORE UPDATE ON account_user_state BEGIN SELECT RAISE(ABORT, 'fixture folder storage failure'); END;");
    try {
      for (const method of ["PATCH", "DELETE"]) {
        const failed = await api(route, { ...options(alice), method, body: { name: "Must roll back" } });
        assert.equal(failed.status, 500);
        assert.equal(failed.body.error, "保存收藏夹失败，请重试");
        assert.equal(fixture.scoped.runForUser(alice.user, () => JSON.stringify(fixture.scoped.state())), committedMemory);
        assert.equal(database.prepare("SELECT state_json FROM account_user_state WHERE account_id=?").get(alice.user.id).state_json, committedRow);
        assert.equal(item((await good("/api/works?sort=title", options(alice))).body, "101").favoriteFolderName, renamed);
      }
    } finally { database.exec("DROP TRIGGER reject_folder_update;"); }
  } finally { database.close(); }

  const removed = await good(route, { ...options(alice), method: "DELETE" });
  assert.equal(removed.body.ok, true);
  assert.equal(removed.body.deletedFolderId, folderA.id);
  assert.equal(removed.body.movedCount, 2, "Delete did not move the unavailable work's favorite");
  assert.equal(removed.body.defaultFolder.id, "default");
  assert.equal(removed.body.defaultFolder.count, 2, "Folder UI count must still count visible works only");
  assert(!removed.body.folders.some((folder) => folder.id === folderA.id));
  assert(!removed.body.user.favoriteFolders.some((folder) => folder.id === folderA.id));
  assert.equal(removed.body.user.favoriteCount, 2);
  const after = fixture.scoped.runForUser(alice.user, () => structuredClone(fixture.scoped.state()));
  assert.equal(after.favorites["temporarily-unavailable-work"].folderId, "default");
  assert.equal(after.favorites["temporarily-unavailable-work"].createdAt, before.favorites["temporarily-unavailable-work"].createdAt);
  assert.equal(after.favorites["101"].createdAt, before.favorites["101"].createdAt);
  assert.deepEqual(after.progress, before.progress);
  assert.equal((await good("/api/works/101", options(alice))).body.work.favoriteFolderId, "default");
  assert.equal((await good("/api/works/101", options(bob))).body.work.favoriteFolderId, folderB.id);
  for (const url of ["/api/works?sort=title", "/api/search?q=ABC", "/api/people/p1", "/api/favorites", "/api/rankings/works?key=all", "/api/studios/1", "/api/code-prefixes/ABC"]) {
    assert.equal(item((await good(url, options(alice))).body, "101").favoriteFolderName, "默认收藏", `Delete did not refresh ${url}`);
  }
  assert.equal((await api(route, { ...options(alice), method: "DELETE" })).status, 404);
  assert.equal(fixture.legacy.state.manualCovers["101"].imageId, "next-shared-cover");

  const guestFolder = (await good("/api/favorite-folders", { body: { name: "Guest managed folder" } })).body.folder;
  const guestRoute = `/api/favorite-folders/${encodeURIComponent(guestFolder.id)}`;
  await good("/api/favorites/101/folder", { method: "PUT", body: { folderId: guestFolder.id } });
  await good(guestRoute, { method: "PATCH", body: { name: "Guest managed renamed" } });
  assert.equal((await good("/api/works/101")).body.work.favoriteFolderName, "Guest managed renamed");
  assert.equal((await good(guestRoute, { method: "DELETE" })).body.movedCount, 1);
  assert.equal((await good("/api/works/101")).body.work.favoriteFolderId, "default");
  assert.equal((await good("/api/works/101", options(bob))).body.work.favoriteFolderId, folderB.id);
}
