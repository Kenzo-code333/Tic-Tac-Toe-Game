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

  // Online play runs on the page's Claude artifact: each game is one shared
  // document, games/<CODE>, that both players watch and write.
  const ARTIFACT_URL = "https://claude.ai/artifact/LYpAW1Bt53d2meFLGnZpMo";
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const CODE_LENGTH = 5;
  const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    setup: $("#setup-screen"),
    lobby: $("#lobby-screen"),
    game: $("#game-screen"),
    difficultyField: $("#difficulty-field"),
    difficultyHint: $("#difficulty-hint"),
    sideField: $("#side-field"),
    namesField: $("#names-field"),
    nameX: $("#name-x"),
    nameO: $("#name-o"),
    onlineModeBtn: $("#online-mode-btn"),
    onlineHint: $("#online-hint"),
    joinField: $("#join-field"),
    joinCode: $("#join-code"),
    joinBtn: $("#join-btn"),
    startBtn: $("#start-btn"),
    onlineError: $("#online-error"),
    lobbyCode: $("#lobby-code"),
    inviteLink: $("#invite-link"),
    copyBtn: $("#copy-btn"),
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
    footer: $("#footer"),
    footerMode: $("#footer-mode"),
  };

  const settings = { mode: "bot", difficulty: "medium", humanSide: "X" };

  const state = {
    board: Array(9).fill(null),
    turn: "X",
    starter: "X",
    scores: { X: 0, O: 0, draw: 0 },
    names: { X: "You", O: "Bot" },
    botTimer: null,
  };

  const online = {
    db: null,
    user: null,
    myId: null,
    code: "",
    ref: null,
    unsubscribe: null,
    game: null, // last snapshot of games/<code>
    side: null, // "X" | "O"
    names: {}, // user id -> display name, resolved per viewer
    writing: Promise.resolve(),
  };

  let shownWinKey = "";

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
  const boardOver = (board) => Boolean(getWinner(board)) || emptyCells(board).length === 0;
  const isOver = () => boardOver(state.board);

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

  const isOnline = () => settings.mode === "online";
  const friendSide = () => other(online.side);
  const friendName = () => {
    const id = online.game && online.game.players && online.game.players[friendSide()];
    return (id && online.names[id]) || "Friend";
  };

  function isBotTurn() {
    return settings.mode === "bot" && state.turn !== settings.humanSide;
  }

  function isLocked() {
    if (isOver() || isBotTurn()) return true;
    if (isOnline()) return state.turn !== online.side;
    return false;
  }

  function displayName(side) {
    if (isOnline()) return side === online.side ? "You" : friendName();
    return state.names[side];
  }

  function renderCell(i) {
    const cell = els.cells[i];
    const value = state.board[i] || "";
    if (cell.dataset.mark === value) return; // unchanged; keep its animation state
    cell.dataset.mark = value;
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

  function statusText(win) {
    if (win) {
      if (settings.mode === "bot") {
        return win.player === settings.humanSide ? "You win! 🎉" : "Bot wins. Try again!";
      }
      if (isOnline()) {
        return win.player === online.side ? "You win! 🎉" : `${friendName()} wins this round`;
      }
      return `${state.names[win.player]} wins! 🎉`;
    }
    if (emptyCells(state.board).length === 0) return "It's a draw 🤝";
    if (settings.mode === "bot") return isBotTurn() ? "Bot is thinking…" : "Your turn";
    if (isOnline()) return state.turn === online.side ? "Your turn" : `Waiting for ${friendName()}…`;
    return `${state.names[state.turn]}'s turn (${state.turn})`;
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

  function render() {
    const win = getWinner(state.board);
    const over = isOver();

    els.cells.forEach((_, i) => renderCell(i));
    els.cells.forEach((cell, i) => cell.classList.toggle("win-cell", Boolean(win && win.line.includes(i))));

    const winKey = win ? win.line.join("") : "";
    if (winKey !== shownWinKey) {
      shownWinKey = winKey;
      if (win) drawWinLine(win.line);
      else els.winLine.classList.remove("show");
    }

    const mine = isOnline() ? online.side : settings.humanSide;
    const youWon = win && (settings.mode === "friend" || win.player === mine);
    els.status.textContent = statusText(win);
    els.status.classList.toggle("win", Boolean(youWon));

    els.scoreX.textContent = state.scores.X;
    els.scoreO.textContent = state.scores.O;
    els.scoreDraw.textContent = state.scores.draw;
    els.scoreNameX.textContent = `${displayName("X")} (X)`;
    els.scoreNameO.textContent = `${displayName("O")} (O)`;

    const locked = isLocked();
    els.cells.forEach((cell, i) => {
      cell.disabled = locked || Boolean(state.board[i]);
    });
    els.board.dataset.turn = locked ? "" : state.turn;
    els.board.classList.toggle("over", over);
    els.scoreCardX.classList.toggle("turn", !over && state.turn === "X");
    els.scoreCardO.classList.toggle("turn", !over && state.turn === "O");
  }

  /* ---------- Turn flow (bot and same phone) ---------- */

  function play(index) {
    if (isOver() || state.board[index]) return;

    state.board[index] = state.turn;
    const win = getWinner(state.board);
    if (win) state.scores[win.player] += 1;
    else if (emptyCells(state.board).length === 0) state.scores.draw += 1;
    else state.turn = other(state.turn);

    render();
    maybeBotMove();
  }

  function maybeBotMove() {
    if (isOver() || !isBotTurn()) return;
    clearTimeout(state.botTimer);
    state.botTimer = setTimeout(() => {
      state.botTimer = null;
      if (isOver() || !isBotTurn()) return;
      play(chooseBotMove(state.board, state.turn, settings.difficulty));
    }, BOT_DELAY_MS);
  }

  function newRound() {
    clearTimeout(state.botTimer);
    state.botTimer = null;
    state.board = Array(9).fill(null);
    // In same-phone games the starting player alternates each round; vs bot, X always opens.
    if (settings.mode === "bot") {
      state.turn = "X";
    } else {
      state.turn = state.starter;
      state.starter = other(state.starter);
    }
    render();
    maybeBotMove();
  }

  function showScreen(screen) {
    els.setup.hidden = screen !== "setup";
    els.lobby.hidden = screen !== "lobby";
    els.game.hidden = screen !== "game";
    els.footer.hidden = screen !== "game";
  }

  function startLocalGame() {
    if (settings.mode === "bot") {
      state.names[settings.humanSide] = "You";
      state.names[other(settings.humanSide)] = "Bot";
      const label = { easy: "Easy", medium: "Medium", hard: "Impossible" }[settings.difficulty];
      els.footerMode.textContent = `vs Bot · ${label}`;
    } else {
      state.names.X = els.nameX.value.trim() || "Player 1";
      state.names.O = els.nameO.value.trim() || "Player 2";
      els.footerMode.textContent = "Same phone";
    }
    state.scores = { X: 0, O: 0, draw: 0 };
    state.starter = "X";
    showScreen("game");
    newRound();
  }

  function showMenu() {
    leaveOnline();
    clearTimeout(state.botTimer);
    state.botTimer = null;
    showScreen("setup");
  }

  /* ---------- Online play ---------- */

  // Round r is opened by X when r is even and by O when it is odd, so both
  // players compute the same next round even if they tap New round together.
  const openerOf = (round) => (round % 2 === 0 ? "X" : "O");
  const inviteUrl = () => `${ARTIFACT_URL}#${online.code}`;

  function randomCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += randomItem(CODE_ALPHABET.split(""));
    return code;
  }

  function showOnlineError(message) {
    els.onlineError.textContent = message;
    els.onlineError.hidden = !message;
  }

  function setBusy(busy, label) {
    els.startBtn.disabled = busy;
    els.joinBtn.disabled = busy;
    els.joinBtn.textContent = label || "Join";
  }

  // Writes to the game document go one at a time, in order.
  function writeGame(fields) {
    const ref = online.ref;
    online.writing = online.writing
      .then(() => ref && ref.update(fields))
      .catch((err) => {
        if (online.ref !== ref) return;
        els.status.textContent = err && err.code === "invalid_argument"
          ? "You don't have permission to play online. Ask the owner to share this page with you as an Editor."
          : "Couldn't save that move. Check your connection and try again.";
      });
    return online.writing;
  }

  function applyGame(game) {
    const board = Array.isArray(game.board) ? game.board : [];
    state.board = Array.from({ length: 9 }, (_, i) => (board[i] === "X" || board[i] === "O" ? board[i] : null));
    state.turn = game.turn === "O" ? "O" : "X";
    const s = game.scores || {};
    state.scores = { X: Number(s.X) || 0, O: Number(s.O) || 0, draw: Number(s.draw) || 0 };
  }

  async function resolveNames(game) {
    const ids = Object.values(game.players || {}).filter(Boolean);
    if (!ids.length || !online.user) return;
    const profiles = await online.user.profiles(ids);
    let changed = false;
    for (const id of ids) {
      const name = (profiles[id] && profiles[id].name) || "";
      const first = name.split(" ")[0];
      if (first && online.names[id] !== first) {
        online.names[id] = first;
        changed = true;
      }
    }
    if (changed && isOnline() && !els.game.hidden) render();
  }

  function handleSnapshot(snap) {
    if (!snap.exists) {
      const wasPlaying = !els.game.hidden || !els.lobby.hidden;
      leaveOnline();
      if (wasPlaying) {
        showScreen("setup");
        showOnlineError("That game has ended.");
      }
      return;
    }
    const game = snap.data();
    online.game = game;
    applyGame(game);
    resolveNames(game);

    if (!game.players || !game.players.O) {
      showScreen("lobby");
      return;
    }
    showScreen("game");
    render();
  }

  function watchGame(code, side) {
    online.code = code;
    online.side = side;
    online.ref = online.db.doc(`games/${code}`);
    els.lobbyCode.textContent = code;
    els.inviteLink.textContent = inviteUrl();
    els.footerMode.textContent = `Online · code ${code}`;
    online.unsubscribe = online.ref.onSnapshot(handleSnapshot, () => {
      leaveOnline();
      showScreen("setup");
      showOnlineError("Lost the connection to this game. Join again with the same code.");
    });
  }

  function leaveOnline() {
    if (online.unsubscribe) online.unsubscribe();
    online.unsubscribe = null;
    online.ref = null;
    online.game = null;
    online.side = null;
    setBusy(false);
  }

  async function createOnlineGame() {
    leaveOnline();
    showOnlineError("");
    setBusy(true);
    try {
      let code = randomCode();
      for (let i = 0; i < 5 && (await online.db.doc(`games/${code}`).get()).exists; i++) code = randomCode();
      await online.db.doc(`games/${code}`).set({
        board: Array(9).fill(""),
        turn: "X",
        round: 0,
        scores: { X: 0, O: 0, draw: 0 },
        players: { X: online.myId, O: "" },
        createdAt: Date.now(),
      });
      setBusy(false);
      watchGame(code, "X");
      showScreen("lobby");
    } catch (err) {
      setBusy(false);
      showOnlineError(err && err.code === "invalid_argument"
        ? "You can't create online games on this page. Ask the owner to share it with you as an Editor."
        : "Couldn't create a game. Check your connection and try again.");
    }
  }

  async function joinOnlineGame(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!CODE_PATTERN.test(code)) {
      showOnlineError(`Enter the ${CODE_LENGTH}-character code your friend sent you.`);
      return;
    }
    leaveOnline();
    showOnlineError("");
    setBusy(true, "Joining…");
    try {
      const ref = online.db.doc(`games/${code}`);
      let snap = await ref.get();
      if (!snap.exists) throw new Error("not_found");
      let players = snap.data().players || {};

      if (players.X !== online.myId && players.O !== online.myId) {
        if (players.O) throw new Error("full");
        // Claim the O seat under a short lease so two people can't both take it.
        const lease = await ref.acquire({ holder: online.myId, ttlMs: 5000 });
        if (!lease.acquired) throw new Error("full");
        snap = await ref.get();
        players = (snap.exists && snap.data().players) || {};
        if (players.O && players.O !== online.myId) throw new Error("full");
        await ref.update({ players: { O: online.myId } });
        players = { ...players, O: online.myId };
      }

      setBusy(false);
      watchGame(code, players.X === online.myId ? "X" : "O");
    } catch (err) {
      setBusy(false);
      const reason = err && (err.message || err.code);
      showOnlineError(
        reason === "not_found" ? `No game found with code ${code}. Check the code with your friend.`
          : reason === "full" ? "That game already has two players."
            : reason === "invalid_argument" ? "You can't join online games on this page. Ask the owner to share it with you as an Editor."
              : "Couldn't join. Check your connection and try again.",
      );
    }
  }

  function playOnline(index) {
    if (isLocked() || state.board[index]) return;
    const board = state.board.slice();
    board[index] = state.turn;
    const scores = { ...state.scores };
    const win = getWinner(board);
    let turn = state.turn;
    if (win) scores[win.player] += 1;
    else if (emptyCells(board).length === 0) scores.draw += 1;
    else turn = other(turn);

    // Show the move straight away; the shared document confirms it.
    state.board = board;
    state.turn = turn;
    state.scores = scores;
    render();
    writeGame({ board: board.map((v) => v || ""), turn, scores });
  }

  function newOnlineRound() {
    if (!online.game || !boardOver(state.board)) return;
    const round = (Number(online.game.round) || 0) + 1;
    writeGame({ board: Array(9).fill(""), turn: openerOf(round), round });
  }

  async function cancelLobby() {
    const { ref, game } = online;
    leaveOnline();
    showScreen("setup");
    if (ref && game && !(game.players && game.players.O)) {
      try { await ref.delete(); } catch { /* nothing to clean up */ }
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      els.copyBtn.textContent = "Copied!";
    } catch {
      // Clipboard refused: select the link so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(els.inviteLink);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      els.copyBtn.textContent = "Select and copy the link";
    }
    setTimeout(() => { els.copyBtn.textContent = "Copy invite link"; }, 2000);
  }

  async function initOnline() {
    if (!window.claude || typeof window.claude.use !== "function") return;
    const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    if (!db || !user) return;
    const myId = await user.id();
    if (!myId) return;
    Object.assign(online, { db, user, myId });
    els.onlineModeBtn.hidden = false;

    // An invite link ends in #CODE: open straight into that game.
    const invited = location.hash.replace(/^#/, "").toUpperCase();
    if (CODE_PATTERN.test(invited)) {
      selectSegment("mode", "online");
      els.joinCode.value = invited;
      joinOnlineGame(invited);
    }
  }

  /* ---------- Setup controls ---------- */

  const segmentHandlers = {};

  function selectSegment(attr, value) {
    $$(`[data-${attr}]`).forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    });
    segmentHandlers[attr](value);
  }

  function bindSegmented(attr, onChange) {
    segmentHandlers[attr] = onChange;
    $$(`[data-${attr}]`).forEach((btn) => {
      btn.addEventListener("click", () => selectSegment(attr, btn.dataset[attr]));
    });
  }

  bindSegmented("mode", (mode) => {
    settings.mode = mode;
    els.difficultyField.hidden = mode !== "bot";
    els.sideField.hidden = mode !== "bot";
    els.namesField.hidden = mode !== "friend";
    els.onlineHint.hidden = mode !== "online";
    els.joinField.hidden = mode !== "online";
    els.startBtn.textContent = mode === "online" ? "Create online game" : "Start game";
    showOnlineError("");
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
      if (isLocked()) return;
      const index = Number(cell.dataset.index);
      if (isOnline()) playOnline(index);
      else play(index);
    });
  });

  els.startBtn.addEventListener("click", () => {
    if (settings.mode === "online") createOnlineGame();
    else startLocalGame();
  });

  $("#restart-btn").addEventListener("click", () => {
    if (isOnline()) newOnlineRound();
    else newRound();
  });

  $("#reset-score-btn").addEventListener("click", () => {
    if (isOnline()) {
      writeGame({ scores: { X: 0, O: 0, draw: 0 } });
    } else {
      state.scores = { X: 0, O: 0, draw: 0 };
      render();
    }
  });

  $("#menu-btn").addEventListener("click", showMenu);
  $("#cancel-btn").addEventListener("click", cancelLobby);
  els.copyBtn.addEventListener("click", copyInvite);
  els.joinBtn.addEventListener("click", () => joinOnlineGame(els.joinCode.value));

  els.joinCode.addEventListener("input", () => {
    els.joinCode.value = els.joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
  els.joinCode.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinOnlineGame(els.joinCode.value);
  });

  [els.nameX, els.nameO].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") startLocalGame();
    });
  });

  initOnline();

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
