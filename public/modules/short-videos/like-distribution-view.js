import { createShortVideoAuthorCleanup } from "./author-cleanup.js?v=20260825-author-cleanup-01";
import { invalidateLikeDistributionCache } from "./like-distribution-cache.js?v=20260825-author-efficiency-01";

export function createLikeDistributionView(deps) {
  const {
    api,
    deleteRecovery,
    formatNumber,
    loadLikeDistribution,
    openInsightAuthor,
    openInsightTopic,
    showError,
    showToast,
    state
  } = deps;
  const authorCleanup = createShortVideoAuthorCleanup({
    api,
    recovery: deleteRecovery,
    showToast,
    onCompleted: ({ preview, trigger }) => applyCompletedAuthorCleanup(preview, trigger)
  });

  function applyCompletedAuthorCleanup(preview = {}, trigger = null) {
    const efficiency = state.shortVideo.likeDistribution?.insights?.personal?.authorEfficiency;
    const secUid = String(preview.secUid || "").trim();
    if (efficiency && secUid) {
      for (const key of ["authors", "highHit", "lowYield", "lowYieldAuthors"]) {
        if (!Array.isArray(efficiency[key])) continue;
        efficiency[key] = efficiency[key].filter((item) => String(item.secUid || "").trim() !== secUid);
      }
      efficiency.totalVideos = Math.max(0, Number(efficiency.totalVideos || 0) - Number(preview.deleteCount || 0));
      efficiency.sizeBytes = Math.max(0, Number(efficiency.sizeBytes || 0) - Number(preview.deleteBytes || 0));
      efficiency.eligibleAuthorTotal = Math.max(0, Number(efficiency.eligibleAuthorTotal || 0) - 1);
      efficiency.baselineHitRate = efficiency.totalVideos
        ? Math.max(0, Number(efficiency.likedVideos || 0)) / efficiency.totalVideos
        : 0;
    }
    invalidateLikeDistributionCache();
    trigger?.closest?.(".short-video-personal-list-row, tr")?.remove();
  }

  function likeDistributionDensityPerThousand(item = {}) {
    if (item.maxLikes == null) return null;
    const minLikes = Number(item.minLikes || 0);
    const maxLikes = Number(item.maxLikes);
    const width = maxLikes - minLikes;
    if (!Number.isFinite(width) || width <= 0) return null;
    return Math.max(0, Number(item.videoCount || 0)) * 1000 / width;
  }

  function formatLikeDistributionDensity(value) {
    if (!Number.isFinite(value)) return "开放区间";
    const maximumFractionDigits = value >= 100 ? 1 : value >= 1 ? 2 : 3;
    return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
  }

  function renderLikeDistributionSectionHeading(titleText, copyText) {
    const heading = document.createElement("div");
    heading.className = "short-video-distribution-section-head";
    const title = document.createElement("h3");
    title.textContent = titleText;
    const copy = document.createElement("p");
    copy.textContent = copyText;
    heading.append(title, copy);
    return heading;
  }

  function renderLikeDistributionLoadingStatus(hasPreviousData) {
    const status = document.createElement("div");
    status.className = "short-video-distribution-progress";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "short-video-distribution-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = hasPreviousData ? "正在同步最新统计" : "正在读取统计缓存";
    const description = document.createElement("span");
    description.textContent = hasPreviousData
      ? "完成前继续显示上一次结果；只有手动刷新才会强制重新计算。"
      : "首次打开会读取一次服务端结果，之后优先复用本机缓存。";
    copy.append(title, description);
    const track = document.createElement("span");
    track.className = "short-video-distribution-progress-track";
    track.setAttribute("aria-hidden", "true");
    status.append(spinner, copy, track);
    return status;
  }

  function shortVideoDistributionSvgElement(tagName, attributes = {}) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "text") element.textContent = String(value);
      else element.setAttribute(name, String(value));
    }
    return element;
  }

  function formatLikeDistributionAxisValue(logValue) {
    const value = 10 ** logValue;
    if (value >= 1000) return `${formatNumber(Math.round(value / 1000))}千`;
    if (value >= 1) return formatNumber(Math.round(value));
    return value.toFixed(Math.max(1, Math.abs(Math.floor(logValue))));
  }

  function renderLikeDistributionLogChart(bins) {
    const points = bins.map((item) => {
      const density = likeDistributionDensityPerThousand(item);
      const minLikes = Math.max(0, Number(item.minLikes || 0));
      const maxLikes = Number(item.maxLikes || 0);
      if (!Number.isFinite(density) || density <= 0 || maxLikes <= minLikes) return null;
      const centerLikes = minLikes > 0 ? Math.sqrt(minLikes * maxLikes) : maxLikes / 2;
      return {
        label: item.label || "",
        density,
        likes: centerLikes,
        xLog: Math.log10(centerLikes),
        yLog: Math.log10(density)
      };
    }).filter(Boolean);
    const section = document.createElement("section");
    section.className = "short-video-distribution-section is-log-chart";
    section.append(renderLikeDistributionSectionHeading(
      "点赞—密度双对数图",
      "这是经过个人喜好筛选的兴趣样本，不代表抖音平台总体分布。横轴为点赞数 log10，纵轴为每千赞视频密度 log10；折线的斜率变化和拐点可作为候选特征值，但不等同于平台因果阈值。500万+为开放区间，不参与绘图。"
    ));
    if (!points.length) return section;

    const chart = document.createElement("div");
    chart.className = "short-video-distribution-log-chart";
    const width = 960;
    const height = 350;
    const padding = { top: 24, right: 24, bottom: 52, left: 72 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xMin = Math.min(...points.map((item) => item.xLog));
    const xMax = Math.max(Math.log10(5000000), ...points.map((item) => item.xLog));
    const yMin = Math.floor(Math.min(...points.map((item) => item.yLog)));
    const yMax = Math.ceil(Math.max(...points.map((item) => item.yLog)));
    const mapX = (value) => padding.left + (value - xMin) / Math.max(.001, xMax - xMin) * plotWidth;
    const mapY = (value) => padding.top + (yMax - value) / Math.max(.001, yMax - yMin) * plotHeight;
    const svg = shortVideoDistributionSvgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "点赞数与每千赞视频密度的双对数折线图"
    });

    for (let tick = yMin; tick <= yMax; tick += 1) {
      const y = mapY(tick);
      svg.append(
        shortVideoDistributionSvgElement("line", { class: "short-video-distribution-log-grid", x1: padding.left, y1: y, x2: width - padding.right, y2: y }),
        shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-tick", x: padding.left - 10, y: y + 4, "text-anchor": "end", text: formatLikeDistributionAxisValue(tick) })
      );
    }

    for (const tick of [
      { value: 1000, label: "1千" },
      { value: 10000, label: "1万" },
      { value: 100000, label: "10万" },
      { value: 1000000, label: "100万" },
      { value: 5000000, label: "500万" }
    ]) {
      const x = mapX(Math.log10(tick.value));
      svg.append(
        shortVideoDistributionSvgElement("line", { class: "short-video-distribution-log-grid is-vertical", x1: x, y1: padding.top, x2: x, y2: height - padding.bottom }),
        shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-tick", x, y: height - padding.bottom + 20, "text-anchor": "middle", text: tick.label })
      );
    }

    const pathData = points.map((item, index) => `${index ? "L" : "M"}${mapX(item.xLog).toFixed(2)},${mapY(item.yLog).toFixed(2)}`).join(" ");
    svg.append(shortVideoDistributionSvgElement("path", { class: "short-video-distribution-log-line", d: pathData }));
    for (const point of points) {
      const circle = shortVideoDistributionSvgElement("circle", {
        class: "short-video-distribution-log-point",
        cx: mapX(point.xLog),
        cy: mapY(point.yLog),
        r: 4
      });
      circle.append(shortVideoDistributionSvgElement("title", {
        text: `${point.label}：约 ${formatNumber(Math.round(point.likes))} 赞，密度 ${formatLikeDistributionDensity(point.density)} 条/千赞`
      }));
      svg.append(circle);
    }
    svg.append(
      shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-axis-title", x: padding.left + plotWidth / 2, y: height - 10, "text-anchor": "middle", text: "点赞数（log10）" }),
      shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-axis-title", x: 18, y: padding.top + plotHeight / 2, transform: `rotate(-90 18 ${padding.top + plotHeight / 2})`, "text-anchor": "middle", text: "每千赞视频密度（log10）" })
    );
    chart.append(svg);
    const legend = document.createElement("div");
    legend.className = "short-video-distribution-log-legend";
    legend.innerHTML = '<span><i class="is-line"></i>本地兴趣样本密度</span>';
    section.append(chart, legend);
    return section;
  }

  function insightPercent(value, digits = 0) {
    return `${(Math.max(0, Math.min(1, Number(value || 0))) * 100).toFixed(digits)}%`;
  }

  function insightRatio(value, digits = 1) {
    return `${(Math.max(0, Number(value || 0)) * 100).toFixed(digits)}%`;
  }

  function insightTypeById(valueMap, id) {
    return (valueMap?.types || []).find((item) => item?.id === id) || { count: 0 };
  }

  function insightAxisRate(position, maximum) {
    return Math.expm1(Math.max(0, Math.min(1, Number(position || 0))) * Math.log1p(Math.max(0, Number(maximum || 0)) * 100)) / 100;
  }

  function insightQuadrantById(valueMap, id) {
    return (valueMap?.quadrants || []).find((item) => item?.id === id) || { count: 0, highResCandidates: 0 };
  }

  function renderContentValueMap(valueMap = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-insight-value-map";
    section.append(renderLikeDistributionSectionHeading(
      "内容传播结构图",
      "坐标是真实藏/赞与转/赞，使用对数轴并截到 98 分位，既保留真实聚类又避免极端值压扁图形；内容类型则在相近点赞数量级内比较。"
    ));
    const cells = Array.isArray(valueMap.cells) ? valueMap.cells : [];
    if (!cells.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-distribution-empty";
      empty.textContent = "赞、藏、转数据不足，暂时无法绘制内容传播结构图。";
      section.append(empty);
      return section;
    }

    const chart = document.createElement("div");
    chart.className = "short-video-insight-map-chart";
    const width = 960;
    const height = 430;
    const padding = { top: 30, right: 28, bottom: 62, left: 72 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const xThreshold = Math.max(0, Math.min(1, Number(valueMap.collectThresholdPosition || 0.7)));
    const yThreshold = Math.max(0, Math.min(1, Number(valueMap.shareThresholdPosition || 0.7)));
    const collectAxisMax = Math.max(0, Number(valueMap.collectAxisMax || 0));
    const shareAxisMax = Math.max(0, Number(valueMap.shareAxisMax || 0));
    const mapX = (value) => padding.left + Math.max(0, Math.min(1, value)) * plotWidth;
    const mapY = (value) => padding.top + (1 - Math.max(0, Math.min(1, value))) * plotHeight;
    const svg = shortVideoDistributionSvgElement("svg", {
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": "同点赞量级内收藏倾向与分享倾向的内容传播结构图"
    });
    const quadrantSpecs = [
      { id: "personal", x: 0, y: yThreshold, w: xThreshold, h: 1 - yThreshold },
      { id: "priority", x: xThreshold, y: yThreshold, w: 1 - xThreshold, h: 1 - yThreshold },
      { id: "ordinary", x: 0, y: 0, w: xThreshold, h: yThreshold },
      { id: "platform", x: xThreshold, y: 0, w: 1 - xThreshold, h: yThreshold }
    ];
    const quadrantLabels = [];
    for (const quadrant of quadrantSpecs) {
      const summary = insightQuadrantById(valueMap, quadrant.id);
      const x = mapX(quadrant.x);
      const y = mapY(quadrant.y + quadrant.h);
      const rectWidth = quadrant.w * plotWidth;
      const rectHeight = quadrant.h * plotHeight;
      svg.append(shortVideoDistributionSvgElement("rect", {
          class: `short-video-insight-quadrant is-${quadrant.id}`,
          x,
          y,
          width: rectWidth,
          height: rectHeight
        }));
      quadrantLabels.push(shortVideoDistributionSvgElement("text", {
        class: `short-video-insight-quadrant-label is-${quadrant.id}`,
        x: x + 12,
        y: y + 20,
        text: `${summary.label || ""} · ${formatNumber(summary.count || 0)}`
      }));
    }

    for (const tick of [0, .25, .5, .75, 1]) {
      const x = mapX(tick);
      const y = mapY(tick);
      svg.append(
        shortVideoDistributionSvgElement("line", { class: "short-video-insight-grid", x1: x, y1: padding.top, x2: x, y2: height - padding.bottom }),
        shortVideoDistributionSvgElement("line", { class: "short-video-insight-grid", x1: padding.left, y1: y, x2: width - padding.right, y2: y }),
        shortVideoDistributionSvgElement("text", { class: "short-video-insight-axis-tick", x, y: height - padding.bottom + 22, "text-anchor": "middle", text: insightRatio(insightAxisRate(tick, collectAxisMax), 0) }),
        shortVideoDistributionSvgElement("text", { class: "short-video-insight-axis-tick", x: padding.left - 10, y: y + 4, "text-anchor": "end", text: insightRatio(insightAxisRate(tick, shareAxisMax), 0) })
      );
    }
    const maxCount = Math.max(1, ...cells.map((item) => Math.max(0, Number(item.count || 0))));
    for (const cell of cells) {
      const count = Math.max(0, Number(cell.count || 0));
      if (!count) continue;
      const x = (Math.max(0, Math.min(9, Number(cell.xBand || 0))) + .5) / 10;
      const y = (Math.max(0, Math.min(9, Number(cell.yBand || 0))) + .5) / 10;
      const density = Math.log1p(count) / Math.log1p(maxCount);
      const cellWidth = plotWidth / 10 * .82;
      const cellHeight = plotHeight / 10 * .76;
      const densityCell = shortVideoDistributionSvgElement("rect", {
        class: "short-video-insight-density-cell",
        x: mapX(x) - cellWidth / 2,
        y: mapY(y) - cellHeight / 2,
        width: cellWidth,
        height: cellHeight,
        rx: 5,
        "fill-opacity": 0.10 + density * 0.82
      });
      densityCell.append(shortVideoDistributionSvgElement("title", {
        text: `${formatNumber(count)} 条视频 · 平均藏/赞 ${insightRatio(cell.averageCollectRate)} · 平均转/赞 ${insightRatio(cell.averageShareRate)} · 评论倾向 ${insightPercent(cell.averageDiscussionScore)}`
      }));
      svg.append(densityCell);
    }
    svg.append(
      shortVideoDistributionSvgElement("line", { class: "short-video-insight-threshold", x1: mapX(xThreshold), y1: padding.top, x2: mapX(xThreshold), y2: height - padding.bottom }),
      shortVideoDistributionSvgElement("line", { class: "short-video-insight-threshold", x1: padding.left, y1: mapY(yThreshold), x2: width - padding.right, y2: mapY(yThreshold) }),
      ...quadrantLabels,
      shortVideoDistributionSvgElement("text", { class: "short-video-insight-axis-title", x: padding.left + plotWidth / 2, y: height - 12, "text-anchor": "middle", text: "藏 / 赞（对数轴）→" }),
      shortVideoDistributionSvgElement("text", { class: "short-video-insight-axis-title", x: 20, y: padding.top + plotHeight / 2, transform: `rotate(-90 20 ${padding.top + plotHeight / 2})`, "text-anchor": "middle", text: "转 / 赞（对数轴）→" })
    );
    chart.append(svg);

    const legend = document.createElement("div");
    legend.className = "short-video-insight-legend";
    legend.innerHTML = '<span><i class="is-sample"></i>颜色越深，样本越集中</span><span>坐标轴显示到 98 分位，极端值归入边缘格</span>';
    section.append(chart, legend);

    const quadrants = document.createElement("div");
    quadrants.className = "short-video-insight-quadrant-cards";
    for (const id of ["priority", "platform", "personal", "ordinary"]) {
      const item = insightQuadrantById(valueMap, id);
      const card = document.createElement("div");
      card.className = `is-${id}`;
      const title = document.createElement("strong");
      title.textContent = `${item.label || ""} ${formatNumber(item.count || 0)}`;
      const copy = document.createElement("span");
      copy.textContent = item.description || "";
      const action = document.createElement("small");
      action.textContent = valueMap.ratioComparableTotal
        ? `占互动结构样本 ${insightPercent(Number(item.count || 0) / Number(valueMap.ratioComparableTotal || 1), 1)}`
        : "暂无可比较样本";
      card.append(title, copy, action);
      quadrants.append(card);
    }
    section.append(quadrants);
    return section;
  }

  function renderInsightRankings(insights = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-insight-rankings";
    section.append(renderLikeDistributionSectionHeading(
      "哪些作者与题材持续产出强内容",
      "强内容指综合互动进入本地全库前 20%，不是偏好命中率。作者至少 8 条样本，题材至少 20 条样本，并同时显示中位点赞和主导互动类型。"
    ));
    const columns = document.createElement("div");
    columns.className = "short-video-insight-ranking-columns";
    const authorColumn = document.createElement("div");
    const authorTitle = document.createElement("h4");
    authorTitle.textContent = "作者样本表现";
    authorColumn.append(authorTitle);
    for (const item of Array.isArray(insights.authors) ? insights.authors : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-insight-ranking-row";
      const label = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = item.name || "未知作者";
      const meta = document.createElement("small");
      meta.textContent = `${formatNumber(item.sampleCount || 0)} 条样本 · 中位赞 ${formatNumber(Math.round(item.medianLikes || 0))} · ${item.dominantTypeLabel || "均衡型"}`;
      label.append(name, meta);
      const score = document.createElement("em");
      score.textContent = `前 20%：${formatNumber(item.globalTopCount || 0)} / ${formatNumber(item.sampleCount || 0)}`;
      button.append(label, score);
      button.addEventListener("click", () => openInsightAuthor(item));
      authorColumn.append(button);
    }
    const topicColumn = document.createElement("div");
    const topicTitle = document.createElement("h4");
    topicTitle.textContent = "题材样本表现";
    topicColumn.append(topicTitle);
    for (const item of Array.isArray(insights.topics) ? insights.topics : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-insight-ranking-row";
      const label = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = `#${item.label || item.key || "未命名题材"}`;
      const meta = document.createElement("small");
      meta.textContent = `${formatNumber(item.sampleCount || 0)} 条样本 · 中位赞 ${formatNumber(Math.round(item.medianLikes || 0))} · ${item.dominantTypeLabel || "均衡型"}`;
      label.append(name, meta);
      const score = document.createElement("em");
      score.textContent = `前 20%：${formatNumber(item.globalTopCount || 0)} / ${formatNumber(item.sampleCount || 0)}`;
      button.append(label, score);
      button.addEventListener("click", () => openInsightTopic(item));
      topicColumn.append(button);
    }
    columns.append(authorColumn, topicColumn);
    section.append(columns);
    return section;
  }

  function formatInsightBytes(value) {
    const bytes = Math.max(0, Number(value || 0));
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const scaled = bytes / (1024 ** index);
    return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : scaled >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function formatInsightDate(value) {
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) return "暂无";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function renderPersonalAuthorList(titleText, items, kind) {
    const column = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = titleText;
    column.append(title);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "short-video-personal-list-empty";
      empty.textContent = "暂时没有达到样本门槛的作者。";
      column.append(empty);
      return column;
    }
    for (const item of items) {
      const cleanable = kind === "low" && Boolean(String(item.secUid || "").trim());
      const button = document.createElement(cleanable || kind !== "topic" ? "div" : "button");
      if (button.tagName === "BUTTON") button.type = "button";
      button.className = "short-video-personal-list-row";
      button.classList.toggle("is-static", kind !== "topic" && !cleanable);
      button.classList.toggle("is-cleanable", cleanable);
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = item.name || "未知作者";
      const meta = document.createElement("small");
      meta.textContent = `${formatNumber(item.likedCount || 0)} 条点赞 / ${formatNumber(item.videoCount || 0)} 条入库 · ${formatInsightBytes(item.sizeBytes)}`;
      copy.append(name, meta);
      const score = document.createElement("em");
      score.textContent = insightPercent(item.hitRate, 1);
      score.title = kind === "high" ? "明确点赞作品占该作者本地作品的比例" : "低命中作者的本地存储占用";
      if (cleanable) {
        const primary = document.createElement("button");
        primary.type = "button";
        primary.className = "short-video-personal-list-main";
        primary.append(copy, score);
        primary.addEventListener("click", () => openInsightAuthor(item));
        const cleanup = document.createElement("button");
        cleanup.type = "button";
        cleanup.className = "short-video-personal-cleanup";
        cleanup.textContent = "清理";
        cleanup.title = "保留点赞视频，删除未点赞视频，并取消关注、移除监听";
        cleanup.addEventListener("click", () => authorCleanup.run(item, cleanup));
        button.append(primary, cleanup);
      } else {
        button.append(copy, score);
        button.addEventListener("click", () => openInsightAuthor(item));
      }
      column.append(button);
    }
    return column;
  }

  function renderAuthorEfficiency(personal = {}) {
    const efficiency = personal.authorEfficiency || {};
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-personal-authors";
    const heading = document.createElement("div");
    heading.className = "short-video-personal-authors-heading";
    heading.append(renderLikeDistributionSectionHeading(
      "作者投入—命中率",
      `明确点赞作品 / 同作者本地作品，至少 ${formatNumber(efficiency.minSamples || 20)} 条且同时有点赞与其他作品才参与排名；同时看文件占用，便于决定继续采集谁、减少采集谁。`
    ));
    const openTable = document.createElement("a");
    openTable.className = "short-video-author-efficiency-open";
    openTable.href = "/short-videos/stats/likes#authors";
    openTable.target = "_blank";
    openTable.rel = "noopener noreferrer";
    openTable.textContent = "查看占用 × 命中关系表";
    heading.append(openTable);
    section.append(heading);
    const summary = document.createElement("div");
    summary.className = "short-video-personal-summary";
    for (const [label, value, note] of [
      ["全库明确点赞", formatNumber(efficiency.likedVideos || 0), `命中率 ${insightPercent(efficiency.baselineHitRate, 1)}`],
      ["可比较作者", formatNumber(efficiency.eligibleAuthorTotal || 0), "同时有点赞与其他作品"],
      ["视频存储占用", formatInsightBytes(efficiency.sizeBytes), `${formatNumber(efficiency.totalVideos || 0)} 条本地视频`]
    ]) {
      const card = document.createElement("div");
      card.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${note}</small>`;
      summary.append(card);
    }
    const columns = document.createElement("div");
    columns.className = "short-video-personal-columns";
    columns.append(
      renderPersonalAuthorList("更值得继续采集", Array.isArray(efficiency.highHit) ? efficiency.highHit : [], "high"),
      renderPersonalAuthorList("低命中且占用较大", Array.isArray(efficiency.lowYield) ? efficiency.lowYield : [], "low")
    );
    section.append(summary, columns);
    return section;
  }

  function renderAuthorEfficiencyTable() {
    const panel = document.createElement("section");
    panel.className = "short-video-distribution-panel short-video-author-efficiency-panel";
    panel.setAttribute("aria-labelledby", "short-video-author-efficiency-title");
    const head = document.createElement("div");
    head.className = "short-video-distribution-head";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "short-video-author-efficiency-title";
    title.textContent = "作者占用与命中关系表";
    const description = document.createElement("span");
    description.textContent = "把本地视频占用和明确点赞命中率放在同一张表里；可筛选、排序、勾选对比，也可清理单个作者。";
    heading.append(title, description);
    const actions = document.createElement("div");
    actions.className = "short-video-distribution-head-actions";
    const cacheStatus = document.createElement("span");
    cacheStatus.className = "short-video-distribution-cache-status";
    cacheStatus.textContent = state.shortVideo.likeDistribution?.generatedAt
      ? `缓存生成 ${formatInsightDate(state.shortVideo.likeDistribution.generatedAt)}`
      : "默认读取缓存";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = state.shortVideo.likeDistributionLoading ? "重新统计中…" : "手动刷新";
    refresh.title = "清除当前统计缓存并重新计算";
    refresh.disabled = state.shortVideo.likeDistributionLoading;
    refresh.addEventListener("click", () => loadLikeDistribution({ force: true }).catch(showError));
    actions.append(cacheStatus, refresh);
    head.append(heading, actions);
    panel.append(head);

    const data = state.shortVideo.likeDistribution;
    if (state.shortVideo.likeDistributionLoading) panel.append(renderLikeDistributionLoadingStatus(Boolean(data)));
    if (state.shortVideo.likeDistributionError) {
      const error = document.createElement("div");
      error.className = "short-video-distribution-empty is-error";
      error.textContent = state.shortVideo.likeDistributionError;
      panel.append(error);
      return panel;
    }
    if (!data) {
      if (!state.shortVideo.likeDistributionLoading) {
        const empty = document.createElement("div");
        empty.className = "short-video-distribution-empty";
        empty.textContent = "暂无可显示的作者统计数据。";
        panel.append(empty);
      }
      return panel;
    }

    const efficiency = data.insights?.personal?.authorEfficiency || {};
    const allAuthors = Array.isArray(efficiency.authors) ? efficiency.authors : [];
    const lowYieldAuthors = Array.isArray(efficiency.lowYieldAuthors) ? efficiency.lowYieldAuthors : [];
    if (!allAuthors.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-distribution-empty";
      empty.textContent = "当前缓存还没有完整作者关系表，请点“手动刷新”生成。";
      panel.append(empty);
      return panel;
    }

    const controls = document.createElement("div");
    controls.className = "short-video-author-efficiency-controls";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索作者";
    search.setAttribute("aria-label", "搜索作者关系表");
    const scope = document.createElement("select");
    scope.setAttribute("aria-label", "作者范围");
    const scopeOptions = [
      ["low", `低命中且占用较大（${formatNumber(lowYieldAuthors.length)}）`],
      ["all", `全部达到样本门槛（${formatNumber(allAuthors.length)}）`]
    ];
    for (const [value, label] of scopeOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      scope.append(option);
    }
    const sort = document.createElement("select");
    sort.setAttribute("aria-label", "作者关系表排序");
    for (const [value, label] of [
      ["sizeDesc", "占用从大到小"],
      ["hitAsc", "命中从低到高"],
      ["hitDesc", "命中从高到低"],
      ["videosDesc", "入库从多到少"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    controls.append(search, scope, sort);

    const summary = document.createElement("div");
    summary.className = "short-video-personal-summary is-four short-video-author-efficiency-summary";
    const summaryCards = [
      ["当前作者", "0", "筛选后的作者数量"],
      ["合计占用", "0 B", "当前结果的本地视频"],
      ["加权命中率", "0.0%", "明确点赞 / 入库视频"],
      ["已选中", "0", "勾选行进行对比"]
    ].map(([label, value, note]) => {
      const card = document.createElement("div");
      const labelNode = document.createElement("span");
      labelNode.textContent = label;
      const valueNode = document.createElement("strong");
      valueNode.textContent = value;
      const noteNode = document.createElement("small");
      noteNode.textContent = note;
      card.append(labelNode, valueNode, noteNode);
      summary.append(card);
      return { value: valueNode, note: noteNode };
    });
    const selection = document.createElement("div");
    selection.className = "short-video-author-efficiency-selection";
    selection.setAttribute("role", "status");
    selection.setAttribute("aria-live", "polite");

    const tableWrap = document.createElement("div");
    tableWrap.className = "short-video-author-efficiency-table-wrap";
    const table = document.createElement("table");
    table.className = "short-video-author-efficiency-table";
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const label of ["选择", "作者", "入库", "明确点赞", "命中率", "本地占用", "平均每条", "操作"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headerRow.append(cell);
    }
    thead.append(headerRow);
    const tbody = document.createElement("tbody");
    table.append(thead, tbody);
    tableWrap.append(table);
    const selectedKeys = new Set();
    const authorKey = (item) => String(item.key || item.secUid || item.name || "");

    const updateSelectionSummary = () => {
      const selected = allAuthors.filter((item) => selectedKeys.has(authorKey(item)));
      const bytes = selected.reduce((total, item) => total + Math.max(0, Number(item.sizeBytes || 0)), 0);
      const videos = selected.reduce((total, item) => total + Math.max(0, Number(item.videoCount || 0)), 0);
      const likes = selected.reduce((total, item) => total + Math.max(0, Number(item.likedCount || 0)), 0);
      summaryCards[3].value.textContent = formatNumber(selected.length);
      summaryCards[3].note.textContent = selected.length
        ? `${formatInsightBytes(bytes)} · 命中 ${insightPercent(videos ? likes / videos : 0, 1)}`
        : "勾选行进行对比";
      selection.textContent = selected.length
        ? `已选 ${formatNumber(selected.length)} 位作者 · ${formatNumber(videos)} 条视频 · ${formatInsightBytes(bytes)}`
        : "可勾选多位作者汇总比较；作者名可进入对应作品页。";
    };

    const renderRows = () => {
      const query = search.value.trim().toLocaleLowerCase("zh-CN");
      const source = scope.value === "all" ? allAuthors : lowYieldAuthors;
      const rows = source.filter((item) => !query || String(item.name || "").toLocaleLowerCase("zh-CN").includes(query));
      rows.sort((left, right) => {
        if (sort.value === "hitAsc") return Number(left.hitRate || 0) - Number(right.hitRate || 0) || Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0);
        if (sort.value === "hitDesc") return Number(right.hitRate || 0) - Number(left.hitRate || 0) || Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0);
        if (sort.value === "videosDesc") return Number(right.videoCount || 0) - Number(left.videoCount || 0) || Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0);
        return Number(right.sizeBytes || 0) - Number(left.sizeBytes || 0) || Number(left.hitRate || 0) - Number(right.hitRate || 0);
      });
      tbody.replaceChildren();
      let totalBytes = 0;
      let totalVideos = 0;
      let totalLikes = 0;
      for (const item of rows) {
        const videoCount = Math.max(0, Number(item.videoCount || 0));
        const likedCount = Math.max(0, Number(item.likedCount || 0));
        const sizeBytes = Math.max(0, Number(item.sizeBytes || 0));
        totalBytes += sizeBytes;
        totalVideos += videoCount;
        totalLikes += likedCount;
        const row = document.createElement("tr");
        const selectCell = document.createElement("td");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selectedKeys.has(authorKey(item));
        checkbox.setAttribute("aria-label", `选择 ${item.name || "未知作者"}`);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedKeys.add(authorKey(item));
          else selectedKeys.delete(authorKey(item));
          row.classList.toggle("is-selected", checkbox.checked);
          updateSelectionSummary();
        });
        selectCell.append(checkbox);
        const authorCell = document.createElement("td");
        const author = document.createElement("button");
        author.type = "button";
        author.textContent = item.name || "未知作者";
        author.disabled = !String(item.secUid || "").trim();
        author.addEventListener("click", () => openInsightAuthor(item));
        authorCell.append(author);
        const videoCell = document.createElement("td");
        videoCell.textContent = formatNumber(videoCount);
        const likedCell = document.createElement("td");
        likedCell.textContent = formatNumber(likedCount);
        const hitCell = document.createElement("td");
        const hit = document.createElement("span");
        hit.className = "short-video-author-efficiency-meter";
        hit.style.setProperty("--value", `${Math.max(0, Math.min(100, Number(item.hitRate || 0) * 100))}%`);
        hit.textContent = insightPercent(item.hitRate, 1);
        hitCell.append(hit);
        const sizeCell = document.createElement("td");
        sizeCell.textContent = formatInsightBytes(sizeBytes);
        const averageCell = document.createElement("td");
        averageCell.textContent = formatInsightBytes(videoCount ? sizeBytes / videoCount : 0);
        const actionCell = document.createElement("td");
        const cleanup = document.createElement("button");
        cleanup.type = "button";
        cleanup.className = "short-video-personal-cleanup is-table";
        cleanup.textContent = "清理";
        cleanup.disabled = !String(item.secUid || "").trim();
        cleanup.title = "保留点赞视频，删除未点赞视频，并取消关注、移除监听";
        cleanup.addEventListener("click", () => authorCleanup.run(item, cleanup));
        actionCell.append(cleanup);
        row.classList.toggle("is-selected", checkbox.checked);
        row.append(selectCell, authorCell, videoCell, likedCell, hitCell, sizeCell, averageCell, actionCell);
        tbody.append(row);
      }
      summaryCards[0].value.textContent = formatNumber(rows.length);
      summaryCards[0].note.textContent = scope.value === "all" ? "达到样本门槛" : "低命中筛选结果";
      summaryCards[1].value.textContent = formatInsightBytes(totalBytes);
      summaryCards[2].value.textContent = insightPercent(totalVideos ? totalLikes / totalVideos : 0, 1);
      summaryCards[2].note.textContent = `${formatNumber(totalLikes)} / ${formatNumber(totalVideos)} 条`;
      updateSelectionSummary();
    };
    search.addEventListener("input", renderRows);
    scope.addEventListener("change", renderRows);
    sort.addEventListener("change", renderRows);
    renderRows();
    panel.append(controls, summary, selection, tableWrap);
    return panel;
  }

  function renderPreferenceComparison(comparison = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-personal-comparison";
    section.append(renderLikeDistributionSectionHeading(
      "你的点赞作品有什么不同",
      `只在同时拥有“点赞作品”和“其他作品”的 ${formatNumber(comparison.comparableAuthorTotal || 0)} 位作者内部比较，减少作者差异；这是观察到的关联，不是因果结论。`
    ));
    const table = document.createElement("div");
    table.className = "short-video-personal-comparison-table";
    const liked = comparison.liked || {};
    const other = comparison.other || {};
    const rows = [
      ["样本", formatNumber(liked.sampleCount || 0), formatNumber(other.sampleCount || 0)],
      ["中位点赞", formatNumber(Math.round(liked.medianLikes || 0)), formatNumber(Math.round(other.medianLikes || 0))],
      ["中位藏 / 赞", insightRatio(liked.medianCollectRate), insightRatio(other.medianCollectRate)],
      ["中位转 / 赞", insightRatio(liked.medianShareRate), insightRatio(other.medianShareRate)],
      ["中位评 / 赞", insightRatio(liked.medianCommentRate), insightRatio(other.medianCommentRate)]
    ];
    for (const [metric, likedValue, otherValue] of [["指标", "你的点赞作品", "同作者其他作品"], ...rows]) {
      const row = document.createElement("div");
      row.append(...[metric, likedValue, otherValue].map((value, index) => {
        const cell = document.createElement(index === 0 ? "strong" : "span");
        cell.textContent = value;
        return cell;
      }));
      table.append(row);
    }
    section.append(table);
    return section;
  }

  function renderPreferenceSignalColumn(titleText, items, kind) {
    const column = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = titleText;
    column.append(title);
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "short-video-personal-list-empty";
      empty.textContent = "还没有超过全库基线且样本足够的信号。";
      column.append(empty);
      return column;
    }
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-personal-list-row";
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = kind === "topic" ? `#${item.label || item.key || "未命名题材"}` : item.label || "未命名原声";
      const meta = document.createElement("small");
      meta.textContent = `${formatNumber(item.likedCount || 0)} / ${formatNumber(item.sampleCount || 0)} 条明确点赞 · 命中 ${insightPercent(item.hitRate, 1)}`;
      copy.append(name, meta);
      const score = document.createElement("em");
      score.textContent = `${Number(item.lift || 0).toFixed(1)}×`;
      score.title = "相对全库明确点赞命中率";
      button.append(copy, score);
      if (kind === "topic") button.addEventListener("click", () => openInsightTopic(item));
      column.append(button);
    }
    return column;
  }

  function renderPreferenceSignals(signals = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-personal-signals";
    section.append(renderLikeDistributionSectionHeading(
      "可复用的个人偏好信号",
      `这里的倍数是题材或原声命中率相对全库 ${insightPercent(signals.baselineHitRate, 1)} 基线的提升，已设置最小样本门槛；仅代表当前入库样本并受采集范围影响，题材可点击回到对应内容。`
    ));
    const columns = document.createElement("div");
    columns.className = "short-video-personal-columns";
    columns.append(
      renderPreferenceSignalColumn("题材偏好", Array.isArray(signals.topics) ? signals.topics : [], "topic"),
      renderPreferenceSignalColumn("原声偏好", Array.isArray(signals.sounds) ? signals.sounds : [], "sound")
    );
    section.append(columns);
    return section;
  }

  function renderWatchInsights(watch = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-watch-insights";
    section.append(renderLikeDistributionSectionHeading(
      "实际观看行为",
      `观看记录从 ${formatInsightDate(watch.firstWatchedAt)} 开始积累；“看完”表示至少完成过一次，不是重复播放次数。`
    ));
    const cards = document.createElement("div");
    cards.className = "short-video-personal-summary is-four";
    for (const [label, value, note] of [
      ["看过", formatNumber(watch.watchedTotal || 0), `覆盖本地库 ${insightPercent(watch.coverageRate, 1)}`],
      ["至少看完一次", formatNumber(watch.completedTotal || 0), `看过样本中 ${insightPercent(watch.completionRate, 1)}`],
      ["平均最后进度", insightPercent(watch.averageProgressRate, 1), "按视频时长归一化"],
      ["最近观看", formatInsightDate(watch.lastWatchedAt), "数据仍在持续积累"]
    ]) {
      const card = document.createElement("div");
      card.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${note}</small>`;
      cards.append(card);
    }
    const duration = document.createElement("div");
    duration.className = "short-video-watch-duration";
    for (const band of Array.isArray(watch.durationBands) ? watch.durationBands : []) {
      const row = document.createElement("div");
      const label = document.createElement("span");
      label.textContent = band.label || "未知时长";
      const track = document.createElement("i");
      const fill = document.createElement("b");
      fill.style.width = `${Math.max(0, Math.min(100, Number(band.completionRate || 0) * 100)).toFixed(1)}%`;
      track.append(fill);
      const value = document.createElement("strong");
      value.textContent = `${insightPercent(band.completionRate, 1)} · ${formatNumber(band.watched || 0)} 条`;
      row.append(label, track, value);
      duration.append(row);
    }
    section.append(cards, duration);
    return section;
  }

  function renderDataHealth(health = {}) {
    const section = document.createElement("section");
    section.className = "short-video-insight-section short-video-data-health";
    section.append(renderLikeDistributionSectionHeading(
      "数据健康与高清审计",
      "质量字段仍用于播放、筛选、转码和审计，但不再混入点赞密度表；这里集中显示真实覆盖率和需要处理的缺口。"
    ));
    const grid = document.createElement("div");
    grid.className = "short-video-health-grid";
    for (const [label, known, total, coverage, note] of [
      ["点赞数据", health.likesKnown, health.total, health.likesCoverageRate, `${formatNumber(health.likesUnknown || 0)} 条未知`],
      ["播放量", health.playKnown, health.total, health.playCoverageRate, Number(health.playKnown || 0) ? "可逐步做曝光转化" : "当前无法计算官方互动率"],
      ["实际画质", health.qualityKnown, health.total, health.qualityCoverageRate, `${formatNumber(health.probeErrors || 0)} 条探测错误`],
      ["题材标签", health.topicKnown, health.total, health.topicCoverageRate, "用于偏好与检索"],
      ["原声信息", health.soundKnown, health.total, health.soundCoverageRate, "用于原声偏好"],
      ["观看记录", health.watchKnown, health.total, health.watchCoverageRate, "本地行为数据仍在积累"]
    ]) {
      const card = document.createElement("div");
      const head = document.createElement("span");
      head.textContent = label;
      const value = document.createElement("strong");
      value.textContent = insightPercent(coverage, 1);
      const detail = document.createElement("small");
      detail.textContent = `${formatNumber(known || 0)} / ${formatNumber(total || 0)} · ${note}`;
      const track = document.createElement("i");
      const fill = document.createElement("b");
      fill.style.width = `${Math.max(0, Math.min(100, Number(coverage || 0) * 100)).toFixed(1)}%`;
      track.append(fill);
      card.append(head, value, detail, track);
      grid.append(card);
    }
    section.append(grid);
    const audit = health.qualityAudit || {};
    const auditPanel = document.createElement("div");
    auditPanel.className = "short-video-quality-audit-health";
    if (!audit.available) {
      auditPanel.innerHTML = "<strong>高清审计记录暂不可用</strong><span>下载管理器尚无可读审计表；实际画质覆盖仍以上方文件探测结果为准。</span>";
    } else {
      const failures = Number(audit.verificationFailed || 0) + Number(audit.probeFailed || 0) + Number(audit.failedQueue || 0);
      const title = document.createElement("strong");
      title.textContent = `最近高清审计 · ${formatInsightDate(audit.generatedAt)}`;
      const stats = document.createElement("div");
      for (const [label, value, tone] of [
        ["审计样本", audit.auditedTotal, ""],
        ["已达最高 / 无需更新", Number(audit.alreadyHighest || 0) + Number(audit.upToDate || 0), "is-good"],
        ["高清重下校验通过", audit.upgradePassed, "is-good"],
        ["源不可用", audit.sourceUnavailable, "is-warning"],
        ["失败或探测异常", failures, failures ? "is-danger" : "is-good"],
        ["当前库较审计多", audit.catalogDeltaFromAudit, Number(audit.catalogDeltaFromAudit || 0) ? "is-warning" : ""]
      ]) {
        const item = document.createElement("span");
        if (tone) item.className = tone;
        item.innerHTML = `<small>${label}</small><b>${formatNumber(value || 0)}</b>`;
        stats.append(item);
      }
      const note = document.createElement("p");
      note.textContent = Number(audit.catalogDeltaFromAudit || 0) > 0
        ? `当前库比最近审计样本多 ${formatNumber(audit.catalogDeltaFromAudit)} 条，可能来自审计后入库或审计范围差异；需要时应按当前文件重跑审计。`
        : "审计结果已覆盖当前下载样本，不需要再按点赞区间重复标注审计状态。";
      auditPanel.append(title, stats, note);
    }
    section.append(auditPanel);
    return section;
  }

  function renderLikeDistributionDetailTable(bins, densities, maxLogDensity, knownTotal) {
    const detailSection = document.createElement("section");
    detailSection.className = "short-video-distribution-section is-detail";
    detailSection.append(renderLikeDistributionSectionHeading(
      "详细分档（本地样本密度）",
      "0-1 万每 1 千一组，1-10 万每 1 万一组，10-100 万每 10 万一组，100-500 万每 100 万一组，区间按左闭右开统计；单位密度仅用于比较不同宽度的分档。"
    ));
    const tableWrap = document.createElement("div");
    tableWrap.className = "short-video-distribution-table-wrap";
    const table = document.createElement("table");
    table.className = "short-video-distribution-table";
    table.innerHTML = "<thead><tr><th>点赞区间</th><th>视频数量</th><th>占已知样本</th><th>单位密度<span>每千赞 · 对数柱</span></th></tr></thead>";
    const body = document.createElement("tbody");
    const rows = document.createDocumentFragment();
    for (const [index, item] of bins.entries()) {
      const count = Math.max(0, Number(item.videoCount || 0));
      const density = densities[index];
      const row = document.createElement("tr");
      const minLikes = Number(item.minLikes || 0);
      if ([10000, 100000, 1000000].includes(minLikes)) row.classList.add("is-scale-start");
      const label = document.createElement("td");
      label.textContent = item.label || "";
      const amount = document.createElement("td");
      amount.textContent = formatNumber(count);
      const share = document.createElement("td");
      share.textContent = knownTotal > 0 ? `${(count / knownTotal * 100).toFixed(2)}%` : "0.00%";
      const relation = document.createElement("td");
      const densityLayout = document.createElement("div");
      densityLayout.className = "short-video-distribution-density";
      const densityValue = document.createElement("span");
      densityValue.className = "short-video-distribution-density-value";
      densityValue.classList.toggle("is-unavailable", !Number.isFinite(density));
      densityValue.textContent = Number.isFinite(density)
        ? `${formatLikeDistributionDensity(density)} 条`
        : "开放区间";
      densityValue.title = Number.isFinite(density)
        ? `每 1,000 个点赞跨度平均 ${formatLikeDistributionDensity(density)} 条视频`
        : "该区间没有封闭上限，不参与单位密度比较";
      const track = document.createElement("span");
      track.className = "short-video-distribution-bar";
      track.classList.toggle("is-unavailable", !Number.isFinite(density));
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      const densityWidth = Number.isFinite(density) && density > 0
        ? Math.log1p(density) / maxLogDensity * 100
        : 0;
      fill.style.width = `${Math.max(densityWidth ? 1.5 : 0, densityWidth).toFixed(2)}%`;
      track.append(fill);
      densityLayout.append(densityValue, track);
      relation.append(densityLayout);
      row.append(label, amount, share, relation);
      rows.append(row);
    }
    body.append(rows);
    table.append(body);
    tableWrap.append(table);
    detailSection.append(tableWrap);
    return detailSection;
  }

  function renderLikeDistributionPanel() {
    const panel = document.createElement("section");
    panel.className = "short-video-distribution-panel";
    panel.setAttribute("aria-labelledby", "short-video-like-distribution-title");
    const head = document.createElement("div");
    head.className = "short-video-distribution-head";
    const heading = document.createElement("div");
    const title = document.createElement("h2");
    title.id = "short-video-like-distribution-title";
    title.textContent = "从下载库看清个人偏好与数据质量";
    const description = document.createElement("span");
    description.textContent = "只统计本地已下载视频：明确点赞用于衡量个人命中，观看记录用于衡量实际使用，公开互动用于理解内容结构；三种口径分开呈现。";
    heading.append(title, description);
    const actions = document.createElement("div");
    actions.className = "short-video-distribution-head-actions";
    const cacheStatus = document.createElement("span");
    cacheStatus.className = "short-video-distribution-cache-status";
    cacheStatus.textContent = state.shortVideo.likeDistribution?.generatedAt
      ? `缓存生成 ${formatInsightDate(state.shortVideo.likeDistribution.generatedAt)}`
      : "默认读取缓存";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = state.shortVideo.likeDistributionLoading ? "重新统计中…" : "手动刷新";
    refresh.title = "清除当前统计缓存并重新计算";
    refresh.disabled = state.shortVideo.likeDistributionLoading;
    refresh.addEventListener("click", () => loadLikeDistribution({ force: true }).catch(showError));
    actions.append(cacheStatus, refresh);
    head.append(heading, actions);
    panel.append(head);

    const data = state.shortVideo.likeDistribution;
    if (state.shortVideo.likeDistributionLoading) {
      panel.append(renderLikeDistributionLoadingStatus(Boolean(data)));
    }
    if (state.shortVideo.likeDistributionError) {
      const error = document.createElement("div");
      error.className = "short-video-distribution-empty is-error";
      error.textContent = state.shortVideo.likeDistributionError;
      panel.append(error);
      return panel;
    }
    if (!data) {
      if (!state.shortVideo.likeDistributionLoading) {
        const empty = document.createElement("div");
        empty.className = "short-video-distribution-empty";
        empty.textContent = "暂无可显示的统计数据。";
        panel.append(empty);
      }
      return panel;
    }

    const insights = data.insights || {};
    const personal = insights.personal || {};
    const valueMap = insights.valueMap || {};
    const eligibleTotal = Math.max(0, Number(valueMap.eligibleTotal || 0));
    const comparableTotal = Math.max(0, Number(valueMap.ratioComparableTotal || 0));
    const saveType = insightTypeById(valueMap, "save");
    const shareType = insightTypeById(valueMap, "share");
    const discussType = insightTypeById(valueMap, "discuss");
    const cards = document.createElement("div");
    cards.className = "short-video-distribution-cards";
    for (const [label, value, note] of [
      ["互动结构样本", comparableTotal, `${formatNumber(eligibleTotal)} 条已知互动视频`],
      ["收藏型", saveType.count, `全库中位藏/赞 ${insightRatio(valueMap.medianCollectRate)}`],
      ["传播型", shareType.count, `全库中位转/赞 ${insightRatio(valueMap.medianShareRate)}`],
      ["讨论型", discussType.count, `全库中位评/赞 ${insightRatio(valueMap.medianCommentRate)}`]
    ]) {
      const card = document.createElement("div");
      const name = document.createElement("span");
      name.textContent = label;
      const count = document.createElement("strong");
      count.textContent = typeof value === "string" ? value : formatNumber(value || 0);
      const hint = document.createElement("small");
      hint.textContent = note;
      card.append(name, count, hint);
      cards.append(card);
    }
    panel.append(
      renderAuthorEfficiency(personal),
      renderPreferenceComparison(personal.preferenceComparison),
      renderPreferenceSignals(personal.preferenceSignals),
      renderWatchInsights(personal.watch),
      renderDataHealth(insights.health)
    );

    const platformOverview = document.createElement("section");
    platformOverview.className = "short-video-insight-section short-video-platform-overview";
    platformOverview.append(renderLikeDistributionSectionHeading(
      "平台公开互动结构",
      "下面只解释已下载样本在抖音公开累计赞、评、藏、转上的结构，不把它误当作你的观看偏好或平台总体分布。"
    ), cards);
    panel.append(
      platformOverview,
      renderContentValueMap(valueMap),
      renderInsightRankings(insights)
    );
    const method = document.createElement("aside");
    method.className = "short-video-insight-method";
    const methodTitle = document.createElement("strong");
    methodTitle.textContent = "怎么算：";
    const platformMethod = document.createElement("span");
    platformMethod.textContent = insights.method?.platform || "平台分基于相对互动表现";
    const structureMethod = document.createElement("span");
    structureMethod.textContent = insights.method?.structure || "互动结构按相近点赞量级比较";
    const rankingMethod = document.createElement("span");
    rankingMethod.textContent = insights.method?.ranking || "作者与题材只在本地样本内比较";
    const limitation = document.createElement("em");
    limitation.textContent = insights.method?.limitation || "";
    method.append(methodTitle, platformMethod, structureMethod, rankingMethod, limitation);
    panel.append(method);

    const bins = Array.isArray(data.bins) ? data.bins : [];
    const densities = bins.map(likeDistributionDensityPerThousand);
    const maxDensity = Math.max(1, ...densities.filter(Number.isFinite));
    const maxLogDensity = Math.log1p(maxDensity);
    const knownTotal = Math.max(0, Number(data.knownLikesTotal || 0));
    const legacy = document.createElement("details");
    legacy.className = "short-video-distribution-legacy";
    const legacySummary = document.createElement("summary");
    legacySummary.textContent = "查看样本结构与点赞分布（研究用）";
    const legacyBody = document.createElement("div");
    legacyBody.setAttribute("aria-busy", "true");
    const pending = document.createElement("div");
    pending.className = "short-video-distribution-empty";
    pending.textContent = "展开后生成研究图表…";
    legacyBody.append(pending);
    let chartBuilt = false;
    let detailBuilt = false;
    let chartBuildFrame = 0;
    let detailBuildFrame = 0;
    const scheduleLegacyBuild = () => {
      if (!legacy.open || !legacy.isConnected) return;
      if (!chartBuilt) {
        if (chartBuildFrame) return;
        chartBuildFrame = window.requestAnimationFrame(() => {
          chartBuildFrame = 0;
          if (!legacy.open || !legacy.isConnected) return;
          chartBuilt = true;
          legacyBody.replaceChildren(renderLikeDistributionLogChart(bins));
          scheduleLegacyBuild();
        });
        return;
      }
      if (detailBuilt || detailBuildFrame) return;
      detailBuildFrame = window.requestAnimationFrame(() => {
        detailBuildFrame = 0;
        if (!legacy.open || !legacy.isConnected) return;
        detailBuilt = true;
        legacyBody.append(renderLikeDistributionDetailTable(bins, densities, maxLogDensity, knownTotal));
        legacyBody.setAttribute("aria-busy", "false");
      });
    };
    legacy.addEventListener("toggle", scheduleLegacyBuild);
    legacy.append(legacySummary, legacyBody);
    panel.append(legacy);
    return panel;
  }


  return { renderAuthorEfficiencyTable, renderLikeDistributionPanel };
}
