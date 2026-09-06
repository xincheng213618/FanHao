const STORAGE_KEY = "fanhao.web.accountRevision.v1";
const context = globalThis.__fanhaoWebAccountContext ||= { owner: "", revision: readRevision(), invalid: false, installed: false };

function readRevision() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) || ""; } catch { return ""; }
}

function changedError() {
  return Object.assign(new Error("账号已切换，正在刷新页面"), { code: "ACCOUNT_CHANGED", status: 409, statusCode: 409 });
}

function invalidate() {
  if (context.invalid) return;
  context.invalid = true;
  for (const video of globalThis.document?.querySelectorAll?.("video") || []) video.pause();
  globalThis.location?.reload?.();
}

function checkRevision() {
  if (readRevision() !== context.revision) invalidate();
  if (context.invalid) throw changedError();
}

export function captureWebAccount() {
  checkRevision();
  if (!context.installed && typeof globalThis.addEventListener === "function") {
    context.installed = true;
    globalThis.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) invalidate(); });
    globalThis.addEventListener("pageshow", () => { try { checkRevision(); } catch {} });
    globalThis.addEventListener("focus", () => { try { checkRevision(); } catch {} });
  }
  return { owner: context.owner, revision: context.revision };
}

export function checkWebAccountResponse(response, snapshot, explicitOwner = "") {
  checkRevision();
  const owner = explicitOwner || response.headers?.get?.("X-FanHao-Account-Owner") || "";
  // A server-expired session is handled by the account panel's existing guest
  // transition. Explicit cross-tab identity switches still reload via revision.
  if (owner && context.owner && owner !== context.owner && !(explicitOwner === "guest" && !response.headers?.get?.("X-FanHao-Account-Owner"))) { invalidate(); throw changedError(); }
  if (snapshot.revision !== context.revision) throw changedError();
  if (owner) context.owner = owner;
}

export function publishWebAccountChange(owner = "") {
  const revision = `${Date.now()}:${Math.random()}`;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, revision); } catch {}
  context.revision = readRevision();
  context.owner = owner;
}

export function invalidateWebAccount() { invalidate(); }
