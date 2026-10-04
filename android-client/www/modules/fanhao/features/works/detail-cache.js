import { captureCachedJsonFence, readCachedJson, writeCachedJson } from "../../../../js/cache.js?v=assets-07b744082137";
import { captureAccountOwner, isAccountOwnerCurrent } from "../../../../js/account-owner.js";

export async function updateCachedWorkDetail(work, baseUrl, accountScope = captureAccountOwner(baseUrl)) {
  if (!work?.id || !isAccountOwnerCurrent(accountScope)) return null;
  const path = `/api/works/${encodeURIComponent(work.id)}`;
  const fence = captureCachedJsonFence(baseUrl, accountScope);
  const cached = await readCachedJson(baseUrl, path).catch(() => null);
  return writeCachedJson(baseUrl, path, { ...(cached?.payload || {}), work }, { fence });
}
