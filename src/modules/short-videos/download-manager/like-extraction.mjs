function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function likeContainerOwner(value) {
  return firstText(
    value?.sec_uid,
    value?.secUid,
    value?.sec_user_id,
    value?.secUserId
  );
}

export function isConfirmedLikeItem(value) {
  if (!value || typeof value !== "object") return false;
  const liked = value.user_digged ?? value.userDigged;
  return liked === true || Number(liked) === 1;
}

export function collectConfirmedLikeItems(value, targetSecUid) {
  const target = firstText(targetSecUid);
  const items = [];
  const seen = new Set();

  const visit = (current, depth = 0) => {
    if (!current || depth > 8) return;
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object") return;

    const awemeList = Array.isArray(current.aweme_list)
      ? current.aweme_list
      : Array.isArray(current.awemeList)
        ? current.awemeList
        : null;
    if (awemeList) {
      const owner = likeContainerOwner(current);
      if ((!target || owner === target) && (!target || owner)) {
        for (const item of awemeList) {
          if (!isConfirmedLikeItem(item)) continue;
          const awemeId = firstText(
            item.aweme_id,
            item.awemeId,
            item.group_id,
            item.groupId,
            item.item_id,
            item.itemId
          );
          if (!/^\d{16,22}$/.test(awemeId) || seen.has(awemeId)) continue;
          seen.add(awemeId);
          items.push(item);
        }
      }
      return;
    }

    for (const child of Object.values(current)) {
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };

  visit(value);
  return items;
}

export function hasUsableWorkMetadata(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    firstText(
      value.author_uid,
      value.author_sec_uid,
      value.author_nickname,
      value.desc,
      value.cover_url
    )
  );
}
