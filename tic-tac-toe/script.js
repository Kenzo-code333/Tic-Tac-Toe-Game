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

  // Online play: the host's PeerJS id is this prefix plus the game code.
  const PEER_PREFIX = "kzttt-";
  const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const CODE_LENGTH = 5;
  const JOIN_TIMEOUT_MS = 15000;
  // Tests can point PeerJS at a local server by defining window.TTT_PEER_OPTIONS.
  const PEER_OPTIONS = window.TTT_PEER_OPTIONS || {};

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    setup: $("#setup-screen"),
    lobby: $("#lobby-screen"),
    joining: $("#joining-screen"),
    joiningStatus: $("#joining-status"),
    game: $("#game-screen"),
    difficultyField: $("#difficulty-field"),
    difficultyHint: $("#difficulty-hint"),
    sideField: $("#side-field"),
    namesField: $("#names-field"),
    nameX: $("#name-x"),
    nameO: $("#name-o"),
    onlineNameField: $("#online-name-field"),
    onlineName: $("#online-name"),
    joinField: $("#join-field"),
    joinCode: $("#join-code"),
    joinBtn: $("#join-btn"),
    startBtn: $("#start-btn"),
    onlineError: $("#online-error"),
    lobbyCode: $("#lobby-code"),
    lobbyStatus: $("#lobby-status"),
    shareBtn: $("#share-btn"),
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
    restartBtn: $("#restart-btn"),
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

  // The host is always X and holds the real game state; the guest is O and
  // sends its moves to the host, which replies with the full state.
  const online = {
    peer: null,
    conn: null,
    role: null, // "host" | "guest"
    code: "",
    connected: false,
    joinTimer: null,
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
  const isOver = () => Boolean(getWinner(state.board)) || emptyCells(state.board).length === 0;

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
  const isGuest = () => isOnline() && online.role === "guest";
  const mySide = () => (online.role === "guest" ? "O" : "X");
  const friendName = () => state.names[other(mySide())] || "Friend";

  function isBotTurn() {
    return settings.mode === "bot" && state.turn !== settings.humanSide;
  }

  function isLocked() {
    if (isOver() || isBotTurn()) return true;
    if (isOnline()) return !online.connected || state.turn !== mySide();
    return false;
  }

  function displayName(side) {
    if (isOnline()) return side === mySide() ? "You" : friendName();
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
    if (isOnline() && !online.connected) {
      return online.role === "host"
        ? `${friendName()} disconnected. Waiting for them to rejoin…`
        : "Connection lost. Tap Reconnect to rejoin.";
    }
    if (win) {
      if (settings.mode === "bot") {
        return win.player === settings.humanSide ? "You win! 🎉" : "Bot wins. Try again!";
      }
      if (isOnline()) {
        return win.player === mySide() ? "You win! 🎉" : `${friendName()} wins this round`;
      }
      return `${state.names[win.player]} wins! 🎉`;
    }
    if (emptyCells(state.board).length === 0) return "It's a draw 🤝";
    if (settings.mode === "bot") return isBotTurn() ? "Bot is thinking…" : "Your turn";
    if (isOnline()) return state.turn === mySide() ? "Your turn" : `Waiting for ${friendName()}…`;
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

    const youWon = win && (settings.mode === "friend" || win.player === (isOnline() ? mySide() : settings.humanSide));
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

    els.restartBtn.textContent = isGuest() && !online.connected ? "Reconnect" : "New round";
  }

  /* ---------- Turn flow ---------- */

  // Applies a move to the local state. Runs on this device for bot and
  // same-phone games, and on the host for online games.
  function play(index) {
    if (isOver() || state.board[index]) return;

    state.board[index] = state.turn;
    const win = getWinner(state.board);
    if (win) state.scores[win.player] += 1;
    else if (emptyCells(state.board).length === 0) state.scores.draw += 1;
    else state.turn = other(state.turn);

    render();
    sendState();
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
    // With two people the starting player alternates each round; vs bot, X always opens.
    if (settings.mode === "bot") {
      state.turn = "X";
    } else {
      state.turn = state.starter;
      state.starter = other(state.starter);
    }
    render();
    sendState();
    maybeBotMove();
  }

  function resetScores() {
    state.scores = { X: 0, O: 0, draw: 0 };
    render();
    sendState();
  }

  function resetGameState() {
    clearTimeout(state.botTimer);
    state.botTimer = null;
    state.scores = { X: 0, O: 0, draw: 0 };
    state.starter = "X";
    state.board = Array(9).fill(null);
    state.turn = "X";
  }

  function showScreen(screen) {
    els.setup.hidden = screen !== "setup";
    els.lobby.hidden = screen !== "lobby";
    els.joining.hidden = screen !== "joining";
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
    resetGameState();
    showScreen("game");
    newRound();
  }

  function showMenu() {
    leaveOnline();
    clearInviteFromUrl();
    clearTimeout(state.botTimer);
    state.botTimer = null;
    showScreen("setup");
  }

  /* ---------- Online play ---------- */

  const cleanName = (name) => String(name || "").trim().slice(0, 14);
  const myOnlineName = () => cleanName(els.onlineName.value) || "Friend";
  const inviteUrl = () => `${location.origin}${location.pathname}?join=${online.code}`;

  function randomCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += randomItem(CODE_ALPHABET.split(""));
    return code;
  }

  function showOnlineError(message) {
    els.onlineError.textContent = message;
    els.onlineError.hidden = !message;
  }

  function setBusy(busy) {
    els.startBtn.disabled = busy;
    els.joinBtn.disabled = busy;
    els.joinBtn.textContent = busy && online.role === "guest" ? "Joining…" : "Join";
  }

  function rememberName() {
    try { localStorage.setItem("ttt-name", els.onlineName.value.trim()); } catch { /* storage unavailable */ }
  }

  function peerAvailable() {
    if (typeof window.Peer === "function") return true;
    showOnlineError("Online play couldn't load. Check your internet connection and reload the page.");
    return false;
  }

  function sendState() {
    if (!isOnline() || online.role !== "host" || !online.conn || !online.conn.open) return;
    online.conn.send({
      type: "state",
      board: state.board,
      turn: state.turn,
      starter: state.starter,
      scores: state.scores,
      names: state.names,
    });
  }

  function send(message) {
    if (online.conn && online.conn.open) online.conn.send(message);
  }

  function leaveOnline() {
    clearTimeout(online.joinTimer);
    const { peer } = online;
    online.peer = null;
    online.conn = null;
    online.role = null;
    online.connected = false;
    if (peer) peer.destroy();
    setBusy(false);
  }

  function attachConnection(conn) {
    online.conn = conn;
    conn.on("data", (msg) => handleMessage(conn, msg));
    const onClose = () => {
      if (online.conn !== conn) return; // an older connection we already replaced
      online.conn = null;
      online.connected = false;
      if (!els.game.hidden) render();
    };
    conn.on("close", onClose);
    conn.on("error", onClose);
  }

  function handleMessage(conn, msg) {
    if (!msg || typeof msg !== "object" || conn !== online.conn) return;

    if (online.role === "host") {
      if (msg.type === "hello") {
        state.names.O = cleanName(msg.name) || "Friend";
        online.connected = true;
        showScreen("game");
        render();
        sendState();
      } else if (msg.type === "move") {
        const index = Number(msg.index);
        if (state.turn === "O" && Number.isInteger(index) && index >= 0 && index < 9) play(index);
      } else if (msg.type === "restart") {
        newRound();
      } else if (msg.type === "reset") {
        resetScores();
      }
      return;
    }

    if (msg.type === "state" && Array.isArray(msg.board) && msg.board.length === 9) {
      clearTimeout(online.joinTimer);
      state.board = msg.board.map((v) => (v === "X" || v === "O" ? v : null));
      state.turn = msg.turn === "O" ? "O" : "X";
      state.starter = msg.starter === "O" ? "O" : "X";
      const s = msg.scores || {};
      state.scores = { X: Number(s.X) || 0, O: Number(s.O) || 0, draw: Number(s.draw) || 0 };
      state.names = { X: cleanName(msg.names && msg.names.X) || "Friend", O: myOnlineName() };
      online.connected = true;
      setBusy(false);
      showScreen("game");
      render();
    } else if (msg.type === "full") {
      leaveOnline();
      showScreen("setup");
      showOnlineError("That game already has two players.");
    }
  }

  function createOnlineGame(attempt = 1) {
    if (!peerAvailable()) return;
    leaveOnline();
    showOnlineError("");
    rememberName();
    resetGameState();
    state.starter = "O"; // X opens the first round, then the opener alternates
    state.names = { X: myOnlineName(), O: "Friend" };
    online.role = "host";
    online.code = randomCode();
    setBusy(true);

    const peer = new Peer(PEER_PREFIX + online.code, PEER_OPTIONS);
    online.peer = peer;

    peer.on("open", () => {
      if (online.peer !== peer) return;
      setBusy(false);
      els.lobbyCode.textContent = online.code;
      els.lobbyStatus.textContent = "Waiting for your friend to join…";
      els.footerMode.textContent = `Online · code ${online.code}`;
      showScreen("lobby");
    });

    peer.on("connection", (conn) => {
      if (online.peer !== peer) return;
      if (online.conn && online.conn.open) {
        conn.on("open", () => {
          conn.send({ type: "full" });
          setTimeout(() => conn.close(), 500);
        });
        return;
      }
      attachConnection(conn); // first join, or the guest coming back after a drop
    });

    // Losing the matchmaking server doesn't end a game in progress; reconnect quietly.
    peer.on("disconnected", () => {
      if (online.peer === peer && !peer.destroyed) peer.reconnect();
    });

    peer.on("error", (err) => {
      if (online.peer !== peer) return;
      if (err.type === "unavailable-id" && attempt < 3) {
        createOnlineGame(attempt + 1);
        return;
      }
      if (online.connected) return; // the game itself is still running
      leaveOnline();
      showScreen("setup");
      showOnlineError(`Couldn't create an online game. Check your internet connection and try again. (${err.type || "unknown error"})`);
    });
  }

  function joinOnlineGame(rawCode) {
    if (!peerAvailable()) return;
    const code = String(rawCode || "").trim().toUpperCase();
    if (!new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`).test(code)) {
      showOnlineError(`Enter the ${CODE_LENGTH}-character code your friend shared.`);
      return;
    }

    const rejoining = !els.game.hidden;
    leaveOnline();
    showOnlineError("");
    rememberName();
    if (!rejoining) resetGameState();
    online.role = "guest";
    online.code = code;
    els.footerMode.textContent = `Online · code ${code}`;
    setBusy(true);
    if (rejoining) {
      els.status.textContent = "Reconnecting…";
    } else {
      els.joiningStatus.textContent = `Joining game ${code}…`;
      showScreen("joining");
    }

    const fail = (message) => {
      leaveOnline();
      showScreen("setup");
      settings.mode = "online";
      els.joinCode.value = code;
      showOnlineError(message);
    };

    const peer = new Peer(PEER_OPTIONS);
    online.peer = peer;

    online.joinTimer = setTimeout(() => {
      if (online.peer === peer && !online.connected) {
        fail("Couldn't connect to that game. Check the code and make sure your friend is still on the waiting screen.");
      }
    }, JOIN_TIMEOUT_MS);

    peer.on("open", () => {
      if (online.peer !== peer) return;
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      attachConnection(conn);
      conn.on("open", () => conn.send({ type: "hello", name: myOnlineName() }));
    });

    peer.on("error", (err) => {
      if (online.peer !== peer || online.connected) return;
      if (err.type === "peer-unavailable") {
        fail(`No game found with code ${code}. Check the code and make sure your friend is still on the waiting screen.`);
      } else {
        fail(`Couldn't connect. Check your internet connection and try again. (${err.type || "unknown error"})`);
      }
    });
  }

  async function shareInvite() {
    const url = inviteUrl();
    if (navigator.share) {
      try {
        await navigator.share({ title: "Tic Tac Toe", text: `Play tic tac toe with me! Code: ${online.code}`, url });
        return;
      } catch (err) {
        if (err && err.name === "AbortError") return; // the player closed the share sheet
      }
    }
    copyInvite();
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      els.copyBtn.textContent = "Copied!";
    } catch {
      els.copyBtn.textContent = "Copy failed";
      els.lobbyStatus.textContent = inviteUrl();
    }
    setTimeout(() => { els.copyBtn.textContent = "Copy link"; }, 1800);
  }

  /* ---------- Setup controls ---------- */

  function bindSegmented(attr, onChange) {
    const buttons = $$(`[data-${attr}]`);
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => selectSegment(attr, btn.dataset[attr]));
    });
    selectSegment.handlers[attr] = onChange;
  }

  function selectSegment(attr, value) {
    $$(`[data-${attr}]`).forEach((b) => {
      const on = b.dataset[attr] === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    });
    selectSegment.handlers[attr](value);
  }
  selectSegment.handlers = {};

  bindSegmented("mode", (mode) => {
    settings.mode = mode;
    els.difficultyField.hidden = mode !== "bot";
    els.sideField.hidden = mode !== "bot";
    els.namesField.hidden = mode !== "friend";
    els.onlineNameField.hidden = mode !== "online";
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
      if (isGuest()) send({ type: "move", index });
      else play(index);
    });
  });

  els.startBtn.addEventListener("click", () => {
    if (settings.mode === "online") createOnlineGame();
    else startLocalGame();
  });

  els.restartBtn.addEventListener("click", () => {
    if (!isGuest()) newRound();
    else if (online.connected) send({ type: "restart" });
    else joinOnlineGame(online.code);
  });

  $("#reset-score-btn").addEventListener("click", () => {
    if (isGuest()) send({ type: "reset" });
    else resetScores();
  });

  $("#menu-btn").addEventListener("click", showMenu);
  $("#cancel-btn").addEventListener("click", showMenu);
  els.joinBtn.addEventListener("click", () => joinOnlineGame(els.joinCode.value));
  els.shareBtn.addEventListener("click", shareInvite);
  els.copyBtn.addEventListener("click", copyInvite);

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

  try { els.onlineName.value = localStorage.getItem("ttt-name") || ""; } catch { /* storage unavailable */ }

  // Once a guest leaves, reloading the page shouldn't rejoin the old game.
  function clearInviteFromUrl() {
    if (!new URLSearchParams(location.search).has("join")) return;
    try { history.replaceState(null, "", location.pathname + location.hash); } catch { /* not allowed here */ }
  }

  $("#joining-cancel-btn").addEventListener("click", showMenu);

  // An invite link (?join=CODE) joins that game straight away.
  const invitedCode = (new URLSearchParams(location.search).get("join") || "").toUpperCase().slice(0, CODE_LENGTH);
  if (invitedCode) {
    selectSegment("mode", "online");
    els.joinCode.value = invitedCode;
    joinOnlineGame(invitedCode);
  }

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
