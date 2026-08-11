export const ACTOR_PROFILE_CACHE_TABLES = Object.freeze([
  "people",
  "person_external_refs",
  "person_aliases",
  "images"
]);

export const ACTOR_MOVIE_CACHE_TABLES = Object.freeze([
  "work_people",
  "people",
  "works",
  "person_external_refs",
  "work_external_refs",
  "images"
]);

export const ACTOR_MOVIE_INFO_CACHE_TABLES = Object.freeze([
  "work_people",
  "works",
  "work_external_refs"
]);

const CACHE_TABLE_DEPENDENCIES = Object.freeze({
  actor_profiles: ACTOR_PROFILE_CACHE_TABLES,
  actor_movies: ACTOR_MOVIE_CACHE_TABLES
});

export function cacheDependencyTables(...tables) {
  return [...new Set(tables.flatMap((table) => CACHE_TABLE_DEPENDENCIES[table] || [table]))];
}

export function compositeTableStamp(tableDataStamp, tables) {
  return tables.map((table) => `${table}=${tableDataStamp(table)}`).join("|");
}
