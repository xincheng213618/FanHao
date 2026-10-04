export function createMusicProgressSession(trackId, activeUrl, serverClockMs, sessionId = null) {
  if (!Number.isSafeInteger(serverClockMs) || serverClockMs < 0) return null;
  const id = sessionId || uuid();
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
  if (!id) return null;
  let sequence = 0;
  return {
    id, trackId, activeUrl, startedAt: serverClockMs,
    capture(record) {
      return { ...record, progressSessionId: id, progressSessionStartedAt: serverClockMs, progressSequence: ++sequence };
    }
  };
}

export function createMusicPlayedReport(session) {
  const id = session && uuid();
  return id ? { playedReportId: id, playedReportStartedAt: session.startedAt } : {};
}

export function musicProgressBody(record, played) {
  const body = { positionMs: record.positionMs, durationMs: record.durationMs };
  if (record.progressSessionId) {
    body.progressSessionId = record.progressSessionId;
    body.progressSessionStartedAt = record.progressSessionStartedAt;
    body.progressSequence = record.progressSequence;
  }
  if (played) {
    body.played = true;
    if (record.playedReportId) {
      body.playedReportId = record.playedReportId;
      body.playedReportStartedAt = record.playedReportStartedAt;
    }
  }
  return body;
}

function uuid() {
  const random = globalThis.crypto;
  if (random?.randomUUID) return random.randomUUID();
  if (!random?.getRandomValues) return null;
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
