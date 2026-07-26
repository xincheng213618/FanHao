const GAMES = [
  {
    availability: "网页 + 手机端",
    category: "AI 数字益智",
    description: "带 WASM AI 的 2048 静态版。可以自己玩，也可以随时查看下一步建议或让 AI 自动运行。",
    featured: true,
    href: "/games/2048/index.html",
    poster: "2048",
    posterCaption: "THINK AHEAD",
    slug: "2048",
    source: "game-difficulty/2048EndgameTablebase · GPL-3.0",
    subtitle: "把下一步交给算法",
    tags: ["WASM AI", "一步建议", "自动运行"],
    title: "2048 AI Engine",
    tone: "sun"
  },
  {
    availability: "网页 + 手机端",
    category: "经典滑块",
    description: "在有限空间里移动棋子，帮助曹操从出口脱身。内置多组关卡，也可以交给 AI 自动求解。",
    href: "/games/huarongdao/index.html#/game",
    poster: "华容道",
    posterCaption: "CLASSIC PUZZLE",
    slug: "huarongdao",
    source: "jeantimex/hua-rong-dao-html",
    subtitle: "一步一步，移出困局",
    tags: ["多关卡", "AI 解题", "点按操作"],
    title: "华容道",
    tone: "rust"
  },
  {
    availability: "仅网页",
    category: "AI 棋类",
    description: "对战开源 Rapfi NNUE 引擎。支持执黑或执白、三档难度和悔棋，适合认真下一盘。",
    href: "/games/gomoku/index.html",
    poster: "五子棋",
    posterCaption: "RAPFI NNUE",
    slug: "gomoku",
    source: "dhbloo/rapfi · GPL-3.0",
    subtitle: "和强棋力 AI 对弈",
    tags: ["三档难度", "黑白方", "支持悔棋"],
    title: "五子棋 AI",
    tone: "forest"
  },
  {
    availability: "仅网页",
    category: "轻量街机",
    description: "按住蓄力，松开起跳。操作很简单，但落点需要判断，支持触控、计分和本地最佳成绩。",
    href: "/games/jump/index.html",
    poster: "JUMP",
    posterCaption: "PRESS · HOLD · RELEASE",
    slug: "jump",
    source: "shenmaxg/web-jump · MIT",
    subtitle: "蓄好力，跳得更远",
    tags: ["触控操作", "本地计分", "快速开局"],
    title: "蓄力跳台",
    tone: "slate"
  }
];

export function createToolsPage(deps) {
  const {
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    resetProgressiveCoverLoading
  } = deps;

  function renderStats() {
    els.statsRow.innerHTML = "";
    els.statsRow.hidden = true;
  }

  function renderView() {
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    els.workGrid.innerHTML = "";

    const library = document.createElement("section");
    library.className = "game-library";
    library.setAttribute("aria-labelledby", "gameLibraryTitle");
    library.append(createHero(), createGameCollection());
    els.workGrid.append(library);
  }

  function createHero() {
    const hero = document.createElement("header");
    hero.className = "game-library-hero";

    const copy = document.createElement("div");
    copy.className = "game-library-hero-copy";

    const eyebrow = document.createElement("div");
    eyebrow.className = "game-library-eyebrow";
    eyebrow.textContent = "PLAYGROUND · 离线运行";

    const title = document.createElement("h3");
    title.id = "gameLibraryTitle";
    title.textContent = "选一个，马上开局";

    const description = document.createElement("p");
    description.textContent = "不需要安装，也没有账号流程。所有游戏都直接在浏览器本地运行，打开就能玩。";

    const notes = document.createElement("div");
    notes.className = "game-library-notes";
    notes.append(
      createNote("4 款", "可选游戏"),
      createNote("2 款", "支持手机端"),
      createNote("本地", "浏览器运行")
    );

    copy.append(eyebrow, title, description);
    hero.append(copy, notes);
    return hero;
  }

  function createNote(value, label) {
    const note = document.createElement("div");
    note.className = "game-library-note";

    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = label;

    note.append(strong, span);
    return note;
  }

  function createGameCollection() {
    const collection = document.createElement("section");
    collection.className = "game-library-collection";
    collection.setAttribute("aria-labelledby", "allGamesTitle");

    const head = document.createElement("div");
    head.className = "game-library-section-head";

    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "全部游戏";
    const title = document.createElement("h4");
    title.id = "allGamesTitle";
    title.textContent = "今天想玩哪一个？";
    copy.append(eyebrow, title);

    const hint = document.createElement("p");
    hint.textContent = "网页专属游戏不会出现在安卓客户端";
    head.append(copy, hint);

    const grid = document.createElement("div");
    grid.className = "game-library-grid";
    for (const game of GAMES) grid.append(createGameCard(game));

    collection.append(head, grid);
    return collection;
  }

  function createGameCard(game) {
    const card = document.createElement("a");
    card.className = `game-library-card tone-${game.tone}${game.featured ? " featured" : ""}`;
    card.href = game.href;
    card.dataset.game = game.slug;
    card.setAttribute("aria-label", `打开${game.title}`);

    const art = document.createElement("span");
    art.className = "game-card-art";
    art.setAttribute("aria-hidden", "true");

    const posterCaption = document.createElement("small");
    posterCaption.textContent = game.posterCaption;
    const poster = document.createElement("strong");
    poster.textContent = game.poster;
    art.append(posterCaption, poster);

    const body = document.createElement("span");
    body.className = "game-card-body";

    const meta = document.createElement("span");
    meta.className = "game-card-meta";
    const category = document.createElement("span");
    category.className = "game-card-category";
    category.textContent = game.category;
    const availability = document.createElement("span");
    availability.className = "game-card-availability";
    availability.textContent = game.availability;
    meta.append(category, availability);

    const title = document.createElement("strong");
    title.className = "game-card-title";
    title.textContent = game.title;

    const subtitle = document.createElement("span");
    subtitle.className = "game-card-subtitle";
    subtitle.textContent = game.subtitle;

    const description = document.createElement("span");
    description.className = "game-card-description";
    description.textContent = game.description;

    const tags = document.createElement("span");
    tags.className = "game-card-tags";
    for (const tag of game.tags) {
      const item = document.createElement("span");
      item.textContent = tag;
      tags.append(item);
    }

    const footer = document.createElement("span");
    footer.className = "game-card-footer";
    const source = document.createElement("small");
    source.className = "game-card-source";
    source.textContent = game.source;
    const action = document.createElement("b");
    action.className = "game-card-action";
    action.textContent = "开始游戏";
    footer.append(source, action);

    body.append(meta, title, subtitle, description, tags, footer);
    card.append(art, body);
    return card;
  }

  return {
    renderStats,
    renderView
  };
}
