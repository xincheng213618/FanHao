export function createAdminActorAvatarService({
  actorAvatarService,
  appConfigService,
  clampInteger,
  resolveLibraryPersonByPublicId
}) {
  function publicConfig() {
    return appConfigService.publicConfig();
  }

  function updateAvatarConfig(body = {}) {
    appConfigService.set({
      ...appConfigService.current(),
      actorAvatarDataPath: body.rootPath ?? body.actorAvatarDataPath ?? appConfigService.current().actorAvatarDataPath
    });
    return appConfigService.current().actorAvatarDataPath;
  }

  function resolvePersonId(personId) {
    return resolveLibraryPersonByPublicId(personId)?.id || personId;
  }

  async function importFromFiletreePayload(body = {}, options = {}) {
    const rootPath = updateAvatarConfig(body);
    const summary = await actorAvatarService.importFromFiletree(rootPath, { replace: Boolean(body.replace), signal: options.signal });
    return { ok: true, config: publicConfig(), summary };
  }

  async function candidatesPayload(body = {}, options = {}) {
    const rootPath = updateAvatarConfig(body);
    const summary = await actorAvatarService.candidatesFromFiletree(rootPath, {
      personId: resolvePersonId(body.personId),
      limit: clampInteger(body.limit, 24, 1, 200),
      signal: options.signal
    });
    return { ok: true, config: publicConfig(), summary };
  }

  async function applyCandidatePayload(body = {}, options = {}) {
    const rootPath = updateAvatarConfig(body);
    const result = await actorAvatarService.importCandidate(
      rootPath,
      resolvePersonId(body.personId),
      body.relPath,
      { dryRun: Boolean(body.dryRun), signal: options.signal }
    );
    return { ok: true, config: publicConfig(), ...result };
  }

  function errorPayload(error, fallbackMessage) {
    return {
      statusCode: error.statusCode || 500,
      payload: {
        error: error.message || fallbackMessage,
        config: publicConfig()
      }
    };
  }

  return {
    applyCandidatePayload,
    candidatesPayload,
    errorPayload,
    importFromFiletreePayload
  };
}
