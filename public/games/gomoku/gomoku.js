(() => {
  "use strict";

  const SIZE = 15;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const STORAGE_KEY = "fanhao.gomoku.settings.v1";
  const DIFFICULTIES = {
    casual: { strength: 35, time: 500 },
    strong: { strength: 75, time: 1500 },
    master: { strength: 100, time: 4000 }
  };

  const els = {
    board: document.querySelector("#board"),
    boardWrap: document.querySelector("#boardWrap"),
    engineBadge: document.querySelector("#engineBadge"),
    loadingPanel: document.querySelector("#loadingPanel"),
    loadingTitle: document.querySelector("#loadingTitle"),
    loadingDetail: document.querySelector("#loadingDetail"),
    loadingProgress: document.querySelector("#loadingProgress"),
    turnPill: document.querySelector("#turnPill"),
    turnText: document.querySelector("#turnText"),
    statusStone: document.querySelector("#statusStone"),
    statusTitle: document.querySelector("#statusTitle"),
    statusDetail: document.querySelector("#statusDetail"),
    sideSelector: document.querySelector("#sideSelector"),
    difficulty: document.querySelector("#difficulty"),
    undoButton: document.querySelector("#undoButton"),
    newGameButton: document.querySelector("#newGameButton"),
    thinkingIndicator: document.querySelector("#thinkingIndicator"),
    depthValue: document.querySelector("#depthValue"),
    evalValue: document.querySelector("#evalValue"),
    nodesValue: document.querySelector("#nodesValue"),
    speedValue: document.querySelector("#speedValue"),
    bestlineValue: document.querySelector("#bestlineValue")
  };

  const ctx = els.board.getContext("2d");
  let board = new Int8Array(SIZE * SIZE);
  let history = [];
  let humanSide = BLACK;
  let difficulty = "strong";
  let winner = EMPTY;
  let winLine = null;
  let hover = null;
  let engineWorker = null;
  let engineReady = false;
  let engineThinking = false;
  let engineFailed = false;
  let canvasSize = 0;
  let geometry = null;

  loadSettings();
  bindEvents();
  resizeBoard();
  startEngine();
  updateUi();

  function bindEvents() {
    const resizeObserver = new ResizeObserver(resizeBoard);
    resizeObserver.observe(els.boardWrap);

    els.board.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      hover = pointFromEvent(event);
      drawBoard();
    });
    els.board.addEventListener("pointerleave", () => {
      hover = null;
      drawBoard();
    });
    els.board.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (!canHumanMove()) return;
      const point = pointFromEvent(event);
      if (!point || board[toIndex(point.x, point.y)] !== EMPTY) return;
      if (placeMove(point.x, point.y, humanSide)) {
        hover = null;
        if (!winner) setTimeout(requestAiMove, 90);
      }
    });

    els.sideSelector.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement) || !event.target.checked) return;
      humanSide = Number(event.target.value) === WHITE ? WHITE : BLACK;
      saveSettings();
      resetGame();
    });
    els.difficulty.addEventListener("change", () => {
      difficulty = DIFFICULTIES[els.difficulty.value] ? els.difficulty.value : "strong";
      saveSettings();
      updateStatus();
    });
    els.undoButton.addEventListener("click", undoLastRound);
    els.newGameButton.addEventListener("click", resetGame);
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      humanSide = Number(saved.humanSide) === WHITE ? WHITE : BLACK;
      difficulty = DIFFICULTIES[saved.difficulty] ? saved.difficulty : "strong";
    } catch {
      humanSide = BLACK;
      difficulty = "strong";
    }
    const sideInput = els.sideSelector.querySelector(`input[value="${humanSide}"]`);
    if (sideInput) sideInput.checked = true;
    els.difficulty.value = difficulty;
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ humanSide, difficulty }));
  }

  function startEngine() {
    if (engineWorker) engineWorker.terminate();
    engineReady = false;
    engineThinking = false;
    engineFailed = false;
    showLoading("正在加载 Rapfi 引擎", "首次载入约 40 MB NNUE 模型，之后由浏览器缓存", 0);

    const worker = new Worker("./engine-worker.js?v=20260718-rapfi-01");
    engineWorker = worker;
    worker.addEventListener("message", (event) => {
      if (engineWorker !== worker) return;
      handleWorkerMessage(event.data || {});
    });
    worker.addEventListener("error", (event) => {
      if (engineWorker !== worker) return;
      failEngine(event.message || "AI Worker 启动失败");
    });
    worker.postMessage({ type: "init" });
    updateUi();
  }

  function handleWorkerMessage(message) {
    if (message.type === "status") {
      updateLoadingStatus(String(message.status || ""));
      return;
    }
    if (message.type === "ready") {
      engineReady = true;
      engineFailed = false;
      els.loadingPanel.classList.add("hidden");
      els.engineBadge.className = "engine-badge";
      els.engineBadge.textContent = "Rapfi 已就绪";
      updateUi();
      if (currentSide() === aiSide() && !winner) setTimeout(requestAiMove, 120);
      return;
    }
    if (message.type === "stdout") {
      parseEngineOutput(String(message.line || "").trim());
      return;
    }
    if (message.type === "stderr") {
      console.error("[Rapfi]", message.line);
      return;
    }
    if (message.type === "error") {
      failEngine(message.message || "Rapfi 初始化失败");
      return;
    }
    if (message.type === "exit" && engineThinking) {
      failEngine(`Rapfi 已退出（代码 ${message.code ?? "?"}）`);
    }
  }

  function updateLoadingStatus(status) {
    if (!status) return;
    const match = status.match(/\((\d+)\/(\d+)\)/);
    if (match) {
      const loaded = Number(match[1]);
      const total = Number(match[2]);
      const progress = total > 0 ? loaded / total : 0;
      showLoading(
        "正在加载 NNUE 模型",
        `${formatBytes(loaded)} / ${formatBytes(total)}`,
        progress
      );
      return;
    }
    if (/running/i.test(status)) showLoading("正在启动 Rapfi", "模型已载入，正在初始化搜索引擎", 1);
  }

  function showLoading(title, detail, progress) {
    els.loadingPanel.classList.remove("hidden");
    els.loadingTitle.textContent = title;
    els.loadingDetail.textContent = detail;
    els.loadingProgress.style.width = `${Math.max(0, Math.min(1, progress || 0)) * 100}%`;
    els.engineBadge.className = "engine-badge loading";
    els.engineBadge.textContent = "引擎加载中";
  }

  function failEngine(message) {
    engineReady = false;
    engineThinking = false;
    engineFailed = true;
    els.engineBadge.className = "engine-badge error";
    els.engineBadge.textContent = "引擎加载失败";
    showLoading("Rapfi 加载失败", `${message}。请刷新页面重试。`, 0);
    els.engineBadge.className = "engine-badge error";
    els.engineBadge.textContent = "引擎加载失败";
    updateUi();
  }

  function sendCommand(command) {
    if (!engineReady || !engineWorker) return;
    engineWorker.postMessage({ type: "command", command });
  }

  function requestAiMove() {
    if (!engineReady || engineThinking || winner || currentSide() !== aiSide()) return;
    const level = DIFFICULTIES[difficulty];
    engineThinking = true;
    clearAnalysis();
    els.thinkingIndicator.className = "thinking-indicator active";
    els.thinkingIndicator.textContent = "AI 思考中";
    updateUi();

    sendCommand("RELOADCONFIG config.toml");
    sendCommand("INFO HASH_SIZE 65536");
    sendCommand("INFO RULE 0");
    sendCommand("INFO THREAD_NUM 1");
    sendCommand("INFO CAUTION_FACTOR 3");
    sendCommand(`INFO STRENGTH ${level.strength}`);
    sendCommand(`INFO TIMEOUT_TURN ${level.time}`);
    sendCommand("INFO TIMEOUT_MATCH 9999000");
    sendCommand("INFO MAX_DEPTH 100");
    sendCommand("INFO MAX_NODE 0");
    sendCommand("INFO SHOW_DETAIL 3");
    sendCommand("INFO PONDERING 0");
    sendCommand("INFO SWAPABLE 0");
    sendCommand(`START ${SIZE}`);
    sendCommand("INFO TIME_LEFT 9999000");

    let boardCommand = "YXBOARD";
    for (const move of history) boardCommand += ` ${move.x},${move.y},${move.side}`;
    boardCommand += " DONE";
    sendCommand(boardCommand);
    sendCommand("YXNBEST 1");
  }

  function parseEngineOutput(line) {
    if (!line || line === "OK") return;

    const moveMatch = line.match(/^(\d+),(\d+)$/);
    if (moveMatch && engineThinking) {
      const x = Number(moveMatch[1]);
      const y = Number(moveMatch[2]);
      engineThinking = false;
      els.thinkingIndicator.className = "thinking-indicator";
      els.thinkingIndicator.textContent = "计算完成";
      if (!insideBoard(x, y) || board[toIndex(x, y)] !== EMPTY || currentSide() !== aiSide()) {
        failEngine(`AI 返回了无效落点 ${x},${y}`);
        return;
      }
      placeMove(x, y, aiSide());
      return;
    }

    const infoMatch = line.match(/^INFO\s+([A-Z]+)\s+(.+)$/);
    if (infoMatch) {
      const key = infoMatch[1];
      const value = infoMatch[2];
      if (key === "DEPTH") els.depthValue.textContent = value;
      else if (key === "EVAL") els.evalValue.textContent = value;
      else if (key === "WINRATE") els.evalValue.textContent = `${(Number(value) * 100).toFixed(1)}%`;
      else if (key === "TOTALNODES" || key === "NODES") els.nodesValue.textContent = compactNumber(value);
      else if (key === "SPEED") els.speedValue.textContent = `${compactNumber(value)}/s`;
      else if (key === "BESTLINE") els.bestlineValue.textContent = formatBestline(value);
      return;
    }

    if (line.startsWith("ERROR ")) {
      engineThinking = false;
      els.thinkingIndicator.className = "thinking-indicator";
      els.thinkingIndicator.textContent = "计算异常";
      els.statusTitle.textContent = "AI 计算失败";
      els.statusDetail.textContent = line.slice(6);
      updateControls();
    }
  }

  function placeMove(x, y, side) {
    if (winner || side !== currentSide() || board[toIndex(x, y)] !== EMPTY) return false;
    board[toIndex(x, y)] = side;
    history.push({ x, y, side });
    const result = findWinningLine(x, y, side);
    if (result) {
      winner = side;
      winLine = result;
    } else if (history.length === SIZE * SIZE) {
      winner = -1;
    }
    updateUi();
    return true;
  }

  function findWinningLine(x, y, side) {
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (const [dx, dy] of directions) {
      let startX = x;
      let startY = y;
      let endX = x;
      let endY = y;
      let count = 1;
      while (insideBoard(startX - dx, startY - dy) && board[toIndex(startX - dx, startY - dy)] === side) {
        startX -= dx;
        startY -= dy;
        count += 1;
      }
      while (insideBoard(endX + dx, endY + dy) && board[toIndex(endX + dx, endY + dy)] === side) {
        endX += dx;
        endY += dy;
        count += 1;
      }
      if (count >= 5) return { startX, startY, endX, endY };
    }
    return null;
  }

  function resetGame() {
    const wasThinking = engineThinking;
    board = new Int8Array(SIZE * SIZE);
    history = [];
    winner = EMPTY;
    winLine = null;
    hover = null;
    clearAnalysis();
    if (wasThinking) startEngine();
    updateUi();
    if (!wasThinking && engineReady && currentSide() === aiSide()) setTimeout(requestAiMove, 120);
  }

  function undoLastRound() {
    let lastHumanIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].side === humanSide) {
        lastHumanIndex = index;
        break;
      }
    }
    if (lastHumanIndex < 0) return;
    history = history.slice(0, lastHumanIndex);
    board = new Int8Array(SIZE * SIZE);
    for (const move of history) board[toIndex(move.x, move.y)] = move.side;
    winner = EMPTY;
    winLine = null;
    hover = null;
    clearAnalysis();
    if (engineThinking) startEngine();
    updateUi();
  }

  function clearAnalysis() {
    els.depthValue.textContent = "-";
    els.evalValue.textContent = "-";
    els.nodesValue.textContent = "-";
    els.speedValue.textContent = "-";
    els.bestlineValue.textContent = "等待 AI 思考";
    els.thinkingIndicator.className = "thinking-indicator";
    els.thinkingIndicator.textContent = engineReady ? "等待对局" : "引擎加载中";
  }

  function updateUi() {
    drawBoard();
    updateStatus();
    updateControls();
  }

  function updateStatus() {
    const side = winner > 0 ? winner : currentSide();
    const sideName = side === BLACK ? "黑方" : "白方";
    const stoneClass = side === BLACK ? "black" : "white";
    const turnStone = els.turnPill.querySelector(".mini-stone");
    turnStone.className = `mini-stone ${stoneClass}`;
    els.statusStone.className = `status-stone ${stoneClass}`;

    if (winner === -1) {
      els.turnText.textContent = "和棋";
      els.statusTitle.textContent = "棋盘已满，和棋";
      els.statusDetail.textContent = "势均力敌。重新开始再下一盘吧。";
      return;
    }
    if (winner > 0) {
      const humanWon = winner === humanSide;
      els.turnText.textContent = `${sideName}获胜`;
      els.statusTitle.textContent = humanWon ? "你赢了！" : "Rapfi 获胜";
      els.statusDetail.textContent = `${sideName}已经连成五子。${humanWon ? "漂亮的一局。" : "可以悔棋复盘，或重新挑战。"}`;
      return;
    }
    els.turnText.textContent = `${sideName}行棋`;
    if (engineFailed) {
      els.statusTitle.textContent = "AI 引擎不可用";
      els.statusDetail.textContent = "请刷新页面重新加载 Rapfi。";
    } else if (!engineReady) {
      els.statusTitle.textContent = "正在准备 AI";
      els.statusDetail.textContent = "NNUE 模型较大，首次打开需要一点时间。";
    } else if (engineThinking) {
      els.statusTitle.textContent = "Rapfi 正在思考";
      els.statusDetail.textContent = `当前为${difficultyLabel()}，搜索完成后会自动落子。`;
    } else if (currentSide() === humanSide) {
      els.statusTitle.textContent = "轮到你了";
      els.statusDetail.textContent = `你执${humanSide === BLACK ? "黑" : "白"}，点击棋盘交叉点落子。`;
    } else {
      els.statusTitle.textContent = "等待 Rapfi 落子";
      els.statusDetail.textContent = "AI 即将开始搜索。";
    }
  }

  function updateControls() {
    els.undoButton.disabled = !history.some((move) => move.side === humanSide);
    els.newGameButton.disabled = false;
    els.board.setAttribute(
      "aria-label",
      `十五乘十五五子棋棋盘，已下 ${history.length} 手，${winner ? "对局结束" : `${currentSide() === BLACK ? "黑" : "白"}方行棋`}`
    );
  }

  function resizeBoard() {
    const rect = els.boardWrap.getBoundingClientRect();
    const nextSize = Math.max(280, Math.floor(Math.min(rect.width, rect.height || rect.width)));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasSize = nextSize;
    els.board.width = Math.round(nextSize * dpr);
    els.board.height = Math.round(nextSize * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const padding = nextSize * 0.065;
    geometry = {
      padding,
      gap: (nextSize - padding * 2) / (SIZE - 1)
    };
    drawBoard();
  }

  function drawBoard() {
    if (!geometry || !canvasSize) return;
    const { padding, gap } = geometry;
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    const wood = ctx.createLinearGradient(0, 0, canvasSize, canvasSize);
    wood.addColorStop(0, "#e5bd78");
    wood.addColorStop(0.52, "#d9aa61");
    wood.addColorStop(1, "#c89149");
    ctx.fillStyle = wood;
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    ctx.save();
    ctx.globalAlpha = 0.1;
    ctx.strokeStyle = "#6b421d";
    for (let y = 7; y < canvasSize; y += 13) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(canvasSize * 0.3, y - 4, canvasSize * 0.66, y + 4, canvasSize, y - 1);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(58, 38, 18, 0.76)";
    ctx.lineWidth = Math.max(1, gap * 0.045);
    for (let index = 0; index < SIZE; index += 1) {
      const point = padding + index * gap;
      ctx.beginPath();
      ctx.moveTo(padding, point);
      ctx.lineTo(canvasSize - padding, point);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(point, padding);
      ctx.lineTo(point, canvasSize - padding);
      ctx.stroke();
    }

    const stars = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
    ctx.fillStyle = "rgba(49, 32, 15, 0.88)";
    for (const [x, y] of stars) {
      ctx.beginPath();
      ctx.arc(padding + x * gap, padding + y * gap, Math.max(2.2, gap * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }

    if (hover && canHumanMove() && board[toIndex(hover.x, hover.y)] === EMPTY) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      drawStone(hover.x, hover.y, humanSide);
      ctx.restore();
    }

    for (const move of history) drawStone(move.x, move.y, move.side);

    const lastMove = history.at(-1);
    if (lastMove) {
      ctx.fillStyle = "#d94a40";
      ctx.beginPath();
      ctx.arc(
        padding + lastMove.x * gap,
        padding + lastMove.y * gap,
        Math.max(2.2, gap * 0.09),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    if (winLine) {
      ctx.strokeStyle = "rgba(220, 62, 52, 0.9)";
      ctx.lineWidth = Math.max(3, gap * 0.14);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(padding + winLine.startX * gap, padding + winLine.startY * gap);
      ctx.lineTo(padding + winLine.endX * gap, padding + winLine.endY * gap);
      ctx.stroke();
    }
  }

  function drawStone(x, y, side) {
    const { padding, gap } = geometry;
    const centerX = padding + x * gap;
    const centerY = padding + y * gap;
    const radius = gap * 0.43;
    ctx.save();
    ctx.shadowColor = "rgba(47, 31, 14, 0.28)";
    ctx.shadowBlur = radius * 0.45;
    ctx.shadowOffsetY = radius * 0.2;
    const gradient = ctx.createRadialGradient(
      centerX - radius * 0.35,
      centerY - radius * 0.38,
      radius * 0.08,
      centerX,
      centerY,
      radius
    );
    if (side === BLACK) {
      gradient.addColorStop(0, "#6b7773");
      gradient.addColorStop(0.35, "#2c3733");
      gradient.addColorStop(1, "#070b09");
    } else {
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(0.58, "#f1f3f2");
      gradient.addColorStop(1, "#bfc8c4");
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.strokeStyle = side === BLACK ? "rgba(0,0,0,0.72)" : "rgba(83,95,90,0.55)";
    ctx.lineWidth = Math.max(0.8, gap * 0.035);
    ctx.stroke();
    ctx.restore();
  }

  function pointFromEvent(event) {
    if (!geometry) return null;
    const rect = els.board.getBoundingClientRect();
    const scaleX = canvasSize / rect.width;
    const scaleY = canvasSize / rect.height;
    const x = Math.round(((event.clientX - rect.left) * scaleX - geometry.padding) / geometry.gap);
    const y = Math.round(((event.clientY - rect.top) * scaleY - geometry.padding) / geometry.gap);
    if (!insideBoard(x, y)) return null;
    return { x, y };
  }

  function canHumanMove() {
    return engineReady && !engineThinking && !winner && currentSide() === humanSide;
  }

  function currentSide() {
    return history.length % 2 === 0 ? BLACK : WHITE;
  }

  function aiSide() {
    return humanSide === BLACK ? WHITE : BLACK;
  }

  function toIndex(x, y) {
    return y * SIZE + x;
  }

  function insideBoard(x, y) {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
  }

  function difficultyLabel() {
    if (difficulty === "casual") return "休闲难度";
    if (difficulty === "master") return "挑战难度";
    return "进阶难度";
  }

  function compactNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value || "-");
    return new Intl.NumberFormat("zh-CN", {
      notation: number >= 10000 ? "compact" : "standard",
      maximumFractionDigits: 1
    }).format(number);
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatBestline(value) {
    const coords = String(value).match(/\d+,\d+/g) || [];
    if (!coords.length) return value || "-";
    return coords.slice(0, 10).map((coord) => {
      const [x, y] = coord.split(",").map(Number);
      return `${String.fromCharCode(65 + x)}${SIZE - y}`;
    }).join(" ");
  }
})();
