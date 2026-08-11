import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const admin = read("src/modules/fanhao/server/admin/admin-core-mutation-service.js");
const actorAvatar = read("src/modules/fanhao/server/people/actor-avatar-service.js");
const actorProfile = read("src/modules/fanhao/server/people/actor-profile-service.js");
const cacheContracts = read("src/modules/fanhao/server/library/cache-contracts.js");
const imageService = read("src/modules/fanhao/server/works/image-service.js");
const manualCover = read("src/modules/fanhao/server/works/manual-cover-state-service.js");
const mediaResponse = read("src/platform/server/media-response-service.js");
const mediaWorker = read("src/platform/server/media-blob-worker.js");
const outbox = read("src/modules/fanhao/server/library/cross-store-outbox-service.js");
const presenter = read("src/modules/fanhao/server/works/presenter-service.js");
const pythonRefresh = read("tools/refresh_core_javdb_actor_movies.py");
const fullScan = read("tools/full_scan_core_library.py");
const server = read("server.js");

assert.match(admin, /function legacyUpsertActorProfile[\s\S]*BEGIN IMMEDIATE[\s\S]*assertActorProfileMutationAllowed[\s\S]*clearActorProfilePublication[\s\S]*INSERT INTO fanhao_images\.images/, "legacy actor-profile writes must fence reservations and retire an older pointer");
assert.match(admin, /function applyActorProfileMain[\s\S]*assertActorProfileMutationPreparation[\s\S]*INSERT INTO actor_profile_publications/, "the outbox final projection must recheck reservations before publishing");
assert.match(admin, /function createOrUpdateMoveTargetPerson[\s\S]*BEGIN IMMEDIATE[\s\S]*assertActorProfileMutationAllowed\(db, existing\?\.id[\s\S]*assertActorProfileMutationAllowed\(db, personId, \{ actorKeys/, "work-move person creation must fence both the target and JavDB identity owner under the main write lock");
assert.match(admin, /function mergePeopleIntoTarget[\s\S]*BEGIN IMMEDIATE[\s\S]*assertActorProfileMutationAllowed[\s\S]*clearActorProfilePublication/, "merge must guard target and sources and retire stale publication pointers");
assert.match(actorAvatar, /function upsertAvatar[\s\S]*BEGIN IMMEDIATE[\s\S]*assertActorProfileMutationAllowed[\s\S]*clearActorProfilePublication[\s\S]*INSERT INTO fanhao_images\.images/, "Filetree avatar imports must fence and retire the prior publication");
assert.match(manualCover, /function replaceManualPersonAvatar[\s\S]*BEGIN IMMEDIATE[\s\S]*assertActorProfileMutationAllowed[\s\S]*clearActorProfilePublication[\s\S]*INSERT INTO fanhao_images\.images/, "manual avatar writes must fence and retire the prior publication");
assert.match(pythonRefresh, /conn\.execute\("BEGIN IMMEDIATE"\)[\s\S]*assert_actor_profile_mutation_allowed\(conn, job\["id"\], job\.get\("actor_id"\)\)/, "Python actor refresh must fence person, JavDB key and current owner under the main write lock");
assert.match(pythonRefresh, /if avatar_url:[\s\S]*clear_actor_profile_publication[\s\S]*INSERT INTO fanhao_images\.images/, "Python source=actor_profiles writes must retire the prior publication");

const fullScanPersonImageWrites = [...fullScan.matchAll(/(?:UPDATE|INSERT INTO) fanhao_images\.images[\s\S]{0,260}?owner_type = 'person'/g)];
assert.equal(fullScanPersonImageWrites.length, 0, "full scan must not bypass the actor-avatar mutation fence");

assert.match(outbox, /function applyMainAndComplete[\s\S]*BEGIN IMMEDIATE[\s\S]*handler\.applyMain[\s\S]*cross_store_main_receipts[\s\S]*status = 'completed'[\s\S]*cross_store_aggregate_reservations[\s\S]*visibility_before_commit[\s\S]*COMMIT/, "profile, pointer, receipt, completed state and release must share one main transaction");
assert.equal(outbox.includes("INSERT INTO images"), false, "the protocol must never prepublish staged bytes into the live unique image row");

for (const [name, source] of [["profile", actorProfile], ["avatar", imageService], ["media", mediaWorker]]) {
  assert.match(source, /cross_store_operation_state[\s\S]*status = 'completed'/, `${name} reader must require completed main state`);
  assert.match(source, /cross_store_main_receipts[\s\S]*visibility_switch/, `${name} reader must validate the main visibility receipt`);
  assert.match(source, /actor_profile_image_staging/, `${name} reader must resolve the immutable staged version`);
}
assert.match(mediaWorker, /publication\.operation_id = \?/, "versioned media reads must validate the exact operation token");
assert.match(mediaResponse, /options\.version \? "public, max-age=31536000, immutable"/, "receipt-validated versioned avatar bytes must use an immutable cache policy");

const publicPersonBody = presenter.slice(presenter.indexOf("function publicPerson("), presenter.indexOf("function publicMediaFile("));
assert.match(publicPersonBody, /publicActorProfileSnapshot\(profileRow\)/);
assert.equal(publicPersonBody.includes("publicPersonAvatar"), false, "person presentation must not mix a cached profile row with a second avatar read");
assert.equal(cacheContracts.includes('"actor_profile_image_staging"'), false, "invisible staging must not participate in the public cache stamp");
assert.equal(cacheContracts.includes('"actor_profile_publications"'), true, "only the main publication pointer is the cache visibility signal");
assert.match(server, /function libraryPeopleStamp\(\)[\s\S]*actorProfileStamp\(\)/, "person detail/list caches must observe the publication-backed actor-profile stamp even if an in-memory completion callback fails");

const startIndex = server.indexOf("actorProfileOutboxService.start()");
assert.ok(startIndex >= 0);
assert.ok(startIndex < server.indexOf("localLibraryIndexService.initializeLibrary()"), "startup reconcile must precede local mutation service initialization");
assert.ok(startIndex < server.indexOf("await moduleRegistry.start()"), "startup reconcile must precede route availability");

console.log("actor profile writer/read-model bypass scan passed");
