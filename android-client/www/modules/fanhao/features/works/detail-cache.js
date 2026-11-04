import { captureCachedJsonFence, readCachedJson, writeCachedJson } from "../../../../js/cache.js?v=assets-b266fc766a5d";
import { captureAccountOwner, isAccountOwnerCurrent } from "../../../../js/account-owner.js";

export async function updateCachedWorkDetail(work, baseUrl, accountScope = captureAccountOwner(baseUrl)) {
  if (!work?.id || !isAccountOwnerCurrent(accountScope)) return null;
  const path = `/api/works/${encodeURIComponent(work.id)}`;
  const fence = captureCachedJsonFence(baseUrl, accountScope);
  const cached = await readCachedJson(baseUrl, path).catch(() => null);
  return writeCachedJson(baseUrl, path, { ...(cached?.payload || {}), work }, { fence });
}
