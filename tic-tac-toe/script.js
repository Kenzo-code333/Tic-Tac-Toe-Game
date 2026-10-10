(() => {
  "use strict";

  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
    [0, 4, 8], [2, 4, 6],            // diagonals
  ];

  const DIFFICULTY_HINTS = {
    easy: "Plays mostly at random. Great for warming up.",
    medium: "Blocks your wins, but slips up sometimes.",
    hard: "Perfect play with minimax. The best you can do is draw.",
  };

  const BOT_DELAY_MS = 450;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    setup: $("#setup-screen"),
    game: $("#game-screen"),
    difficultyField: $("#difficulty-field"),
    difficultyHint: $("#difficulty-hint"),
    sideField: $("#side-field"),
    namesField: $("#names-field"),
    nameX: $("#name-x"),
    nameO: $("#name-o"),
    board: $("#board"),
    cells: $$(".cell"),
    status: $("#status"),
    scoreX: $("#score-x"),
    scoreO: $("#score-o"),
    scoreDraw: $("#score-draw"),
    scoreNameX: $("#score-name-x"),
    scoreNameO: $("#score-name-o"),
    scoreCardX: $("#score-card-x"),
    scoreCardO: $("#score-card-o"),
    winLine: $("#win-line"),
    winLinePath: $("#win-line-path"),
    footerMode: $("#footer-mode"),
  };

  const settings = { mode: "bot", difficulty: "medium", humanSide: "X" };

  const state = {
    board: Array(9).fill(null),
    turn: "X",
    starter: "X",
    over: false,
    scores: { X: 0, O: 0, draw: 0 },
    names: { X: "You", O: "Bot" },
    botTimer: null,
  };

  /* ---------- Game logic ---------- */

  function getWinner(board) {
    for (const line of LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return { player: board[a], line };
      }
    }
    return null;
  }

  const emptyCells = (board) => board.reduce((acc, v, i) => (v ? acc : [...acc, i]), []);
  const other = (p) => (p === "X" ? "O" : "X");
  const randomItem = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // Returns a move that immediately wins for `player`, or -1.
  function findWinningMove(board, player) {
    for (const i of emptyCells(board)) {
      board[i] = player;
      const wins = getWinner(board);
      board[i] = null;
      if (wins) return i;
    }
    return -1;
  }

  // Minimax with depth so the bot prefers faster wins and slower losses.
  function minimax(board, player, me, depth) {
    const win = getWinner(board);
    if (win) return win.player === me ? 10 - depth : depth - 10;
    const moves = emptyCells(board);
    if (moves.length === 0) return 0;

    let best = player === me ? -Infinity : Infinity;
    for (const i of moves) {
      board[i] = player;
      const score = minimax(board, other(player), me, depth + 1);
      board[i] = null;
      best = player === me ? Math.max(best, score) : Math.min(best, score);
    }
    return best;
  }

  function bestMove(board, me) {
    let bestScore = -Infinity;
    let candidates = [];
    for (const i of emptyCells(board)) {
      board[i] = me;
      const score = minimax(board, other(me), me, 1);
      board[i] = null;
      if (score > bestScore) {
        bestScore = score;
        candidates = [i];
      } else if (score === bestScore) {
        candidates.push(i);
      }
    }
    // Pick randomly among equally good moves so games feel less repetitive.
    return randomItem(candidates);
  }

  function chooseBotMove(board, me, difficulty) {
    const moves = emptyCells(board);
    const copy = board.slice();

    if (difficulty === "easy") {
      const win = findWinningMove(copy, me);
      if (win !== -1 && Math.random() < 0.3) return win;
      return randomItem(moves);
    }

    if (difficulty === "medium") {
      const win = findWinningMove(copy, me);
      if (win !== -1) return win;
      const block = findWinningMove(copy, other(me));
      if (block !== -1 && Math.random() < 0.85) return block;
      return Math.random() < 0.5 ? bestMove(copy, me) : randomItem(moves);
    }

    return bestMove(copy, me);
  }

  /* ---------- Rendering ---------- */

  function renderCell(i) {
    const cell = els.cells[i];
    const value = state.board[i];
    cell.className = "cell";
    cell.innerHTML = "";
    if (value) {
      cell.classList.add("filled", value.toLowerCase());
      const span = document.createElement("span");
      span.textContent = value;
      cell.appendChild(span);
      cell.setAttribute("aria-label", `Cell ${i + 1}, ${value}`);
    } else {
      cell.setAttribute("aria-label", `Cell ${i + 1}, empty`);
    }
  }

  function isBotTurn() {
    return settings.mode === "bot" && state.turn !== settings.humanSide;
  }

  function updateInteractivity() {
    const locked = state.over || isBotTurn();
    els.cells.forEach((cell, i) => {
      cell.disabled = locked || Boolean(state.board[i]);
    });
    els.board.dataset.turn = locked ? "" : state.turn;
    els.board.classList.toggle("over", state.over);
    els.scoreCardX.classList.toggle("turn", !state.over && state.turn === "X");
    els.scoreCardO.classList.toggle("turn", !state.over && state.turn === "O");
  }

  function setStatus(text, isWin = false) {
    els.status.textContent = text;
    els.status.classList.toggle("win", isWin);
  }

  function turnStatus() {
    if (settings.mode === "bot") {
      return isBotTurn() ? "Bot is thinking…" : "Your turn";
    }
    return `${state.names[state.turn]}'s turn (${state.turn})`;
  }

  function renderScores() {
    els.scoreX.textContent = state.scores.X;
    els.scoreO.textContent = state.scores.O;
    els.scoreDraw.textContent = state.scores.draw;
    els.scoreNameX.textContent = `${state.names.X} (X)`;
    els.scoreNameO.textContent = `${state.names.O} (O)`;
  }

  function drawWinLine(line) {
    // Cell centres in a 300x300 viewBox; extend the line slightly past the ends.
    const centre = (i) => ({ x: (i % 3) * 100 + 50, y: Math.floor(i / 3) * 100 + 50 });
    const a = centre(line[0]);
    const b = centre(line[2]);
    const dx = (b.x - a.x) * 0.18;
    const dy = (b.y - a.y) * 0.18;
    els.winLinePath.setAttribute("x1", a.x - dx);
    els.winLinePath.setAttribute("y1", a.y - dy);
    els.winLinePath.setAttribute("x2", b.x + dx);
    els.winLinePath.setAttribute("y2", b.y + dy);
    els.winLine.classList.remove("show");
    void els.winLine.getBoundingClientRect(); // restart the animation
    els.winLine.classList.add("show");
  }

  /* ---------- Turn flow ---------- */

  function play(index) {
    if (state.over || state.board[index]) return;

    state.board[index] = state.turn;
    renderCell(index);

    const win = getWinner(state.board);
    if (win) {
      state.over = true;
      state.scores[win.player] += 1;
      win.line.forEach((i) => els.cells[i].classList.add("win-cell"));
      drawWinLine(win.line);
      if (settings.mode === "bot") {
        setStatus(win.player === settings.humanSide ? "You win! 🎉" : "Bot wins. Try again!", win.player === settings.humanSide);
      } else {
        setStatus(`${state.names[win.player]} wins! 🎉`, true);
      }
    } else if (emptyCells(state.board).length === 0) {
      state.over = true;
      state.scores.draw += 1;
      setStatus("It's a draw 🤝");
    } else {
      state.turn = other(state.turn);
      setStatus(turnStatus());
    }

    renderScores();
    updateInteractivity();
    maybeBotMove();
  }

  function maybeBotMove() {
    if (state.over || !isBotTurn()) return;
    clearTimeout(state.botTimer);
    state.botTimer = setTimeout(() => {
      state.botTimer = null;
      if (state.over || !isBotTurn()) return;
      play(chooseBotMove(state.board, state.turn, settings.difficulty));
    }, BOT_DELAY_MS);
  }

  function newRound() {
    clearTimeout(state.botTimer);
    state.botTimer = null;
    state.board = Array(9).fill(null);
    state.over = false;
    // In friend mode the starting player alternates each round; vs bot, X always opens.
    state.turn = settings.mode === "friend" ? state.starter : "X";
    if (settings.mode === "friend") state.starter = other(state.starter);

    els.winLine.classList.remove("show");
    els.cells.forEach((_, i) => renderCell(i));
    setStatus(turnStatus());
    updateInteractivity();
    maybeBotMove();
  }

  function startGame() {
    if (settings.mode === "bot") {
      state.names[settings.humanSide] = "You";
      state.names[other(settings.humanSide)] = "Bot";
      const label = { easy: "Easy", medium: "Medium", hard: "Impossible" }[settings.difficulty];
      els.footerMode.textContent = `vs Bot · ${label}`;
    } else {
      state.names.X = els.nameX.value.trim() || "Player 1";
      state.names.O = els.nameO.value.trim() || "Player 2";
      els.footerMode.textContent = "vs Friend";
    }
    state.scores = { X: 0, O: 0, draw: 0 };
    state.starter = "X";
    renderScores();

    els.setup.hidden = true;
    els.game.hidden = false;
    newRound();
  }

  function showMenu() {
    clearTimeout(state.botTimer);
    state.botTimer = null;
    els.game.hidden = true;
    els.setup.hidden = false;
    els.footerMode.textContent = "—";
  }

  /* ---------- Setup controls ---------- */

  function bindSegmented(attr, onChange) {
    const buttons = $$(`[data-${attr}]`);
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        buttons.forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-checked", String(b === btn));
        });
        onChange(btn.dataset[attr]);
      });
    });
  }

  bindSegmented("mode", (mode) => {
    settings.mode = mode;
    const vsBot = mode === "bot";
    els.difficultyField.hidden = !vsBot;
    els.sideField.hidden = !vsBot;
    els.namesField.hidden = vsBot;
  });

  bindSegmented("difficulty", (difficulty) => {
    settings.difficulty = difficulty;
    els.difficultyHint.textContent = DIFFICULTY_HINTS[difficulty];
  });

  bindSegmented("side", (side) => {
    settings.humanSide = side;
  });

  els.cells.forEach((cell) => {
    cell.addEventListener("click", () => {
      if (isBotTurn()) return;
      play(Number(cell.dataset.index));
    });
  });

  $("#start-btn").addEventListener("click", startGame);
  $("#restart-btn").addEventListener("click", newRound);
  $("#menu-btn").addEventListener("click", showMenu);
  $("#reset-score-btn").addEventListener("click", () => {
    state.scores = { X: 0, O: 0, draw: 0 };
    renderScores();
  });

  [els.nameX, els.nameO].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startGame();
    });
  });

  /* ---------- Theme ---------- */

  const root = document.documentElement;
  function readStoredTheme() {
    try { return localStorage.getItem("ttt-theme"); } catch { return null; }
  }
  function applyTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem("ttt-theme", theme); } catch { /* storage unavailable */ }
  }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = readStoredTheme() || (prefersDark ? "dark" : "light");
  $("#theme-toggle").addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });
})();
