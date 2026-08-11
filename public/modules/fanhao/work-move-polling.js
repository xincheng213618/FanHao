const TRANSIENT_STATUSES = new Set([408, 429, 503]);
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 2_000];

export function isTransientWorkMovePollError(error) {
  const status = Number(error?.statusCode ?? error?.status ?? 0);
  if (TRANSIENT_STATUSES.has(status)) return true;
  return !status && (error instanceof TypeError || error?.name === "NetworkError" || error?.name === "FetchError");
}

export function workMovePollRetryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(Math.max(0, Number(attempt || 0)), RETRY_DELAYS_MS.length - 1)];
}

export async function fetchWorkMoveJobWithBackoff({
  api,
  jobId,
  maxRetries = RETRY_DELAYS_MS.length,
  signal,
  wait
}) {
  let attempt = 0;
  while (true) {
    try {
      return await api(`/api/work-move-jobs/${encodeURIComponent(jobId)}`, { signal });
    } catch (error) {
      if (signal?.aborted || !isTransientWorkMovePollError(error) || attempt >= maxRetries) throw error;
      await wait(workMovePollRetryDelay(attempt), signal);
      attempt += 1;
    }
  }
}

export { RETRY_DELAYS_MS, TRANSIENT_STATUSES };
