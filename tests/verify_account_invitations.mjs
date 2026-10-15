import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createAccountFixture } from "./fixtures/account-service.mjs";
import { createAccountStore } from "../src/platform/server/accounts/store.js";

let time = Date.now();
const fixture = createAccountFixture({ now: () => time }), base = await fixture.listen();
const store = createAccountStore({ dbPath: fixture.dbPath, now: () => time });
const password = "Invitations-fixture-123";
async function api(route, { token, body, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(base + "/api/accounts" + route, { method, headers: { Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
async function create(username, inviteCode = "", setup = false) {
  const response = await api(setup ? "/setup" : "/register", { body: { username, password, inviteCode, client: "android" } });
  assert.equal(response.status, 201); return response.body;
}
let db;
try {
  const admin = await create("invite-owner", "", true), direct = await create("direct-user");
  const make = (note, options = {}) => store.createInvites(admin.user.id, { count: 1, note, ...options })[0];
  const available = make("launch_% team", { maxUses: 1000 }), exhausted = make("one-use"), expired = make("one-day", { expiresInDays: 1 }), disabled = make("revoked", { expiresInDays: 1 });
  store.disableInvite(disabled.id, admin.user.id);
  const invited = await create("invited-user", available.code), single = await create("single-user", exhausted.code);
  db = new DatabaseSync(fixture.dbPath);
  const hash = db.prepare("SELECT password_hash FROM account_users WHERE id=?").get(admin.user.id).password_hash;
  time += 86400000;
  for (const route of ["/admin/invites", `/admin/invites/${available.id}`, "/admin/users"]) {
    assert.equal((await api(route)).status, 401); assert.equal((await api(route, { token: direct.token })).status, 403);
  }
  const listing = await api("/admin/invites", { token: admin.token }); assert.equal(listing.status, 200); assert.equal(listing.cache, "no-store");
  assert.equal(listing.body.total, 4);
  for (const [id, status] of [[available.id, "available"], [exhausted.id, "exhausted"], [expired.id, "expired"], [disabled.id, "disabled"]]) {
    assert.equal(listing.body.invites.find((i) => i.id === id).status, status);
    const result = await api(`/admin/invites?status=${status}`, { token: admin.token });
    assert.equal(result.body.total, 1); assert.equal(result.body.invites[0].id, id);
  }
  for (const search of ["launch_%", "%", "_", available.code.slice(-6)]) {
    const result = await api(`/admin/invites?search=${encodeURIComponent(search)}`, { token: admin.token });
    assert.equal(result.body.total, 1, `literal search ${search}`); assert.equal(result.body.invites[0].id, available.id);
  }
  assert.equal((await api("/admin/invites?search=invite-owner&status=available", { token: admin.token })).body.total, 1);
  assert.equal((await api("/admin/invites?search=missing", { token: admin.token })).body.total, 0);
  assert.equal((await api(`/admin/invites?search=${available.code}`, { token: admin.token })).body.total, 0, "full codes are not stored for search");
  assert.equal((await api("/admin/invites?status=invalid", { token: admin.token })).status, 400);
  assert.equal((await api("/admin/invites?offset=-1", { token: admin.token })).status, 400);
  assert.equal((await api("/admin/invites/missing", { token: admin.token })).status, 404);
  assert.equal((await api(`/admin/invites/${available.id}?offset=NaN`, { token: admin.token })).status, 400);
  const details = await api(`/admin/invites/${available.id}`, { token: admin.token });
  assert.equal(details.status, 200); assert.equal(details.body.total, 1); assert.equal(details.body.invite.uses, 1);
  assert.equal(details.body.redemptions[0].username, invited.user.username); assert.equal(details.body.redemptions[0].disabled, false);
  assert.equal(details.body.invite.createdByUsername, admin.user.username); assert.equal(details.body.redemptions[0].redeemedAt, invited.user.createdAt);
  assert.equal((await api(`/admin/invites/${expired.id}`, { token: admin.token })).body.total, 0);
  const users = await api("/admin/users", { token: admin.token });
  assert.deepEqual(users.body.users.find((u) => u.id === direct.user.id).registration, { kind: "direct" });
  assert.deepEqual(users.body.users.find((u) => u.id === invited.user.id).registration,
    { kind: "invitation", inviteId: available.id, suffix: available.code.slice(-6), createdByUsername: admin.user.username });
  assert.equal((await api("/status", { token: invited.token })).body.user.registration, undefined, "invitation provenance is admin-only");

  // Large-history fixture: retain the real API-created redemption, add deterministic rows for pagination.
  const insertUser = db.prepare("INSERT INTO account_users(id,username,display_name,password_hash,role,disabled,created_at) VALUES(?,?,?,?,?,?,?)");
  const insertRedemption = db.prepare("INSERT INTO account_redemptions(user_id,invite_id,created_at) VALUES(?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 54; i++) {
    const id = crypto.randomUUID(), createdAt = new Date(time + i * 1000).toISOString();
    insertUser.run(id, `page-user-${String(i).padStart(2, "0")}`, i === 0 ? "display_%" : "Page fixture", hash, "user", 0, createdAt);
    insertRedemption.run(id, available.id, createdAt);
  }
  db.prepare("UPDATE account_invites SET uses=uses+54 WHERE id=?").run(available.id); db.exec("COMMIT");
  const first = (await api(`/admin/invites/${available.id}`, { token: admin.token })).body;
  const second = (await api(`/admin/invites/${available.id}?offset=50`, { token: admin.token })).body;
  assert.equal(first.total, 55); assert.equal(first.redemptions.length, 50); assert.equal(second.redemptions.length, 5);
  assert.equal(new Set([...first.redemptions, ...second.redemptions].map((u) => u.id)).size, 55);
  assert.equal(first.redemptions[0].username, "page-user-53");
  assert(!first.redemptions.some((u) => u.id === single.user.id), "other invitations stay out of this list");
  assert.equal((await api(`/admin/invites/${available.id}?search=${encodeURIComponent("_%")}`, { token: admin.token })).body.total, 1);
  assert.equal((await api(`/admin/invites/${available.id}?search=page-user-1`, { token: admin.token })).body.total, 10);
  assert.equal((await api(`/admin/invites/${available.id}?search=missing`, { token: admin.token })).body.total, 0);
  store.updateUser(invited.user.id, { disabled: true }, admin.user.id);
  store.disableInvite(available.id, admin.user.id);
  const retained = (await api(`/admin/invites/${available.id}?search=invited-user`, { token: admin.token })).body;
  assert.equal(retained.invite.status, "disabled"); assert.equal(retained.invite.uses, 55);
  assert.equal(retained.redemptions[0].disabled, true); assert.equal(retained.total, 1);
  assert.equal((await api(`/admin/invites/${exhausted.id}`, { token: admin.token })).body.redemptions[0].id, single.user.id);
  time += 6 * 86400000;
  assert.equal(store.inviteDetails(exhausted.id, {}).invite.status, "expired", "expiration takes precedence over exhaustion");
  assert.equal(store.inviteDetails(available.id, {}).invite.status, "disabled", "revocation takes precedence over expiration");
  store.createInvites(admin.user.id, { count: 55, note: "page-codes" });
  const codes1 = store.listInvites({ search: "page-codes" }), codes2 = store.listInvites({ search: "page-codes", offset: 50 });
  assert.equal(codes1.total, 55); assert.equal(codes2.invites.length, 5);
  assert.equal(new Set([...codes1.invites, ...codes2.invites].map((i) => i.id)).size, 55);
  for (const payload of [listing.body, details.body, users.body, first, retained]) {
    const encoded = JSON.stringify(payload);
    for (const secret of [password, hash, available.code, admin.token, invited.token, "code_hash", "password_hash", "token_hash"]) assert(!encoded.includes(secret), "list/detail responses must not reveal secrets");
  }
  store.close();
  assert.equal(store.inviteDetails(available.id, {}).total, 55, "registration provenance survives reopening");
  console.log("account-invitations: ok (admin-only detail/provenance, status precedence, literal search, filtered pagination, retained redemption history, secret exclusion)");
} finally { db?.close(); store.close(); await fixture.close(); }
