export function appendWorkCardsInPlace(options = {}) {
  const {
    activateImages = () => {},
    container,
    createCard,
    items = []
  } = options;
  if (!container || typeof createCard !== "function") return { added: 0, reordered: false };

  const visible = Array.isArray(items) ? items : [];
  const renderedCards = [...container.querySelectorAll(".work-card")];
  const cardById = new Map(renderedCards.map((card) => [cardId(card), card]));
  const visibleIds = visible.map((item) => String(item?.id || ""));
  const prefixMatches = renderedCards.every((card, index) => cardId(card) === visibleIds[index]);
  const added = visibleIds.filter((id) => !cardById.has(id)).length;
  const newImages = [];

  if (prefixMatches && renderedCards.length <= visible.length) {
    const fragment = container.ownerDocument.createDocumentFragment();
    for (let index = renderedCards.length; index < visible.length; index += 1) {
      fragment.append(createTrackedCard(visible[index], index, createCard, newImages));
    }
    container.append(fragment);
    activateImages(newImages);
    return { added, reordered: false };
  }

  const desiredIds = new Set(visibleIds);
  const viewport = container.ownerDocument.defaultView;
  const anchor = findScrollAnchor(renderedCards, desiredIds, viewport);
  const anchorTop = anchor?.getBoundingClientRect().top;
  let reference = renderedCards[0] || null;

  for (let index = 0; index < visible.length; index += 1) {
    const id = visibleIds[index];
    const card = cardById.get(id) || createTrackedCard(visible[index], index, createCard, newImages);
    updatePendingCoverIndex(card, index);
    if (card === reference) {
      reference = nextWorkCard(reference);
    } else if (reference) {
      container.insertBefore(card, reference);
    } else {
      container.append(card);
    }
  }

  for (const card of renderedCards) {
    if (!desiredIds.has(cardId(card))) card.remove();
  }
  activateImages(newImages);
  restoreScrollAnchor(anchor, anchorTop, viewport);
  return { added, reordered: true };
}

export function workServerMoreState(state = {}) {
  return {
    hasSearchServerMore: state.activeView === "search" && state.works.length < state.searchTotal,
    hasPersonServerMore: Boolean(state.activeView === "people" && state.selectedPersonId && state.works.length < state.personWorksTotal),
    hasCodePrefixServerMore: Boolean(state.activeView === "codes" && state.selectedCodePrefix && state.works.length < state.codePrefixTotal),
    hasRankingServerMore: state.activeView === "rankings" && state.works.length < state.rankingTotal,
    hasCollectionServerMore: ["favorites", "history"].includes(state.activeView) && state.works.length < state.collectionTotal,
    hasVrServerMore: state.activeView === "vr" && state.works.length < state.vrTotal,
    hasStudioServerMore: Boolean(state.activeView === "studios" && state.selectedStudio && state.works.length < state.studioWorksTotal)
  };
}

function createTrackedCard(item, index, createCard, newImages) {
  const card = createCard(item, index);
  const image = card.querySelector("img.progressive-cover-image[data-src]");
  if (image) newImages.push(image);
  return card;
}

function cardId(card) {
  return String(card?.dataset?.workId || "");
}

function nextWorkCard(card) {
  let next = card?.nextElementSibling || null;
  while (next && !next.classList.contains("work-card")) next = next.nextElementSibling;
  return next;
}

function updatePendingCoverIndex(card, index) {
  const image = card.querySelector("img.progressive-cover-image[data-src]");
  if (image) image.dataset.coverIndex = String(index);
}

function findScrollAnchor(cards, desiredIds, viewport) {
  const viewportHeight = Number(viewport?.innerHeight || 0);
  const retained = cards.filter((card) => desiredIds.has(cardId(card)));
  return retained.find((card) => {
    const rect = card.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < viewportHeight;
  }) || retained.find((card) => card.getBoundingClientRect().bottom > 0) || retained[0] || null;
}

function restoreScrollAnchor(anchor, anchorTop, viewport) {
  if (!anchor?.isConnected || !Number.isFinite(anchorTop) || !viewport) return;
  const delta = anchor.getBoundingClientRect().top - anchorTop;
  if (Math.abs(delta) < 0.5) return;
  viewport.scrollTo({ top: Math.max(0, Number(viewport.scrollY || 0) + delta), left: 0, behavior: "auto" });
}
