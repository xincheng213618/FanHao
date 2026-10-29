const VIDEO_FIELDS = {
  like: { field: "liked", metric: "likes" },
  collect: { field: "collected", metric: "collects" },
  dislike: { field: "disliked", metric: null }
};

// Read provenance belongs to the original request, including cached results.
// Local intent and acknowledgements advance independently for each field.
export function createShortVideoInteractionState({ completedLimit = 256 } = {}) {
  let epoch = 0;
  let authorUnions = 0;
  const journal = new Map(), authorAliases = new Map(), provenance = new WeakMap();
  const captureRead = () => ++epoch;
  const rootRecord = record => {
    while (record?.parent) record = record.parent;
    return record;
  };
  const videoKey = (video, type) => `video:${String(video?.id || "").trim()}:${type}`;
  const authorKeys = (video, author = video?.author || {}) => {
    const id = String(author?.id || video?.ownerUserId || "").trim(), secUid = String(author?.secUid || "").trim();
    return [...(id ? [`author:id:${id}`] : []), ...(secUid ? [`author:sec:${secUid}`] : [])];
  };
  const followKey = (video, author) => {
    const keys = authorKeys(video, author);
    return keys.map(key => authorAliases.get(key)).find(key => journal.has(key)) || keys[0] || "";
  };
  const touch = record => { journal.delete(record.key); journal.set(record.key, record); };
  const trim = () => {
    let completed = [...journal.values()].filter(record => !record.pending).length;
    for (const [key, record] of journal) {
      if (completed <= completedLimit) break;
      if (record.pending) continue;
      journal.delete(key); completed--;
      for (const alias of record.aliases || []) if (authorAliases.get(alias) === key) authorAliases.delete(alias);
    }
  };
  const uniteAuthors = (left, right) => {
    left = rootRecord(left); right = rootRecord(right);
    if (left === right) return left;
    const record = left.key < right.key ? left : right, other = record === left ? right : left;
    const latest = left.intent > right.intent ? left : right;
    const latestValues = { intent: latest.intent, desired: latest.desired, send: latest.send };
    const newerState = left.epoch > right.epoch ? left : right;
    record.confirmed = newerState.confirmed;
    record.confirmedMetric = newerState.confirmedMetric;
    record.epoch = Math.max(left.epoch, right.epoch);
    record.flights = new Set([...left.flights, ...right.flights]);
    record.pending = left.pending || right.pending;
    record.forceFinalWrite = left.forceFinalWrite || right.forceFinalWrite || record.flights.size > 0;
    for (const callback of other.callbacks) record.callbacks.add(callback);
    record.waiters.push(...other.waiters);
    for (const alias of other.aliases) record.aliases.add(alias);
    Object.assign(record, latestValues);
    record.value = record.pending ? record.desired : newerState.value;
    record.metric = null;
    other.parent = record;
    authorUnions += 1;
    other.callbacks.clear(); other.waiters.length = 0;
    journal.delete(other.key);
    for (const alias of record.aliases) authorAliases.set(alias, record.key);
    touch(record);
    return record;
  };
  const registerAuthor = (record, video, author) => {
    record = rootRecord(record);
    const aliases = authorKeys(video, author);
    for (const alias of aliases) {
      const existing = journal.get(authorAliases.get(alias) || alias);
      if (existing && rootRecord(existing) !== record) record = uniteAuthors(record, existing);
    }
    for (const alias of aliases) {
      authorAliases.set(alias, record.key);
      record.aliases.add(alias);
    }
    return record;
  };
  const readField = (record, video) => record.type === "follow"
    ? Boolean(video.author?.following) : Boolean(video.actions?.[VIDEO_FIELDS[record.type].field]);
  const readMetric = (record, video) => record.type !== "follow" && VIDEO_FIELDS[record.type].metric
    ? (Object.hasOwn(video.stats || {}, VIDEO_FIELDS[record.type].metric)
      ? Math.max(0, Number(video.stats[VIDEO_FIELDS[record.type].metric] || 0)) : record.metric) : null;
  const applyRecord = (record, video, readEpoch) => {
    const hasField = record.type === "follow" ? Object.hasOwn(video.author || {}, "following")
      : Object.hasOwn(video.actions || {}, VIDEO_FIELDS[record.type].field);
    if (record.pending || record.epoch > readEpoch || !hasField) {
      if (record.type === "follow") video.author = { ...(video.author || {}), following: record.value };
      else {
        const { field, metric } = VIDEO_FIELDS[record.type];
        video.actions = { ...(video.actions || {}), [field]: record.value };
        if (metric) video.stats = { ...(video.stats || {}), [metric]: record.metric };
      }
      return;
    }
    // A genuinely newer GET may verify or change a completed local state.
    const value = readField(record, video), metric = readMetric(record, video);
    record.value = record.confirmed = value;
    record.metric = record.confirmedMetric = metric;
    record.desired = value;
    // Fence every accepted read, including an unchanged verification. The
    // request's start token orders reads; response arrival must not create a
    // newer token that could suppress an already-issued, later request.
    record.epoch = readEpoch;
    touch(record);
  };
  const mergeVideo = (video, readEpoch) => {
    if (!video || typeof video !== "object") return video;
    const originalEpoch = Number.isFinite(readEpoch) ? readEpoch : (provenance.get(video) ?? 0);
    provenance.set(video, originalEpoch);
    if (video.id) for (const type of Object.keys(VIDEO_FIELDS)) {
      const record = journal.get(videoKey(video, type));
      if (record) applyRecord(record, video, originalEpoch);
    }
    let following = journal.get(followKey(video));
    if (following) {
      const unionsBefore = authorUnions;
      following = registerAuthor(following, video);
      applyRecord(following, video, originalEpoch);
      if (authorUnions !== unionsBefore) publish(following);
    }
    return video;
  };
  const snapshot = record => ({ key: record.key, type: record.type, active: record.value, metric: record.metric, pending: record.pending });
  const publish = record => { for (const callback of record.callbacks) callback(snapshot(record)); };
  const updateOptimistic = record => {
    record.value = record.desired;
    record.metric = record.confirmedMetric == null ? null
      : Math.max(0, record.confirmedMetric + (record.desired === record.confirmed ? 0 : record.desired ? 1 : -1));
  };
  const finish = (record, ok, error) => {
    record = rootRecord(record);
    record.pending = false;
    record.desired = record.value = record.confirmed;
    record.metric = record.confirmedMetric;
    record.epoch = ++epoch;
    touch(record); publish(record);
    for (const waiter of record.waiters.splice(0)) waiter.resolve({ ...snapshot(record), ok, error, superseded: waiter.intent !== record.intent });
    record.callbacks.clear(); trim();
  };
  const pump = async record => {
    record = rootRecord(record);
    if (record.flights.size) return;
    const flight = { intent: record.intent, desired: record.desired, send: record.send, confirmed: record.confirmed };
    record.flights.add(flight);
    let error = null;
    try {
      const data = await flight.send(flight.desired);
      record = rootRecord(record);
      if (record.type === "follow") {
        record = registerAuthor(record, { ownerUserId: data.targetUserId }, { id: data.targetUserId, secUid: data.secUid });
        record.confirmed = Boolean(data.active);
      } else {
        const { field, metric } = VIDEO_FIELDS[record.type];
        record.confirmed = Object.hasOwn(data.video?.actions || {}, field) ? Boolean(data.video.actions[field]) : Boolean(data.active ?? flight.desired);
        if (metric && Object.hasOwn(data.video?.stats || {}, metric)) record.confirmedMetric = Math.max(0, Number(data.video.stats[metric] || 0));
        else if (record.confirmedMetric != null && record.confirmed !== flight.confirmed) {
          record.confirmedMetric = Math.max(0, record.confirmedMetric + (record.confirmed ? 1 : -1));
        }
      }
    } catch (failure) { error = failure; }
    record = rootRecord(record);
    record.flights.delete(flight);
    if (record.flights.size) {
      record.epoch = ++epoch;
      updateOptimistic(record); publish(record);
      return;
    }
    if (record.forceFinalWrite || (record.intent !== flight.intent && (error || record.desired !== record.confirmed))) {
      record.forceFinalWrite = false;
      record.epoch = ++epoch;
      updateOptimistic(record); publish(record);
      void pump(record);
      return;
    }
    finish(record, !error, error);
  };
  const mutate = (key, type, video, author, desired, { send, onChange = () => {} }) => {
    mergeVideo(video);
    if (type === "follow") key = followKey(video, author);
    let record = journal.get(key);
    if (!record) {
      const field = VIDEO_FIELDS[type]?.field, metric = VIDEO_FIELDS[type]?.metric;
      const confirmed = type === "follow" ? Boolean(author?.following) : Boolean(video.actions?.[field]);
      const confirmedMetric = metric ? Math.max(0, Number(video.stats?.[metric] || 0)) : null;
      record = { key, type, confirmed, confirmedMetric, value: confirmed,
        metric: confirmedMetric, intent: 0, epoch: 0, pending: false, flights: new Set(), forceFinalWrite: false,
        callbacks: new Set(), waiters: [], aliases: new Set() };
      journal.set(key, record);
    }
    if (type === "follow") record = registerAuthor(record, video, author);
    record.epoch = ++epoch;
    record.intent = record.epoch;
    record.desired = Boolean(desired);
    record.pending = true;
    record.send = send;
    record.callbacks.add(onChange);
    updateOptimistic(record); touch(record);
    const result = new Promise(resolve => record.waiters.push({ resolve, intent: record.intent }));
    publish(record);
    if (!record.flights.size) void pump(record);
    return result;
  };
  const mutateVideo = (video, type, desired, options) => mutate(videoKey(video, type), type, video, null, desired, options);
  const mutateFollow = (video, author, desired, options) => mutate(followKey(video, author), "follow", video, author, desired, options);
  const videoState = (video, type) => {
    const record = journal.get(videoKey(video, type));
    return record ? snapshot(record) : { active: Boolean(mergeVideo(video)?.actions?.[VIDEO_FIELDS[type].field]), pending: false };
  };
  const followState = (video, author = video?.author || {}) => {
    const key = followKey(video, author), record = journal.get(key);
    return record ? snapshot(record) : { key, active: Boolean(author.following), pending: false };
  };
  return { captureRead, mergeVideo, mutateVideo, mutateFollow, videoState, followState,
    stats: () => ({ epoch, entries: journal.size, pending: [...journal.values()].filter(record => record.pending).length }) };
}
