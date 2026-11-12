export function isLocalTrackSearch(mode) {
  return mode === "playlist" || mode === "history";
}

function normalize(value) {
  return String(value || "").normalize("NFKC").toLowerCase().trim();
}

export function matchingTrackPositions(tracks, query) {
  const needle = normalize(query);
  const positions = [];
  for (const [index, track] of tracks.entries()) {
    if ([track.title, track.artist, track.album, track.fileName].some(value => normalize(value).includes(needle))) {
      positions.push(index);
    }
  }
  return positions;
}
