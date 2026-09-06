const STORAGE_PREFIX = "fanhao.android.accountOwner.v1:";
const state = globalThis.__fanhaoAccountOwnerState ||= { entries: new Map(), payloads: new WeakMap(), resolveSession: null };

function origin(value) {
  try { return new URL(value).origin; } catch { return String(value || "").replace(/\/+$/, ""); }
}

function entry(baseUrl) {
  const key = origin(baseUrl);
  if (!state.entries.has(key)) {
    let saved = null;
    try { saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_PREFIX + key) || "null"); } catch {}
    state.entries.set(key, { owner: validOwner(saved?.owner) ? saved.owner : "guest", revision: 0,
      token: undefined, tag: saved?.tag || "", confirmedTag: saved?.tag || "" });
  }
  return state.entries.get(key);
}

function validOwner(value) { return value === "guest" || /^account:[A-Za-z0-9_-]+$/.test(String(value || "")); }

export function captureAccountOwner(baseUrl) {
  const current = entry(baseUrl);
  return Object.freeze({ origin: origin(baseUrl), owner: current.owner, revision: current.revision, tokenKnown: current.token !== undefined });
}

export function isAccountOwnerCurrent(scope) {
  if (!scope) return false;
  const current = entry(scope.origin);
  return current.owner === scope.owner && current.revision === scope.revision;
}

export function accountChangedError() {
  return Object.assign(new Error("账号已切换，请重新操作"), { code: "ACCOUNT_CHANGED", status: 409, statusCode: 409 });
}

export function setAccountOwner(baseUrl, owner, { force = false } = {}) {
  if (!validOwner(owner) && owner !== "pending") return captureAccountOwner(baseUrl);
  const current = entry(baseUrl);
  const previous = captureAccountOwner(baseUrl);
  const changed = current.owner !== owner || force;
  current.owner = owner;
  if (changed) current.revision += 1;
  if (validOwner(owner)) {
    current.confirmedTag = current.tag;
    try { globalThis.localStorage?.setItem(STORAGE_PREFIX + origin(baseUrl), JSON.stringify({ owner, tag: current.tag })); } catch {}
  }
  const next = captureAccountOwner(baseUrl);
  if (changed && typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
    globalThis.dispatchEvent(new CustomEvent("fanhaoAccountOwnerChanged", { detail: { previous, current: next } }));
  }
  return next;
}

// Only a non-reversible token digest is persisted with the offline cache owner.
// A changed native session cannot inherit another account's cached responses.
export async function synchronizeAccountToken(baseUrl, token) {
  const current = entry(baseUrl);
  if (current.token === token) return current.tokenPending || captureAccountOwner(baseUrl);
  const previousToken = current.token;
  const savedOwner = current.owner;
  const savedTag = current.confirmedTag;
  current.token = token;
  if (!String(token || "").startsWith("usr.")) {
    current.tag = "";
    return setAccountOwner(baseUrl, "guest", { force: previousToken !== undefined && previousToken !== token });
  }
  if (previousToken !== undefined) setAccountOwner(baseUrl, "pending", { force: true });
  const pending = (async () => {
    let tag = "";
    if (globalThis.crypto?.subtle) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      tag = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("");
    }
    if (current.token !== token) throw accountChangedError();
    current.tag = tag;
    if (previousToken === undefined && tag && tag === savedTag && validOwner(savedOwner)) return captureAccountOwner(baseUrl);
    return setAccountOwner(baseUrl, "pending");
  })();
  current.tokenPending = pending;
  try { return await pending; }
  catch (error) {
    if (current.token === token) setAccountOwner(baseUrl, "pending");
    throw error;
  }
  finally { if (current.tokenPending === pending) current.tokenPending = null; }
}

export function registerAccountSessionResolver(resolve) { state.resolveSession = resolve; }

export async function prepareAccountOwner(baseUrl, { signal = null, timeoutMs = 1600 } = {}) {
  if (!state.resolveSession) return captureAccountOwner(baseUrl);
  const controller = signal ? null : new AbortController();
  const effectiveSignal = signal || controller.signal;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let onAbort;
  try {
    if (effectiveSignal.aborted) throw new DOMException("Request aborted", "AbortError");
    await Promise.race([
      state.resolveSession(origin(baseUrl), effectiveSignal),
      new Promise((_resolve, reject) => {
        onAbort = () => reject(new DOMException("Request aborted", "AbortError"));
        effectiveSignal.addEventListener("abort", onAbort, { once: true });
        if (effectiveSignal.aborted) onAbort();
      })
    ]);
    return captureAccountOwner(baseUrl);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) effectiveSignal.removeEventListener("abort", onAbort);
  }
}

export function observeAccountResponse(baseUrl, path, payload, response, scope) {
  if (scope && !isAccountOwnerCurrent(scope)) throw accountChangedError();
  let owner = response?.headers?.get?.("X-FanHao-Account-Owner") || "";
  if (/^\/api\/(?:auth|accounts)\/status(?:\?|$)/.test(path)) {
    owner = payload?.user?.id ? `account:${payload.user.id}`
      : String(entry(baseUrl).token || "").startsWith("usr.") || payload?.reason === "expired-account" ? "pending" : "guest";
  }
  const confirmed = validOwner(owner) || owner === "pending" ? setAccountOwner(baseUrl, owner) : captureAccountOwner(baseUrl);
  confirmAccountOwner(confirmed);
  return confirmed;
}

export function confirmAccountOwner(scope) {
  if (scope?.owner !== "pending" && isAccountOwnerCurrent(scope) && typeof globalThis.dispatchEvent === "function" && typeof CustomEvent === "function") {
    globalThis.dispatchEvent(new CustomEvent("fanhaoAccountOwnerConfirmed", { detail: scope }));
  }
}

export function rememberAccountPayload(payload, scope) {
  if (payload && typeof payload === "object") state.payloads.set(payload, scope);
  return payload;
}

export function accountPayloadOwner(payload) {
  return payload && typeof payload === "object" ? state.payloads.get(payload) : null;
}
