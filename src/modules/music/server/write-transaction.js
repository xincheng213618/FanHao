const MUSIC_WRITE_BUSY_MESSAGE = "音乐数据正在更新，请稍后重试";

export function runMusicWriteTransaction(database, operation) {
  let transactionActive = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionActive = true;
    const result = operation(database);
    database.exec("COMMIT");
    transactionActive = false;
    return result;
  } catch (error) {
    if (transactionActive) {
      try { database.exec("ROLLBACK"); } catch {}
    }
    if (isMusicDatabaseBusyError(error)) throw musicWriteBusyError(error);
    throw error;
  }
}

export function isMusicDatabaseBusyError(error) {
  if ([5, 6].includes(Number(error?.errcode)) || [5, 6].includes(Number(error?.errno))) return true;
  const value = `${String(error?.code || "")} ${String(error?.message || error || "")}`;
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(value);
}

export function musicWriteBusyError(cause) {
  const error = new Error(MUSIC_WRITE_BUSY_MESSAGE, { cause });
  error.code = "MUSIC_WRITE_BUSY";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

export function musicSchemaBusyError(cause) {
  const error = new Error("音乐数据库初始化暂时被占用，请稍后重试", { cause });
  error.code = "MUSIC_SCHEMA_DATABASE_BUSY";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  return error;
}

export { MUSIC_WRITE_BUSY_MESSAGE };
