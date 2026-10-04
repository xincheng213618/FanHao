import { fetchJson } from "../../js/api.js?v=assets-07b744082137";
import { captureAccountOwner } from "../../js/account-owner.js?v=assets-07b744082137";
import { musicProgressBody } from "./progress-session.js?v=assets-07b744082137";

export function captureMusicProgressOwner(activeUrl) {
  const scope = captureAccountOwner(activeUrl);
  return { activeUrl, accountOrigin: scope.origin, accountOwner: scope.owner,
    accountRevision: scope.revision, accountTokenKnown: scope.tokenKnown };
}

export function sendMusicProgress(record, played, keepalive = false) {
  // A captured scope skips asynchronous account discovery during pagehide and
  // prevents a queued write from inheriting a later account on the same server.
  const accountScope = record.accountOwner ? { origin: record.accountOrigin,
    owner: record.accountOwner, revision: record.accountRevision, tokenKnown: record.accountTokenKnown } : null;
  return fetchJson(record.activeUrl, `/api/music/tracks/${encodeURIComponent(record.trackId)}/progress`, {
    method: "POST", body: musicProgressBody(record, played), keepalive, timeoutMs: 0, accountScope
  });
}
