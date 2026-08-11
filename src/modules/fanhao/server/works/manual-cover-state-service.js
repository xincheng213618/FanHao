import fs from "node:fs";
import {
  assertActorProfileMutationAllowed,
  clearActorProfilePublication
} from "../people/actor-profile-mutation-guard.js";

export function createManualCoverStateService({
  corePersonFallbackRecord,
  coreWorkCoverRow,
  getCoreDb,
  getLibrary,
  invalidateActorProfiles,
  localImageMime,
  maxActorAvatarBytes,
  mergedPersonRecord,
  publicPerson,
  publicWork,
  publicWorkInfoSummary,
  resolveLibraryPersonByPublicId,
  resolveLibraryWorkByPublicId,
  safeStat,
  userState,
  userStateService,
  userStateSummary,
  workCoverRow,
  workInfoDetailRow,
  workInfoRow
}) {
  function manualCoverRecord(workId) {
    const record = userStateService.normalizeManualCoverRecord(userState.manualCovers?.[workId]);
    return record || null;
  }

  function manualCoverForWork(work) {
    if (!work?.id) return null;
    const record = manualCoverRecord(work.id);
    if (!record) return null;
    const image = (work.images || []).find((item) => item.id === record.imageId);
    return image ? { image, record } : null;
  }

  function setWorkManualCover(workId, imageId) {
    const work = resolveLibraryWorkByPublicId(workId);
    if (!work || work.missingLocal) {
      const error = new Error("作品不存在");
      error.statusCode = 404;
      throw error;
    }

    const id = String(imageId || "").trim();
    userState.manualCovers = userState.manualCovers && typeof userState.manualCovers === "object" ? userState.manualCovers : {};

    if (!id) {
      delete userState.manualCovers[work.id];
    } else {
      const image = (work.images || []).find((item) => item.id === id);
      if (!image) {
        const error = new Error("只能选择这个作品自己的图片作为封面");
        error.statusCode = 400;
        throw error;
      }
      userState.manualCovers[work.id] = {
        imageId: image.id,
        updatedAt: new Date().toISOString()
      };
    }

    userStateService.save();
    return {
      manualCoverId: manualCoverRecord(work.id)?.imageId || "",
      work: publicWork(work, true),
      user: userStateSummary()
    };
  }

  function cleanAvatarMime(value, fallback = "image/jpeg") {
    const mime = String(value || "").trim().toLowerCase();
    return /^image\/(?:jpeg|png|webp|gif|bmp)$/.test(mime) ? mime : fallback;
  }

  function localImageBlobForAvatar(file) {
    const stat = safeStat(file?.path);
    if (!stat?.isFile() || stat.size <= 0 || stat.size > maxActorAvatarBytes) return null;
    return fs.readFileSync(file.path);
  }

  function personAvatarPayloadFromWork(work) {
    if (!work || work.missingLocal) return null;
    const now = new Date().toISOString();
    const manualCover = manualCoverForWork(work);
    const manualImage = manualCover?.image || null;
    if (manualImage?.id) {
      const blob = localImageBlobForAvatar(manualImage);
      if (!blob) return null;
      return {
        sourceType: "local",
        localPath: "",
        remoteUrl: "",
        mime: localImageMime(manualImage),
        blob,
        byteSize: blob?.length || manualImage.size || null,
        source: "manual_person_cover",
        legacyKey: work.id,
        now
      };
    }

    const coreCover = coreWorkCoverRow(work.id);
    if (coreCover) {
      const blob = coreCover.image_blob ? Buffer.from(coreCover.image_blob) : null;
      if (!blob && coreCover.local_path && !coreCover.remote_url) return null;
      return {
        sourceType: blob ? "local" : coreCover.remote_url ? "remote" : coreCover.local_path ? "local" : "unknown",
        localPath: coreCover.local_path || "",
        remoteUrl: coreCover.remote_url || "",
        mime: cleanAvatarMime(coreCover.mime),
        blob,
        byteSize: blob?.length || coreCover.byte_size || null,
        source: "manual_person_cover",
        legacyKey: work.id,
        now
      };
    }

    if (work.coverId) {
      const image = (work.images || []).find((item) => item.id === work.coverId);
      if (image) {
        const blob = localImageBlobForAvatar(image);
        if (!blob) return null;
        return {
          sourceType: "local",
          localPath: "",
          remoteUrl: "",
          mime: localImageMime(image),
          blob,
          byteSize: blob?.length || image.size || null,
          source: "manual_person_cover",
          legacyKey: work.id,
          now
        };
      }
    }

    const cachedCover = workCoverRow(work.id);
    if (cachedCover?.cover_blob) {
      const blob = Buffer.from(cachedCover.cover_blob);
      return {
        sourceType: "local",
        localPath: "",
        remoteUrl: cachedCover.cover_url || "",
        mime: cleanAvatarMime(cachedCover.cover_mime),
        blob,
        byteSize: blob.length,
        source: "manual_person_cover",
        legacyKey: work.id,
        now
      };
    }

    const infoSummary = publicWorkInfoSummary(workInfoDetailRow(work.id), work.infoSummary);
    const remoteUrl = work.remoteCoverUrl || infoSummary?.imageUrl || "";
    if (!remoteUrl) return null;
    return {
      sourceType: "remote",
      localPath: "",
      remoteUrl,
      mime: "image/jpeg",
      blob: null,
      byteSize: null,
      source: "manual_person_cover",
      legacyKey: work.id,
      now
    };
  }

  function personAvatarPayloadFromUpload(payload) {
    const base64 = String(payload.imageBase64 || payload.avatarBase64 || "").replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
    if (!base64) return null;
    const blob = Buffer.from(base64, "base64");
    if (!blob.length || blob.length > maxActorAvatarBytes) {
      const error = new Error(`图片不能超过 ${Math.floor(maxActorAvatarBytes / 1024 / 1024)}MB`);
      error.statusCode = 413;
      throw error;
    }
    const now = new Date().toISOString();
    return {
      sourceType: "local",
      localPath: "",
      remoteUrl: "",
      mime: cleanAvatarMime(payload.imageMime || payload.avatarMime),
      blob,
      byteSize: blob.length,
      source: "manual_upload",
      legacyKey: String(payload.fileName || payload.name || "uploaded-avatar").slice(0, 260),
      now
    };
  }

  function replaceManualPersonAvatar(personId, payload) {
    const corePersonId = Number(personId);
    if (!Number.isFinite(corePersonId)) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }
    const db = getCoreDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      assertActorProfileMutationAllowed(db, corePersonId);
      clearActorProfilePublication(db, corePersonId, payload ? {} : {
        sources: ["manual_upload", "manual_person_cover", "manual"]
      });
      db.prepare("DELETE FROM fanhao_images.images WHERE owner_type = 'person' AND owner_id = ? AND kind = 'avatar' AND source IN ('manual_person_cover', 'manual_upload')").run(corePersonId);
      if (payload) {
        db.prepare(
          `
          INSERT INTO fanhao_images.images (
            owner_type, owner_id, kind, source_type, local_path, remote_url, mime, image_blob, byte_size,
            sort_order, status, source, legacy_table, legacy_key, created_at, updated_at
          )
          VALUES ('person', ?, 'avatar', ?, ?, ?, ?, ?, ?, 0, 'ok', ?, 'manual_person_avatar', ?, ?, ?)
          `
        ).run(
          corePersonId,
          payload.sourceType || "unknown",
          payload.localPath || "",
          payload.remoteUrl || "",
          payload.mime || "image/jpeg",
          payload.blob || null,
          payload.byteSize || null,
          payload.source || "manual",
          payload.legacyKey || String(personId),
          payload.now,
          payload.now
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Avatar replacement failed and its image transaction could not be rolled back");
      }
      throw error;
    }
    invalidateActorProfiles();
  }

  function setPersonManualCover(personId, workId) {
    const library = getLibrary();
    const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const mergedPerson = mergedPersonRecord(person);
    if (!mergedPerson) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }

    const id = String(workId || "").trim();
    if (!id) {
      replaceManualPersonAvatar(mergedPerson.id, null);
    } else {
      const work = library.worksById.get(id);
      if (!work || !(mergedPerson.works || []).includes(work.id)) {
        const error = new Error("只能选择这个人物自己的作品封面");
        error.statusCode = 400;
        throw error;
      }
      const avatar = personAvatarPayloadFromWork(work);
      if (!avatar) {
        const error = new Error("这个作品没有可用封面");
        error.statusCode = 400;
        throw error;
      }
      replaceManualPersonAvatar(mergedPerson.id, avatar);
    }

    return {
      person: publicPerson(mergedPerson),
      user: userStateSummary()
    };
  }

  function setPersonUploadedCover(personId, payload) {
    const person = resolveLibraryPersonByPublicId(personId) || corePersonFallbackRecord(personId);
    const mergedPerson = mergedPersonRecord(person);
    if (!mergedPerson) {
      const error = new Error("人物不存在");
      error.statusCode = 404;
      throw error;
    }
    const avatar = personAvatarPayloadFromUpload(payload);
    if (!avatar) {
      const error = new Error("请选择要上传的图片");
      error.statusCode = 400;
      throw error;
    }
    replaceManualPersonAvatar(mergedPerson.id, avatar);
    return {
      person: publicPerson(mergedPerson),
      user: userStateSummary()
    };
  }

  return {
    cleanAvatarMime,
    localImageBlobForAvatar,
    manualCoverForWork,
    manualCoverRecord,
    personAvatarPayloadFromUpload,
    personAvatarPayloadFromWork,
    replaceManualPersonAvatar,
    setPersonManualCover,
    setPersonUploadedCover,
    setWorkManualCover
  };
}
