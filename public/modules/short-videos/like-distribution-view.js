export function createLikeDistributionView(deps) {
  const {
    formatNumber,
    loadLikeDistribution,
    openInsightAuthor,
    openInsightTopic,
    showError,
    state
  } = deps;

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

    const auditStart = mapX(Math.log10(200000));
    const auditEnd = mapX(Math.log10(1000000));
    svg.append(shortVideoDistributionSvgElement("rect", {
      class: "short-video-distribution-log-audit-band",
      x: auditStart,
      y: padding.top,
      width: Math.max(0, auditEnd - auditStart),
      height: plotHeight
    }));

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
      shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-axis-title", x: 18, y: padding.top + plotHeight / 2, transform: `rotate(-90 18 ${padding.top + plotHeight / 2})`, "text-anchor": "middle", text: "每千赞视频密度（log10）" }),
      shortVideoDistributionSvgElement("text", { class: "short-video-distribution-log-band-label", x: (auditStart + auditEnd) / 2, y: padding.top + 16, "text-anchor": "middle", text: "20-100万已回测" })
    );
    chart.append(svg);
    const legend = document.createElement("div");
    legend.className = "short-video-distribution-log-legend";
    legend.innerHTML = '<span><i class="is-line"></i>本地兴趣样本密度</span><span><i class="is-band"></i>50-100万关注区间</span>';
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
    table.innerHTML = "<thead><tr><th>点赞区间</th><th>视频数量</th><th>占已知点赞</th><th>当前 4K</th><th>单位密度<span>每千赞 · 对数柱</span></th></tr></thead>";
    const body = document.createElement("tbody");
    const rows = document.createDocumentFragment();
    for (const [index, item] of bins.entries()) {
      const count = Math.max(0, Number(item.videoCount || 0));
      const density = densities[index];
      const row = document.createElement("tr");
      const minLikes = Number(item.minLikes || 0);
      const maxLikes = Number(item.maxLikes || 0);
      if ([10000, 100000, 1000000].includes(minLikes)) row.classList.add("is-scale-start");
      if (item.maxLikes != null && minLikes >= 200000 && maxLikes <= 1000000) row.classList.add("is-current-audit");
      const label = document.createElement("td");
      label.textContent = item.label || "";
      if (row.classList.contains("is-current-audit")) {
        const tag = document.createElement("span");
        tag.className = "short-video-distribution-tag";
        tag.textContent = "已回测";
        label.append(tag);
      }
      const amount = document.createElement("td");
      amount.textContent = formatNumber(count);
      const share = document.createElement("td");
      share.textContent = knownTotal > 0 ? `${(count / knownTotal * 100).toFixed(2)}%` : "0.00%";
      const fourK = document.createElement("td");
      fourK.textContent = formatNumber(item.fourKCount || 0);
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
      row.append(label, amount, share, fourK, relation);
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
    title.textContent = "看清内容为什么被收藏、传播或讨论";
    const description = document.createElement("span");
    description.textContent = "只统计本地已下载视频，并把下载库当作抖音大空间中的兴趣样本；不再用已下载、已点赞反推偏好命中，先看互动结构，再决定补高清、回看作者或打开题材。";
    heading.append(title, description);
    const actions = document.createElement("div");
    actions.className = "short-video-distribution-head-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = state.shortVideo.likeDistributionLoading ? "统计中…" : "刷新";
    refresh.disabled = state.shortVideo.likeDistributionLoading;
    refresh.addEventListener("click", () => loadLikeDistribution().catch(showError));
    actions.append(refresh);
    head.append(heading, actions);
    panel.append(head);

    const data = state.shortVideo.likeDistribution;
    if (state.shortVideo.likeDistributionError) {
      const error = document.createElement("div");
      error.className = "short-video-distribution-empty is-error";
      error.textContent = state.shortVideo.likeDistributionError;
      panel.append(error);
      return panel;
    }
    if (!data) {
      const loading = document.createElement("div");
      loading.className = "short-video-distribution-empty";
      loading.textContent = "正在统计本地视频…";
      panel.append(loading);
      return panel;
    }

    const insights = data.insights || {};
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
    panel.append(cards);

    panel.append(
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


  return { renderLikeDistributionPanel };
}
