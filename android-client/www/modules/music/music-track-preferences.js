import { captureAccountOwner, isAccountOwnerCurrent } from "../../js/account-owner.js";

export function createMusicTrackPreferences({ send }) {
  const owners = new WeakMap();
  const reads = new WeakMap();
  const lanes = new Map();
  const confirmed = new Map();
  const activeReads = new Set();
  let intentSequence = 0;
  let confirmedClock = 0;

  function owner(sourceUrl, accountScope = captureAccountOwner(sourceUrl)) {
    return { sourceUrl: String(sourceUrl || "").replace(/\/+$/u, ""), accountScope };
  }

  function sameOwner(left, right) {
    return Boolean(left && right) && left.sourceUrl === right.sourceUrl
      && left.accountScope.origin === right.accountScope.origin
      && left.accountScope.owner === right.accountScope.owner
      && left.accountScope.revision === right.accountScope.revision;
  }

  function current(targetOwner) {
    return Boolean(targetOwner) && targetOwner.accountScope.owner !== "pending"
      && isAccountOwnerCurrent(targetOwner.accountScope);
  }

  function own(value, targetOwner) {
    if (value && typeof value === "object" && targetOwner) owners.set(value, targetOwner);
    return value;
  }

  function ownerOf(value) {
    return value && typeof value === "object" ? owners.get(value) || null : null;
  }

  function clone(track, patch = {}) {
    return inherit({ ...track, ...patch }, track);
  }

  function inherit(value, source) {
    own(value, ownerOf(source));
    if (reads.has(source)) reads.set(value, reads.get(source));
    return value;
  }

  function key(targetOwner, id, field) {
    return JSON.stringify([targetOwner.sourceUrl, targetOwner.accountScope.owner, id, field]);
  }

  function startRead() {
    const read = { clock: confirmedClock, intent: intentSequence, pending: new Set(lanes.keys()) };
    activeReads.add(read);
    return read;
  }

  function collectConfirmed() {
    for (const [laneKey, saved] of confirmed) {
      if (!lanes.has(laneKey) && ![...activeReads].some(read => saved.clock > read.clock
        || saved.intent > read.intent || read.pending.has(laneKey))) confirmed.delete(laneKey);
    }
  }

  function finishRead(read) {
    activeReads.delete(read);
    collectConfirmed();
  }

  function fieldValue(track, field) {
    if (!Object.prototype.hasOwnProperty.call(track || {}, field)) return undefined;
    if (field === "favorite") return typeof track.favorite === "boolean" ? track.favorite : undefined;
    if (typeof track.rating !== "number" && !(typeof track.rating === "string" && /^[0-5]$/u.test(track.rating))) return undefined;
    const rating = Number(track.rating);
    return Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : undefined;
  }

  function prepareTrack(track, targetOwner, read) {
    if (!track?.id) return track;
    own(track, targetOwner);
    if (read) reads.set(track, read);
    for (const field of ["favorite", "rating"]) {
      const laneKey = key(targetOwner, String(track.id), field);
      const saved = confirmed.get(laneKey);
      if (!saved || !sameOwner(saved.owner, targetOwner)) continue;
      const lane = lanes.get(laneKey);
      if (lane?.active && sameOwner(lane.visible?.owner, targetOwner)) {
        track[field] = lane.visible.value;
        continue;
      }
      if (read && (saved.clock > read.clock || read.pending.has(laneKey)
        || saved.intent > read.intent || (lane && lane.latestSequence > read.intent))) {
        track[field] = saved.value;
      }
    }
    return track;
  }

  function preparePayload(data, targetOwner, read = null) {
    if (!data || typeof data !== "object") return data;
    own(data, targetOwner);
    if (read) reads.set(data, read);
    if (data.track) prepareTrack(data.track, targetOwner, read);
    for (const list of [data.tracks, data.rawTracks, data.recent, data.topPlayed,
      data.summary?.recent, data.summary?.topPlayed]) {
      if (Array.isArray(list)) for (const track of list) prepareTrack(track, targetOwner, read);
    }
    return data;
  }

  function write(track, field, desired) {
    const targetOwner = ownerOf(track);
    const id = String(track?.id || "").trim();
    if (!id || !current(targetOwner)) return Promise.resolve(null);
    const laneKey = key(targetOwner, id, field);
    let lane = lanes.get(laneKey);
    if (!lane) {
      lane = { active: null, pending: null, latestSequence: 0, confirmed: null, visible: null };
      lanes.set(laneKey, lane);
    }
    const pending = sameOwner(lane.pending?.owner, targetOwner) ? lane.pending : null;
    const active = sameOwner(lane.active?.owner, targetOwner) ? lane.active : null;
    const previous = pending?.desired ?? active?.desired ?? fieldValue(track, field)
      ?? (field === "favorite" ? false : 0);
    const value = field === "favorite" ? !Boolean(previous) : Math.max(0, Math.min(5, Math.round(Number(desired) || 0)));
    const saved = confirmed.get(laneKey);
    if (!lane.active || !sameOwner(lane.visible?.owner, targetOwner)) {
      lane.visible = { owner: targetOwner, value: fieldValue(track, field) ?? previous };
    }
    if (!saved || !sameOwner(saved.owner, targetOwner) || !lane.active) {
      lane.confirmed = { owner: targetOwner, value: fieldValue(track, field) ?? previous,
        clock: saved?.clock || 0, intent: intentSequence + 1 };
      confirmed.set(laneKey, lane.confirmed);
    }
    return new Promise(resolve => {
      const job = { owner: targetOwner, desired: value, sequence: ++intentSequence, resolve };
      lane.latestSequence = job.sequence;
      if (sameOwner(lane.confirmed?.owner, targetOwner)) lane.confirmed.intent = job.sequence;
      if (lane.active) {
        lane.pending?.resolve(null);
        lane.pending = job;
      } else void run(job);
    });

    async function run(job) {
      lane.active = job;
      let error = null;
      let result = null;
      try {
        if (!current(job.owner)) return;
        const data = await send(job.owner, id, field, job.desired);
        if (!current(job.owner)) return;
        const value = data?.track?.id === id ? fieldValue(data.track, field) : undefined;
        if (value === undefined) throw new Error(field === "favorite" ? "收藏回执未包含确认状态" : "评分回执未包含确认分数");
        lane.confirmed = { owner: job.owner, value, clock: ++confirmedClock, intent: lane.latestSequence };
        confirmed.set(laneKey, lane.confirmed);
      } catch (failure) {
        error = failure;
      } finally {
        const next = lane.pending;
        lane.pending = null;
        if (lane.active === job) lane.active = null;
        const saved = lane.confirmed;
        if (!next && current(job.owner) && sameOwner(saved?.owner, job.owner)) {
          result = { owner: job.owner, patch: { id, [field]: saved.value }, field, error };
        }
        job.resolve(result);
        if (next) void run(next);
        else if (lanes.get(laneKey) === lane) lanes.delete(laneKey);
        collectConfirmed();
      }
    }
  }

  return {
    owner, own, ownerOf, sameOwner, current, clone, inherit, startRead, finishRead, preparePayload,
    refresh: track => ownerOf(track) ? prepareTrack(track, ownerOf(track), reads.get(track)) : track,
    readOf: value => reads.get(value) || null,
    favorite: track => write(track, "favorite"),
    rating: (track, value) => write(track, "rating", value)
  };
}
