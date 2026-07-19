(() => {
  "use strict";

  const STORAGE_KEY = "fanhao.jump.best.v1";
  const scoreValue = document.getElementById("scoreValue");
  const bestValue = document.getElementById("bestValue");
  const finalScore = document.getElementById("finalScore");
  const finalBest = document.getElementById("finalBest");
  const loadingPanel = document.getElementById("loadingPanel");
  const loadingDetail = document.getElementById("loadingDetail");
  const gameOverPanel = document.getElementById("gameOverPanel");
  const errorPanel = document.getElementById("errorPanel");
  const errorDetail = document.getElementById("errorDetail");
  const restartButton = document.getElementById("restartButton");
  const retryButton = document.getElementById("retryButton");
  const playHint = document.getElementById("playHint");
  const hintText = document.getElementById("hintText");

  let score = 0;
  let best = readBest();
  let ready = false;
  let gameOver = false;

  updateScore();

  const readyTimeout = window.setTimeout(() => {
    if (!ready) showError("场景加载超时，请刷新后重试。");
  }, 8000);

  window.addEventListener("fanhao:jump-ready", () => {
    ready = true;
    window.clearTimeout(readyTimeout);
    loadingPanel.hidden = true;

    const canvas = document.querySelector("body > canvas");
    if (!canvas) {
      showError("没有找到游戏画布，请刷新后重试。");
      return;
    }

    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "蓄力跳台游戏画面，按住蓄力，松开起跳");
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      showError("WebGL 上下文已丢失，请刷新页面重新开始。");
    });
    canvas.addEventListener("pointerdown", () => {
      if (gameOver) return;
      playHint.classList.add("compact");
      hintText.textContent = "正在蓄力，松开起跳";
    });
    window.addEventListener("pointerup", () => {
      if (!gameOver) hintText.textContent = "落稳后继续按住蓄力";
    });
  }, {once: true});

  window.addEventListener("fanhao:jump-score", (event) => {
    score = Math.max(0, Number(event.detail?.score) || 0);
    if (score > best) {
      best = score;
      writeBest(best);
    }
    updateScore();
    hintText.textContent = "漂亮！继续按住蓄力";
  });

  window.addEventListener("fanhao:jump-game-over", (event) => {
    if (gameOver) return;
    gameOver = true;
    score = Math.max(score, Number(event.detail?.score) || 0);
    if (score > best) {
      best = score;
      writeBest(best);
    }
    updateScore();
    finalScore.textContent = String(score);
    finalBest.textContent = String(best);
    hintText.textContent = "落空了，重新开始再试一次";
    window.setTimeout(() => {
      gameOverPanel.hidden = false;
      restartButton.focus({preventScroll: true});
    }, 620);
  });

  window.addEventListener("error", (event) => {
    const source = String(event.filename || "");
    if (source.includes("game.a87e6d4f5755295c82b3.js")) {
      showError("游戏脚本执行失败，请刷新后重试。");
    }
  });

  restartButton.addEventListener("click", reload);
  retryButton.addEventListener("click", reload);
  document.addEventListener("keydown", (event) => {
    if (gameOver && (event.key === "Enter" || event.key.toLowerCase() === "r")) reload();
  });

  function updateScore() {
    scoreValue.textContent = String(score);
    bestValue.textContent = String(best);
  }

  function readBest() {
    try {
      return Math.max(0, Number(window.localStorage.getItem(STORAGE_KEY)) || 0);
    } catch {
      return 0;
    }
  }

  function writeBest(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // 隐私模式或禁用存储时，当前会话仍可正常游玩。
    }
  }

  function showError(message) {
    window.clearTimeout(readyTimeout);
    loadingPanel.hidden = true;
    gameOverPanel.hidden = true;
    errorDetail.textContent = message;
    errorPanel.hidden = false;
  }

  function reload() {
    window.location.reload();
  }
})();
