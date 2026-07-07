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

  function importFromFiletreePayload(body = {}) {
    const rootPath = updateAvatarConfig(body);
    const summary = actorAvatarService.importFromFiletree(rootPath, { replace: Boolean(body.replace) });
    return { ok: true, config: publicConfig(), summary };
  }

  function candidatesPayload(body = {}) {
    const rootPath = updateAvatarConfig(body);
    const summary = actorAvatarService.candidatesFromFiletree(rootPath, {
      personId: resolvePersonId(body.personId),
      limit: clampInteger(body.limit, 24, 1, 200)
    });
    return { ok: true, config: publicConfig(), summary };
  }

  function applyCandidatePayload(body = {}) {
    const rootPath = updateAvatarConfig(body);
    const result = actorAvatarService.importCandidate(
      rootPath,
      resolvePersonId(body.personId),
      body.relPath,
      { dryRun: Boolean(body.dryRun) }
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
