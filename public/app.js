const $ = (selector) => document.querySelector(selector);
const lobby = $("#lobby"), gameView = $("#game"), createButton = $("#createButton"), joinButton = $("#joinButton"), botButton = $("#botButton");
const roomCodeInput = $("#roomCode"), errorMessage = $("#errorMessage"), roomPanel = $("#roomPanel");
const readyButton = $("#readyButton"), startButton = $("#startButton");
const charactersEl = $("#characters"), playersListEl = $("#playersList"), canvas = $("#board"), ctx = canvas.getContext("2d");
const toastEl = $("#toast");

let socket, localPlayerId = null, roomCode = null, characterOptions = [], state = null, targets = new Map(), renderPositions = new Map();
let held = new Set(), toastTimer, previousEffects = new Set(), matchStarted = false;
let visualEffectsEnabled = localStorage.getItem("tr-visual-effects") !== "false";
let soundVolume = Number(localStorage.getItem("tr-sound-volume") ?? 65) / 100;
let musicEnabled = localStorage.getItem("tr-music") === "true";
let audioContext = null, masterGain = null, musicTimer = null, musicBeat = 0, previousTerritory = null, particles = [], claimFlashes = [];
let finalReplayTimer = null, finalReplayDone = false, activeReplay = null;
let dailyBoardEntries = [], dailyChallengeDay = "", dailyReplay = null;
const dailyPlayerKey = localStorage.getItem("tr-daily-player") || (() => { const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; localStorage.setItem("tr-daily-player", id); return id; })();
$("#dailyName").value = localStorage.getItem("tr-daily-name") || "Player";
const settingsDialog = $("#settingsDialog");
$("#volumeSetting").value = String(Math.round(soundVolume * 100));
$("#musicSetting").checked = musicEnabled;
$("#effectsSetting").checked = visualEffectsEnabled;
document.documentElement.classList.toggle("reduced-motion", !visualEffectsEnabled);

function enableAudio() {
  if (audioContext) { if (audioContext.state === "suspended") audioContext.resume(); if (matchStarted) startMusic(); return; }
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try { audioContext = new Audio(); masterGain = audioContext.createGain(); masterGain.gain.value = soundVolume; masterGain.connect(audioContext.destination); if (matchStarted) startMusic(); }
  catch { audioContext = null; }
}
document.addEventListener("pointerdown", enableAudio, { once: true });
document.addEventListener("keydown", enableAudio, { once: true });
function playSound(kind) {
  if (!audioContext || !masterGain || soundVolume <= 0) return;
  const presets = { claim: [480, 790, .2, "sine", .16], power: [620, 980, .15, "triangle", .15], penalty: [190, 75, .32, "sawtooth", .16], move: [280, 220, .05, "sine", .035] };
  const [from, to, duration, wave, level] = presets[kind] || presets.power;
  const osc = audioContext.createOscillator(), envelope = audioContext.createGain(), start = audioContext.currentTime;
  osc.type = wave; osc.frequency.setValueAtTime(from, start); osc.frequency.exponentialRampToValueAtTime(to, start + duration);
  envelope.gain.setValueAtTime(.0001, start); envelope.gain.exponentialRampToValueAtTime(level, start + .018); envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
  osc.connect(envelope); envelope.connect(masterGain); osc.start(start); osc.stop(start + duration + .025);
}
function startMusic() {
  if (!musicEnabled || !matchStarted || !audioContext || musicTimer) return;
  const notes = [196, 246.94, 293.66, 392, 329.63, 293.66, 220, 261.63];
  musicTimer = setInterval(() => {
    if (!audioContext || audioContext.state !== "running" || !matchStarted) return;
    const at = audioContext.currentTime, osc = audioContext.createOscillator(), gain = audioContext.createGain();
    osc.type = "triangle"; osc.frequency.value = notes[musicBeat++ % notes.length];
    gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(.025, at + .04); gain.gain.exponentialRampToValueAtTime(.0001, at + .42);
    osc.connect(gain); gain.connect(masterGain); osc.start(at); osc.stop(at + .45);
  }, 480);
}
function stopMusic() { if (musicTimer) clearInterval(musicTimer); musicTimer = null; }
$("#settingsButton").addEventListener("click", () => settingsDialog.showModal());
$("#volumeSetting").addEventListener("input", (event) => {
  soundVolume = Number(event.target.value) / 100; localStorage.setItem("tr-sound-volume", String(event.target.value));
  if (masterGain) masterGain.gain.setTargetAtTime(soundVolume, audioContext.currentTime, .025);
});
$("#musicSetting").addEventListener("change", (event) => {
  musicEnabled = event.target.checked; localStorage.setItem("tr-music", String(musicEnabled));
  if (musicEnabled) { enableAudio(); startMusic(); } else stopMusic();
});
$("#effectsSetting").addEventListener("change", (event) => {
  visualEffectsEnabled = event.target.checked; localStorage.setItem("tr-visual-effects", String(visualEffectsEnabled));
  document.documentElement.classList.toggle("reduced-motion", !visualEffectsEnabled);
  if (!visualEffectsEnabled) { particles = []; claimFlashes = []; $(".board-frame").classList.remove("impact"); }
});

function setConnection(text, status = "") {
  const el = $("#connectStatus"); el.textContent = text; el.className = `connect-status ${status}`;
}
function setError(message = "") { errorMessage.textContent = message; errorMessage.classList.toggle("hidden", !message); }
function send(type, data = {}) {
  if (socket?.readyState !== WebSocket.OPEN) return setError("Connection lost. Refresh the page to reconnect.");
  socket.send(JSON.stringify({ type, ...data }));
}
function connect() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${scheme}://${location.host}/ws`);
  socket.addEventListener("open", () => { setConnection("Connected to arena", "connected"); createButton.disabled = false; joinButton.disabled = false; botButton.disabled = false; $("#dailyButton").disabled = false; send("daily-leaderboard-request"); });
  socket.addEventListener("close", () => { setConnection("Disconnected from arena", "error"); createButton.disabled = true; joinButton.disabled = true; botButton.disabled = true; $("#dailyButton").disabled = true; });
  socket.addEventListener("error", () => setConnection("Could not reach arena", "error"));
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    handleMessage(message);
  });
}
function handleMessage(message) {
  if (message.type === "welcome") characterOptions = message.characters || [];
  if (message.type === "room-created" || message.type === "room-joined") {
    roomCode = message.code; localPlayerId = message.playerId; characterOptions = message.characters || characterOptions;
    $("#roomCodeLabel").textContent = roomCode; roomPanel.classList.remove("hidden"); setError(""); renderCharacters();
  }
  if (message.type === "lobby") renderLobby(message);
  if (message.type === "daily-leaderboard") renderDailyLeaderboard(message);
  if (message.type === "daily-replay") startDailyReplay(message);
  if (message.type === "match-start") {
    matchStarted = true; lobby.classList.add("hidden"); gameView.classList.remove("hidden");
    $("#resultOverlay").classList.add("hidden"); $("#rematchButton").disabled = false; $("#rematchButton").textContent = "Rematch";
    previousTerritory = null; previousEffects.clear(); finalReplayDone = false; clearTimeout(finalReplayTimer); activeReplay = null; dailyReplay = null; $("#replayOverlay").classList.add("hidden"); $("#skipReplay").textContent = "Skip"; $("#matchMode").textContent = message.mode === "daily" ? "DAILY CHALLENGE" : "1V1 ARENA"; startMusic();
  }
  if (message.type === "state") { state = message; updateTargets(); if (message.status === "finished" || message.finished || message.status === "disconnected") showResult(message); }
  if (message.type === "rematch-pending") {
    const button = $("#rematchButton");
    if (message.playerId === localPlayerId) { button.disabled = true; button.textContent = "Waiting for rival…"; }
    else { button.disabled = false; button.textContent = "Accept rematch"; }
  }
  if (message.type === "opponent-disconnected") { showToast(message.message, "penalty"); setTimeout(() => showResult(state || {}), 1200); }
  if (message.type === "error") setError(message.message || "Something went wrong.");
}
function renderCharacters() {
  charactersEl.replaceChildren();
  for (const character of characterOptions) {
    const button = document.createElement("button"); button.className = "character"; button.dataset.id = character.id;
    button.innerHTML = `<span class="character-figure" style="--char:${character.color}"></span>${character.name}`;
    button.addEventListener("click", () => { setError(""); send("select-character", { characterId: character.id }); });
    charactersEl.append(button);
  }
}
function renderLobby(message) {
  roomCode = message.code; $("#roomCodeLabel").textContent = roomCode || "-----";
  roomPanel.classList.remove("hidden");
  const me = message.players.find((p) => p.id === localPlayerId);
  const rival = message.players.find((p) => p.id !== localPlayerId);
  const isHost = message.hostPlayerId === localPlayerId;
  const taken = new Set(message.players.filter((p) => p.id !== localPlayerId).map((p) => p.character).filter(Boolean));
  for (const el of charactersEl.children) {
    const isTaken = taken.has(el.dataset.id);
    el.classList.toggle("selected", el.dataset.id === me?.character);
    el.disabled = isTaken;
    el.title = isTaken ? "Already selected by another player" : "Choose this character";
  }
  playersListEl.innerHTML = message.players.map((p) => {
    const char = characterOptions.find((c) => c.id === p.character);
    const status = p.bot ? "READY" : p.ready ? "READY" : char ? "SELECTED" : "CHOOSING";
    return `<div class="player-row"><span class="mini-dot" style="--color:${p.color || "#697487"}"></span>${escapeHtml(p.name)}<small>${escapeHtml(char?.name || status)} · ${status}</small></div>`;
  }).join("");
  const versusBot = message.players.some((p) => p.bot);
  readyButton.classList.toggle("hidden", !message.hostPlayerId || isHost || versusBot);
  readyButton.disabled = !me?.character;
  readyButton.textContent = me?.ready ? "Ready ✓" : "Ready";
  startButton.classList.toggle("hidden", !message.hostPlayerId || !isHost || versusBot);
  startButton.disabled = !(me?.character && message.players.length === 2 && rival?.character && rival.ready);
  $("#readyHint").textContent = versusBot
    ? "Choose a character to start against Rush Bot."
    : message.players.length < 2
      ? "Waiting for an opponent to join…"
      : !me?.character
        ? "Choose your character to continue."
        : isHost
          ? rival?.ready ? "Your opponent is ready. Start the match when you are." : "Waiting for your opponent to choose a character and get ready…"
          : me.ready ? "You’re ready. Waiting for the host to start the match…" : "Character selected. Press Ready when you’re ready to play.";
}
function escapeHtml(value) { const span = document.createElement("span"); span.textContent = value; return span.innerHTML; }

function renderDailyLeaderboard(message) {
  dailyChallengeDay = message.day;
  dailyBoardEntries = message.entries || [];
  $("#dailyDate").textContent = message.day || "TODAY";
  const board = $("#dailyLeaderboard");
  if (!dailyBoardEntries.length) { board.innerHTML = "<small>Be the first to post today’s score.</small>"; return; }
  board.innerHTML = dailyBoardEntries.map((entry) => `<div class="daily-row"><span class="daily-rank">${String(entry.rank).padStart(2, "0")}</span><b>${escapeHtml(entry.name)}</b><strong>${entry.score}</strong><button class="button quiet watch-daily" data-rank="${entry.rank}">Watch</button></div>`).join("");
}

function startDailyReplay(message) {
  const replay = message.replay;
  if (!replay?.frames?.length) return setError("That run has no replay data.");
  dailyReplay = { ...message, startedAt: performance.now(), frameIndex: 0, eventIndex: 0, complete: false };
  const players = replay.players.map((p, index) => ({
    id: `daily-replay-${index}`, name: p.name, character: p.character, color: p.color, base: p.base,
    x: (p.base.x + .5) * replay.map.cellSize, y: (p.base.y + .5) * replay.map.cellSize,
    territory: new Set(replay.initialTerritories[index]), trail: [], territoryPercent: 0,
    stats: { crownPoints: 0 }, shield: false,
  }));
  state = { status: "replay", map: replay.map, players, powerUps: [], theme: replay.theme, crown: null, remainingMs: 180_000, effects: [] };
  const paintable = replay.map.width * replay.map.height - replay.map.walls.flat().filter(Boolean).length;
  for (const player of players) player.territoryPercent = paintable ? player.territory.size / paintable * 100 : 0;
  targets.clear(); renderPositions.clear();
  players.forEach((p) => { targets.set(p.id, { x: p.x, y: p.y }); renderPositions.set(p.id, { x: p.x, y: p.y }); });
  $("#lobby").classList.add("hidden"); gameView.classList.remove("hidden");
  $("#resultOverlay").classList.add("hidden"); $("#replayTitle").textContent = `TOP DAILY RUN · ${message.entry.name} · ${message.entry.score} PTS`;
  $("#replayOverlay").classList.remove("hidden"); $("#skipReplay").textContent = "Exit replay"; $("#matchMode").textContent = "TOP DAILY RUN";
  $("#arenaTheme").textContent = (replay.theme?.name || "DAILY ARENA").toUpperCase();
  previousTerritory = null;
}

function advanceDailyReplay() {
  if (!dailyReplay || !state?.players) return;
  const replay = dailyReplay.replay, elapsed = Math.min(180_000, performance.now() - dailyReplay.startedAt);
  while (dailyReplay.eventIndex < replay.events.length && replay.events[dailyReplay.eventIndex].t <= elapsed) {
    const event = replay.events[dailyReplay.eventIndex++];
    if (event.type === "crown") { state.crown = { active: true, cell: event.cell, ownerId: event.ownerIndex >= 0 ? state.players[event.ownerIndex].id : null, moveAt: null }; continue; }
    const player = state.players[event.index];
    for (const cell of event.removed) player.territory.delete(cell);
    for (const cell of event.added) player.territory.add(cell);
  }
  while (dailyReplay.frameIndex + 1 < replay.frames.length && replay.frames[dailyReplay.frameIndex + 1].t <= elapsed) dailyReplay.frameIndex++;
  const a = replay.frames[dailyReplay.frameIndex], b = replay.frames[Math.min(dailyReplay.frameIndex + 1, replay.frames.length - 1)];
  const fraction = a === b ? 0 : Math.max(0, Math.min(1, (elapsed - a.t) / Math.max(1, b.t - a.t)));
  state.crown = a.crown ? { active: true, cell: a.crown.cell, ownerId: a.crown.ownerIndex >= 0 ? state.players[a.crown.ownerIndex].id : null, moveAt: a.crown.moveInMs ? Date.now() + a.crown.moveInMs : null } : null;
  state.players.forEach((player, index) => {
    const pa = a.positions[index], pb = b.positions[index];
    player.x = pa[0] + (pb[0] - pa[0]) * fraction; player.y = pa[1] + (pb[1] - pa[1]) * fraction;
    const paintable = state.map.width * state.map.height - state.map.walls.flat().filter(Boolean).length;
    player.territoryPercent = paintable ? player.territory.size / paintable * 100 : 0;
    player.stats.crownPoints = a.crown?.points[index] || 0;
    targets.set(player.id, { x: player.x, y: player.y });
    const card = $(`#score${index}`); if (card) { card.querySelector(".score-name").textContent = player.name; card.querySelector(".score-value").textContent = `${player.territoryPercent.toFixed(1)}%`; card.querySelector(".score-crown").textContent = `♛ ${player.stats.crownPoints}`; }
  });
  state.remainingMs = 180_000 - elapsed;
  $("#timer").textContent = formatTime(state.remainingMs);
  $("#crownStatus").textContent = state.crown ? "CROWN REPLAY" : "CROWN ACTIVATES AT 1:30";
  if (elapsed >= 180_000 && !dailyReplay.complete) { dailyReplay.complete = true; showToast("TOP RUN COMPLETE · exit replay to return", "claim"); }
}

function exitDailyReplay() {
  dailyReplay = null; state = null; targets.clear(); renderPositions.clear();
  $("#replayOverlay").classList.add("hidden"); $("#skipReplay").textContent = "Skip"; $("#matchMode").textContent = "1V1 ARENA";
  gameView.classList.add("hidden"); lobby.classList.remove("hidden"); send("daily-leaderboard-request");
}

createButton.addEventListener("click", () => { setError(""); send("create-room", { name: "Player" }); });
botButton.addEventListener("click", () => { setError(""); send("play-bot", { name: "Player" }); });
readyButton.addEventListener("click", () => { setError(""); send("player-ready", { ready: true }); });
startButton.addEventListener("click", () => { setError(""); send("start-match"); });
$("#dailyName").addEventListener("input", (event) => localStorage.setItem("tr-daily-name", event.target.value.slice(0, 18)));
$("#dailyButton").addEventListener("click", () => {
  const name = $("#dailyName").value.trim().slice(0, 18) || "Player";
  localStorage.setItem("tr-daily-name", name); setError("");
  send("daily-challenge", { name, playerKey: dailyPlayerKey });
});
$("#dailyLeaderboard").addEventListener("click", (event) => {
  const button = event.target.closest(".watch-daily");
  if (button) send("daily-replay-request", { day: dailyChallengeDay, rank: Number(button.dataset.rank) });
});
joinButton.addEventListener("click", () => {
  setError(""); const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length !== 5) return setError("Enter the five-character room code.");
  send("join-room", { code, name: "Player" });
});
roomCodeInput.addEventListener("input", () => { roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); });
roomCodeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") joinButton.click(); });

function updateTargets() {
  if (!state?.players) return;
  trackTerritoryChanges();
  state.players.forEach((player, index) => {
    targets.set(player.id, { x: player.x, y: player.y });
    if (!renderPositions.has(player.id)) renderPositions.set(player.id, { x: player.x, y: player.y });
    const card = $(`#score${index}`);
    if (card) {
      card.style.setProperty("--player-color", player.color);
      card.querySelector(".score-name").textContent = player.name;
      card.querySelector(".score-value").textContent = `${player.territoryPercent.toFixed(1)}%`;
      card.querySelector(".score-info small").textContent = player.id === localPlayerId ? "YOU" : "OPPONENT";
      card.querySelector(".score-crown").textContent = `♛ ${player.stats?.crownPoints || 0}`;
    }
  });
  $("#timer").textContent = formatTime(state.remainingMs);
  const countdown = Math.ceil((state.countdownMs || 0) / 1000);
  $("#countdownNumber").textContent = String(countdown);
  $("#countdownOverlay").classList.toggle("hidden", countdown <= 0 || state.finished);
  $("#arenaTheme").textContent = (state.theme?.name || "Neon Circuit").toUpperCase();
  document.documentElement.style.setProperty("--arena-accent", state.theme?.accent || "#57e389");
  const crownStatus = $("#crownStatus"), crown = state.crown;
  if (!crown?.active) crownStatus.textContent = "CROWN ACTIVATES AT 1:30";
  else {
    const controller = state.players.find((player) => player.id === crown.ownerId);
    const held = controller ? (controller.id === localPlayerId ? "HELD BY YOU" : `HELD BY ${controller.name.toUpperCase()}`) : "UNCLAIMED";
    crownStatus.textContent = `${held} · ${crown.moveAt ? `${Math.ceil(Math.max(0, crown.moveAt - Date.now()) / 1000)}s TO MOVE` : "FINAL BEACON"}`;
  }
  const active = state.players.filter((p) => p.shield || p.speedActive || p.freezeActive);
  $("#powerStatus").textContent = active.length ? active.map((p) => `${p.id === localPlayerId ? "YOU" : "RIVAL"}: ${[p.shield && "SHIELD", p.speedActive && "SPEED", p.freezeActive && "FROZEN"].filter(Boolean).join(" + ")}`).join("  •  ") : "NO ACTIVE POWER-UPS";
  for (const effect of state.effects || []) {
    const signature = `${effect.type}:${effect.playerId}:${effect.cells || ""}:${state.startedAt}:${state.remainingMs}`;
    if (previousEffects.has(signature)) continue;
    previousEffects.add(signature);
    if (effect.type === "claim") { const breach = effect.breached ? ` · BREACH +${effect.breached}` : ""; showToast(effect.playerId === localPlayerId ? `Territory claimed · +${effect.cells} cells${breach}` : `Opponent claimed territory${breach}`, "claim"); playSound("claim"); }
    if (effect.type === "crown-active") { showToast("THE CROWN IS LIVE · claim the gold beacon", "power"); playSound("power"); }
    if (effect.type === "crown-moved") { showToast("THE CROWN MOVED · race to its new beacon", "power"); playSound("power"); }
    if (effect.type === "crown-moving") { showToast("CROWN SHIFTS IN 5 SECONDS · get ready", "power"); playSound("power"); }
    if (effect.type === "crown-control") showToast(effect.playerId === localPlayerId ? "CROWN CLAIMED · hold for points" : "Rival claimed the Crown", "power");
    if (effect.type === "crown-point") showToast(`${effect.playerId === localPlayerId ? "Crown secured" : "Rival scored"} · ${effect.points} point${effect.points === 1 ? "" : "s"}`, "power");
    if (effect.type === "penalty") {
      showToast(effect.playerId === localPlayerId ? "Trail cut! Territory lost — back to base" : "Opponent caught · territory lost", "penalty"); playSound("penalty");
      if (visualEffectsEnabled) { const frame = $(".board-frame"); frame.classList.remove("impact"); void frame.offsetWidth; frame.classList.add("impact"); setTimeout(() => frame.classList.remove("impact"), 300); }
      const caught = state.players.find((player) => player.id === effect.playerId);
      if (caught) spawnBurst(caught.x, caught.y, "#ff6e91", 18);
    }
    if (effect.type === "shield-block") { showToast(effect.playerId === localPlayerId ? "Shield absorbed the hit" : "Opponent's shield blocked the hit", "power"); playSound("power"); }
    if (effect.type === "power-collect") {
      showToast(`${effect.playerId === localPlayerId ? "You collected" : "Opponent collected"} ${powerName(effect.powerType)}`, "power"); playSound("power");
      const collector = state.players.find((player) => player.id === effect.playerId);
      const colors = { speed: "#ffd45c", shield: "#70d8ff", freeze: "#9ba8ff", bonus: "#ff83ce" };
      if (collector) spawnBurst(collector.x, collector.y, colors[effect.powerType] || "#fff", 15);
    }
  }
}
function trackTerritoryChanges() {
  const next = new Map();
  for (const player of state.players) for (const packed of player.territory) next.set(`${player.id}|${packed}`, player);
  if (previousTerritory) {
    const added = [...next].filter(([key]) => !previousTerritory.has(key));
    if (visualEffectsEnabled && added.length) {
      const stride = Math.max(1, Math.ceil(added.length / 90));
      added.filter((_, index) => index % stride === 0).forEach(([entry, player], index) => {
        const packed = entry.slice(player.id.length + 1);
        const [x, y] = packed.split(",").map(Number); claimFlashes.push({ x, y, color: player.color, startedAt: performance.now() + index * 3 });
      });
      claimFlashes = claimFlashes.slice(-160);
    }
  }
  previousTerritory = new Set(next.keys());
}
function spawnBurst(x, y, color, count) {
  if (!visualEffectsEnabled || !state?.map) return;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2, speed = 24 + Math.random() * 75;
    particles.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, color, startedAt: performance.now(), life: 430 + Math.random() * 250 });
  }
  particles = particles.slice(-160);
}
function powerName(type) { return ({ speed: "Speed Boost", shield: "Shield", freeze: "Trail-Freeze", bonus: "Territory Bonus" })[type] || "Power-up"; }
function formatTime(ms) { const sec = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`; }
function showToast(text, kind = "") { toastEl.textContent = text; toastEl.className = `toast visible ${kind}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.className = "toast", 2300); }

function showResult(message) {
  if (finalReplayDone) return;
  const highlights = state?.highlights || [];
  if ((message.finished || message.status === "finished") && highlights.length && !finalReplayDone) {
    finalReplayDone = true;
    $("#resultOverlay").classList.add("hidden");
    playFinalReplay(highlights, 0, message);
    return;
  }
  finalReplayDone = true;
  displayResult(message);
}
function playFinalReplay(items, index, message) {
  if (index >= items.length) { activeReplay = null; $("#replayOverlay").classList.add("hidden"); displayResult(message); return; }
  const item = items[index];
  activeReplay = { ...item, startedAt: performance.now(), duration: 2300 };
  $("#replayTitle").textContent = item.kind === "capture" ? `${item.name} · Biggest Capture · ${item.score} cells` : `${item.name} · Longest Trail Cut · ${item.score} cells`;
  $("#replayOverlay").classList.remove("hidden");
  finalReplayTimer = setTimeout(() => playFinalReplay(items, index + 1, message), activeReplay.duration);
}
function displayResult(message) {
  const winnerId = message.winnerId ?? state?.winnerId;
  const draw = message.draw ?? state?.draw;
  const winner = state?.players?.find((p) => p.id === winnerId);
  $("#resultTitle").textContent = draw ? "It’s a draw" : winnerId === localPlayerId ? "You win!" : winner ? `${winner.name} wins` : "Match ended";
  const scores = state?.players?.map((p) => `${p.name} ${p.matchScore ?? p.territoryCells ?? 0}`).join(" · ") || "";
  $("#resultText").textContent = message.message || `Final score ${scores} · land cells + 4 per Crown point`;
  $("#resultStats").innerHTML = (state?.players || []).map((p) => {
    const stats = p.stats || {};
    return `<div class="result-stat" style="--stat-color:${p.color}"><span>${escapeHtml(p.name)}${p.id === localPlayerId ? " · YOU" : ""}</span><strong>${p.matchScore ?? p.territoryCells ?? 0} PTS</strong><small>${p.territoryPercent.toFixed(1)}% territory · ${stats.crownPoints || 0} Crown points · ${stats.cellsClaimed || 0} cells captured · ${stats.trailCuts || 0} cuts · ${stats.powerUpsCollected || 0} pickups</small></div>`;
  }).join("");
  const unavailable = message.status === "disconnected" || state?.status === "disconnected";
  $("#rematchButton").classList.toggle("hidden", unavailable);
  $("#rematchButton").disabled = unavailable;
  $("#resultOverlay").classList.remove("hidden");
  matchStarted = false; stopMusic();
}
$("#skipReplay").addEventListener("click", () => { if (dailyReplay) return exitDailyReplay(); clearTimeout(finalReplayTimer); activeReplay = null; $("#replayOverlay").classList.add("hidden"); if (state) displayResult({ winnerId: state.winnerId, draw: state.draw, status: "finished" }); });
function backToLobby() { send("leave-room"); location.reload(); }
$("#leaveButton").addEventListener("click", backToLobby);
$("#backButton").addEventListener("click", backToLobby);
$("#rematchButton").addEventListener("click", () => send("rematch"));

function keyDirection(event) {
  const k = event.key.toLowerCase();
  return ({ w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" })[k];
}
function sendInput() { if (matchStarted) send("input", { input: { up: held.has("up"), down: held.has("down"), left: held.has("left"), right: held.has("right") } }); }
window.addEventListener("keydown", (event) => { const dir = keyDirection(event); if (!dir) return; event.preventDefault(); if (!held.has(dir)) { held.add(dir); playSound("move"); sendInput(); } });
window.addEventListener("keyup", (event) => { const dir = keyDirection(event); if (!dir) return; held.delete(dir); sendInput(); });
window.addEventListener("blur", () => { held.clear(); sendInput(); });

function parseCell(k) { return k.split(",").map(Number); }
function colorAlpha(color, alpha) {
  const value = color.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
function roundedRect(x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}
function drawAvatar(player, x, y, time, cellSize) {
  const size = 8.2, bob = Math.sin(time / 175 + (player.id.charCodeAt(0) || 0)) * 1.1;
  y += bob;
  ctx.save();
  ctx.fillStyle = "#05091188"; ctx.beginPath(); ctx.ellipse(x, y + 8, 8, 3.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.shadowColor = colorAlpha(player.color, .75); ctx.shadowBlur = 14;
  ctx.beginPath(); ctx.arc(x, y, size + 2.8, 0, Math.PI * 2); ctx.fillStyle = "#0a111b"; ctx.fill();
  const body = ctx.createRadialGradient(x - 3, y - 4, 1, x, y, size + 2);
  body.addColorStop(0, "#ffffff"); body.addColorStop(.18, player.color); body.addColorStop(1, colorAlpha(player.color, .7));
  ctx.shadowBlur = 0;
  const shape = player.character || "comet";
  ctx.fillStyle = body; ctx.strokeStyle = "#f5fbff"; ctx.lineWidth = 1.2;
  ctx.beginPath();
  if (shape === "blaze") { ctx.moveTo(x, y - size - 1); ctx.lineTo(x + size, y + size - 2); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y + size - 2); ctx.closePath(); }
  else if (shape === "violet") { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 6; const px = x + Math.cos(a) * size; const py = y + Math.sin(a) * size; if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); }
  else if (shape === "sunny") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? size * .72 : size; const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; if (!i) ctx.moveTo(px, py); else ctx.lineTo(px, py); } ctx.closePath(); }
  else if (shape === "berry") roundedRect(x - size, y - size, size * 2, size * 2, 5);
  else if (shape === "moss") { ctx.ellipse(x, y, size, size * .82, -.12, 0, Math.PI * 2); }
  else { ctx.arc(x, y, size, 0, Math.PI * 2); }
  ctx.fill(); ctx.stroke();
  // Same-sized face details keep each cosmetic shape equally readable in play.
  ctx.fillStyle = "#12202b"; ctx.beginPath(); ctx.arc(x - 2.5, y - .5, 1.05, 0, Math.PI * 2); ctx.arc(x + 2.5, y - .5, 1.05, 0, Math.PI * 2); ctx.fill();
  if (shape === "comet") {
    ctx.strokeStyle = colorAlpha(player.color, .8); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x - 7, y + 5); ctx.lineTo(x - 12, y + 9); ctx.moveTo(x - 8, y + 1); ctx.lineTo(x - 14, y + 3); ctx.stroke();
  } else if (shape === "moss") {
    ctx.fillStyle = "#d5ffd0"; ctx.beginPath(); ctx.ellipse(x + 1, y - 7, 2.1, 4, -.7, 0, Math.PI * 2); ctx.fill();
  } else if (shape === "sunny") {
    ctx.strokeStyle = "#fff1ae"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, 11, time / 800, time / 800 + Math.PI * .65); ctx.stroke();
  }
  ctx.strokeStyle = colorAlpha(player.color, .8); ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, size + 5, time / 1200, time / 1200 + Math.PI * 1.55); ctx.stroke();
  if (player.shield) {
    ctx.beginPath(); ctx.arc(x, y, size + 8, 0, Math.PI * 2); ctx.strokeStyle = "#84e6ff"; ctx.lineWidth = 1.8; ctx.shadowColor = "#59dfff"; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
  }
  ctx.restore();
}
function draw(time = 0) {
  requestAnimationFrame(draw);
  advanceDailyReplay();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state?.map) { ctx.fillStyle = "#121925"; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
  const motionTime = visualEffectsEnabled ? time : 0;
  const { width, height, cellSize, walls } = state.map;
  const themes = {
    neon: { floor: ["#1a2a37", "#101923"], wall: ["#526176", "#273345"], accent: "#56edc0" },
    copper: { floor: ["#30251f", "#171917"], wall: ["#74604e", "#39302a"], accent: "#ffb45f" },
    frost: { floor: ["#1c3040", "#101b2b"], wall: ["#637b91", "#2d435b"], accent: "#8eeaff" },
  };
  const theme = themes[state.theme?.id] || themes.neon;
  const floorMid = { neon: "#172a32", copper: "#241f1d", frost: "#192b39" }[state.theme?.id] || "#172a32";
  const floor = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  floor.addColorStop(0, theme.floor[0]); floor.addColorStop(.48, floorMid); floor.addColorStop(1, theme.floor[1]);
  ctx.fillStyle = floor; ctx.fillRect(0, 0, canvas.width, canvas.height);
  // Quiet floor markings add texture without competing with territory colors.
  ctx.strokeStyle = colorAlpha(theme.accent, .045); ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 2) { ctx.beginPath(); ctx.moveTo(x * cellSize, 0); ctx.lineTo(x * cellSize, height * cellSize); ctx.stroke(); }
  for (let y = 0; y <= height; y += 2) { ctx.beginPath(); ctx.moveTo(0, y * cellSize); ctx.lineTo(width * cellSize, y * cellSize); ctx.stroke(); }
  const players = state.players || [];
  const ownerByCell = new Map();
  for (const player of players) for (const packed of player.territory) ownerByCell.set(packed, player);
  for (const [packed, player] of ownerByCell) {
    const [x, y] = parseCell(packed), px = x * cellSize, py = y * cellSize;
    const shade = .20 + ((x * 17 + y * 31) % 5) * .012;
    roundedRect(px + 1, py + 1, cellSize - 2, cellSize - 2, 3);
    ctx.fillStyle = colorAlpha(player.color, shade); ctx.fill();
    roundedRect(px + 2, py + 2, cellSize - 4, 2, 1);
    ctx.fillStyle = colorAlpha(player.color, .22); ctx.fill();
    if ((x * 17 + y * 29) % 11 === 0) {
      ctx.fillStyle = colorAlpha(player.color, .14);
      ctx.fillRect(px + cellSize - 6, py + cellSize - 6, 2, 2);
      ctx.fillRect(px + cellSize - 10, py + cellSize - 6, 2, 2);
    }
  }
  // Trace the perimeter of each painted region as a continuous luminous edge.
  for (const player of players) {
    ctx.beginPath();
    for (const packed of player.territory) {
      const [x, y] = parseCell(packed), px = x * cellSize, py = y * cellSize;
      if (ownerByCell.get(`${x},${y - 1}`) !== player) { ctx.moveTo(px, py); ctx.lineTo(px + cellSize, py); }
      if (ownerByCell.get(`${x + 1},${y}`) !== player) { ctx.moveTo(px + cellSize, py); ctx.lineTo(px + cellSize, py + cellSize); }
      if (ownerByCell.get(`${x},${y + 1}`) !== player) { ctx.moveTo(px, py + cellSize); ctx.lineTo(px + cellSize, py + cellSize); }
      if (ownerByCell.get(`${x - 1},${y}`) !== player) { ctx.moveTo(px, py); ctx.lineTo(px, py + cellSize); }
    }
    ctx.strokeStyle = colorAlpha(player.color, .72); ctx.lineWidth = 1.5; ctx.shadowColor = colorAlpha(player.color, .55); ctx.shadowBlur = 5; ctx.stroke(); ctx.shadowBlur = 0;
  }
  // Raised, beveled blocks make the maze read as a physical board.
  const block = ctx.createLinearGradient(0, 0, cellSize, cellSize);
  block.addColorStop(0, theme.wall[0]); block.addColorStop(.18, "#344357"); block.addColorStop(1, theme.wall[1]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (walls[y][x]) {
    const px = x * cellSize, py = y * cellSize;
    ctx.fillStyle = "#0a1018"; ctx.fillRect(px, py + 2, cellSize, cellSize);
    roundedRect(px + 1, py + 1, cellSize - 2, cellSize - 3, 3); ctx.fillStyle = block; ctx.fill();
    ctx.fillStyle = "#d6e5f01b"; ctx.fillRect(px + 3, py + 3, cellSize - 6, 1.5);
    ctx.fillStyle = "#0a101833"; ctx.fillRect(px + 3, py + cellSize - 5, cellSize - 6, 2);
  }
  const powerColors = { speed: "#ffd45c", shield: "#70d8ff", freeze: "#9ba8ff", bonus: "#ff83ce" };
  const glyphs = { speed: "↯", shield: "◇", freeze: "❄", bonus: "+" };
  for (const power of state.powerUps || []) {
    const px = (power.x + .5) * cellSize, py = (power.y + .5) * cellSize + (visualEffectsEnabled ? Math.sin(motionTime / 190 + power.x) * 2.2 : 0);
    const color = powerColors[power.type] || "#fff";
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 17;
    ctx.beginPath(); ctx.arc(px, py, 9 + Math.sin(time / 230) * .7, 0, Math.PI * 2); ctx.fillStyle = colorAlpha(color, .2); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = "#14202b"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(glyphs[power.type] || "•", px, py + .5);
    ctx.restore();
  }
  for (const player of players) {
    if (player.trail?.length) {
      const pulse = visualEffectsEnabled ? .72 + Math.sin(motionTime / 100) * .12 : .78;
      ctx.save(); ctx.shadowColor = player.color; ctx.shadowBlur = 12;
      for (const packed of player.trail) {
        const [x, y] = parseCell(packed), px = x * cellSize, py = y * cellSize;
        roundedRect(px + 4, py + 4, cellSize - 8, cellSize - 8, 4); ctx.fillStyle = colorAlpha(player.color, pulse); ctx.fill();
        roundedRect(px + 6, py + 6, cellSize - 12, 2, 1); ctx.fillStyle = "#ffffff88"; ctx.fill();
      }
      ctx.restore();
    }
    const pos = interpolate(player.id, player.x, player.y);
    drawAvatar(player, pos.x, pos.y, motionTime, cellSize);
  }
  if (state.crown?.active && state.crown.cell) {
    const { x, y } = state.crown.cell, px = (x + .5) * cellSize, py = (y + .5) * cellSize;
    const holder = players.find((player) => player.id === state.crown.ownerId);
    const color = holder?.color || "#ffd45c";
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 18;
    ctx.beginPath(); ctx.arc(px, py, 12 + (visualEffectsEnabled ? Math.sin(time / 180) * 1.5 : 0), 0, Math.PI * 2); ctx.fillStyle = colorAlpha(color, .22); ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fillStyle = "#101722"; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
    ctx.shadowBlur = 0; ctx.fillStyle = color; ctx.font = "bold 14px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("♛", px, py + .5); ctx.restore();
  }
  if (visualEffectsEnabled) {
    const now = performance.now();
    claimFlashes = claimFlashes.filter((flash) => now - flash.startedAt < 650);
    for (const flash of claimFlashes) {
      const progress = Math.max(0, Math.min(1, (now - flash.startedAt) / 650));
      const px = (flash.x + .5) * cellSize, py = (flash.y + .5) * cellSize;
      ctx.beginPath(); ctx.arc(px, py, 4 + progress * 15, 0, Math.PI * 2); ctx.strokeStyle = colorAlpha(flash.color, (1 - progress) * .8); ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = colorAlpha(flash.color, (1 - progress) * .2); ctx.fillRect(px - cellSize / 2, py - cellSize / 2, cellSize, cellSize);
    }
    particles = particles.filter((particle) => now - particle.startedAt < particle.life);
    for (const particle of particles) {
      const age = (now - particle.startedAt) / 1000, progress = (now - particle.startedAt) / particle.life;
      ctx.globalAlpha = 1 - progress; ctx.beginPath(); ctx.arc(particle.x + particle.vx * age, particle.y + particle.vy * age, 1.5 + (1 - progress) * 2, 0, Math.PI * 2); ctx.fillStyle = particle.color; ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  if (activeReplay) {
    const progress = Math.max(0, Math.min(1, (performance.now() - activeReplay.startedAt) / activeReplay.duration));
    const color = activeReplay.color || "#57e389";
    if (activeReplay.kind === "capture" && progress > .55) {
      ctx.globalAlpha = Math.min(.46, (progress - .55) * 1.1);
      for (const packed of activeReplay.cells || []) { const [x, y] = parseCell(packed); ctx.fillStyle = color; ctx.fillRect(x * cellSize + 2, y * cellSize + 2, cellSize - 4, cellSize - 4); }
      ctx.globalAlpha = 1;
    }
    const trail = activeReplay.trail || [];
    const count = Math.max(1, Math.ceil(trail.length * Math.min(1, progress * 1.45)));
    ctx.save(); ctx.strokeStyle = activeReplay.kind === "cut" ? "#ff627d" : color; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 18; ctx.beginPath();
    trail.slice(0, count).forEach((packed, index) => { const [x, y] = parseCell(packed); const px = (x + .5) * cellSize, py = (y + .5) * cellSize; if (!index) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke(); ctx.restore();
    if (activeReplay.hitCell) { const [x, y] = parseCell(activeReplay.hitCell); ctx.beginPath(); ctx.arc((x + .5) * cellSize, (y + .5) * cellSize, 8 + progress * 12, 0, Math.PI * 2); ctx.strokeStyle = `rgba(255,98,125,${1 - progress})`; ctx.lineWidth = 3; ctx.stroke(); }
  }
  // Soft vignette focuses attention on the playable maze.
  const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 170, canvas.width / 2, canvas.height / 2, 680);
  vignette.addColorStop(0, "#050b1400"); vignette.addColorStop(1, "#050b1433");
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function interpolate(id, x, y) {
  const target = targets.get(id) || { x, y };
  const rendered = renderPositions.get(id) || { x: target.x, y: target.y };
  rendered.x += (target.x - rendered.x) * .34;
  rendered.y += (target.y - rendered.y) * .34;
  renderPositions.set(id, rendered);
  return rendered;
}
requestAnimationFrame(draw);
connect();


// Show room code and character selection in a focused, dismissible lobby popup.
const roomStatusButton = document.createElement("button");
roomStatusButton.type = "button";
roomStatusButton.className = "button secondary hidden room-status-button";
roomStatusButton.setAttribute("aria-label", "Show room code and character selection");
$(".room-actions").append(roomStatusButton);
const roomPanelTop = document.createElement("div");
roomPanelTop.className = "room-panel-top";
roomPanelTop.innerHTML = '<div><span class="eyebrow">ROOM LOBBY</span><h2>Invite a rival</h2></div>';
const minimizeRoomButton = document.createElement("button");
minimizeRoomButton.type = "button";
minimizeRoomButton.className = "button quiet";
minimizeRoomButton.textContent = "Minimize";
minimizeRoomButton.setAttribute("aria-label", "Minimize room lobby");
roomPanelTop.append(minimizeRoomButton);
roomPanel.prepend(roomPanelTop);
const roomCodeBlock = $("#roomCodeLabel").parentElement;
roomCodeBlock.classList.add("room-code-block");
const copyRoomCodeButton = document.createElement("button");
copyRoomCodeButton.type = "button";
copyRoomCodeButton.className = "button quiet copy-room-code";
copyRoomCodeButton.textContent = "COPY CODE";
copyRoomCodeButton.setAttribute("aria-label", "Copy room code");
$("#roomCodeLabel").insertAdjacentElement("afterend", copyRoomCodeButton);
let roomPopupMinimized = false;
function minimizeRoomPopup() {
  roomPopupMinimized = true;
  roomPanel.classList.add("hidden");
  if (roomCode && !matchStarted) {
    roomStatusButton.textContent = `ROOM ${roomCode} · OPEN`;
    roomStatusButton.classList.remove("hidden");
  }
}
minimizeRoomButton.addEventListener("click", minimizeRoomPopup);
roomStatusButton.addEventListener("click", () => {
  roomPopupMinimized = false;
  roomPanel.classList.remove("hidden");
  roomStatusButton.classList.add("hidden");
});
copyRoomCodeButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode || $("#roomCodeLabel").textContent);
    copyRoomCodeButton.textContent = "COPIED!";
    setTimeout(() => { copyRoomCodeButton.textContent = "COPY CODE"; }, 1400);
  } catch {
    copyRoomCodeButton.textContent = "SELECT CODE";
  }
});
socket.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }
  if (message.type === "room-created" || message.type === "room-joined") {
    roomPopupMinimized = false;
    if (message.daily) {
      roomPanel.classList.add("hidden");
      roomStatusButton.classList.add("hidden");
    } else {
      roomStatusButton.textContent = `ROOM ${message.code} · OPEN`;
      roomStatusButton.classList.add("hidden");
      roomPanel.classList.remove("hidden");
    }
  }
  if (message.type === "lobby" && roomPopupMinimized) roomPanel.classList.add("hidden");
  if (message.type === "match-start") {
    roomPopupMinimized = false;
    roomPanel.classList.add("hidden");
    roomStatusButton.classList.add("hidden");
  }
});


// Keep scoreboard portraits in sync with the animated arena characters.
function drawScoreCharacter(target, player, time) {
  const x = 24, y = 24 + (visualEffectsEnabled ? Math.sin(time / 175 + (player.id.charCodeAt(0) || 0)) * 1.1 : 0);
  const size = 11.5, color = player.color || "#57e389", shape = player.character || "comet";
  target.save(); target.shadowColor = color; target.shadowBlur = 9;
  target.beginPath(); target.arc(x, y, size + 2, 0, Math.PI * 2); target.fillStyle = "#0a111b"; target.fill(); target.shadowBlur = 0;
  const fill = target.createRadialGradient(x - 4, y - 5, 1, x, y, size + 2); fill.addColorStop(0, "#fff"); fill.addColorStop(.2, color); fill.addColorStop(1, color);
  target.fillStyle = fill; target.strokeStyle = "#f5fbff"; target.lineWidth = 1.2; target.beginPath();
  if (shape === "blaze") { target.moveTo(x, y - size - 1); target.lineTo(x + size, y + size - 2); target.lineTo(x, y + size); target.lineTo(x - size, y + size - 2); target.closePath(); }
  else if (shape === "violet") { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 6, px = x + Math.cos(a) * size, py = y + Math.sin(a) * size; if (!i) target.moveTo(px, py); else target.lineTo(px, py); } target.closePath(); }
  else if (shape === "sunny") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? size * .72 : size, px = x + Math.cos(a) * r, py = y + Math.sin(a) * r; if (!i) target.moveTo(px, py); else target.lineTo(px, py); } target.closePath(); }
  else if (shape === "berry") target.roundRect(x - size, y - size, size * 2, size * 2, 4);
  else if (shape === "moss") target.ellipse(x, y, size, size * .82, -.12, 0, Math.PI * 2);
  else target.arc(x, y, size, 0, Math.PI * 2);
  target.fill(); target.stroke(); target.fillStyle = "#12202b"; target.beginPath(); target.arc(x - 3, y - .5, 1.3, 0, Math.PI * 2); target.arc(x + 3, y - .5, 1.3, 0, Math.PI * 2); target.fill();
  if (shape === "moss") { target.fillStyle = "#d5ffd0"; target.beginPath(); target.ellipse(x + 1, y - 9, 2.1, 4, -.7, 0, Math.PI * 2); target.fill(); }
  if (shape === "comet") { target.strokeStyle = color; target.lineWidth = 1.6; target.beginPath(); target.moveTo(x - 9, y + 5); target.lineTo(x - 15, y + 9); target.moveTo(x - 10, y + 1); target.lineTo(x - 16, y + 3); target.stroke(); }
  target.strokeStyle = color; target.lineWidth = 1.5; target.beginPath(); target.arc(x, y, size + 4, time / 1200, time / 1200 + Math.PI * 1.55); target.stroke();
  if (player.shield) { target.strokeStyle = "#84e6ff"; target.lineWidth = 2; target.beginPath(); target.arc(x, y, size + 6, 0, Math.PI * 2); target.stroke(); }
  target.restore();
}
function animateScoreCharacters(time = 0) {
  requestAnimationFrame(animateScoreCharacters); if (!state?.players) return;
  state.players.slice(0, 2).forEach((player, index) => {
    const card = $("#score" + index); if (!card) return;
    let sprite = card.querySelector(".score-avatar");
    if (!(sprite instanceof HTMLCanvasElement)) { const replacement = document.createElement("canvas"); replacement.className = "score-avatar"; replacement.width = 48; replacement.height = 48; replacement.setAttribute("role", "img"); sprite.replaceWith(replacement); sprite = replacement; }
    sprite.setAttribute("aria-label", (player.character || "comet") + " character");
    const target = sprite.getContext("2d"); target.clearRect(0, 0, sprite.width, sprite.height);
    drawScoreCharacter(target, { ...player, id: String(player.id || index) }, visualEffectsEnabled ? time : 0);
  });
}
requestAnimationFrame(animateScoreCharacters);
