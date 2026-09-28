const $ = (selector) => document.querySelector(selector);
const lobby = $("#lobby"), gameView = $("#game"), createButton = $("#createButton"), joinButton = $("#joinButton"), botButton = $("#botButton");
const roomCodeInput = $("#roomCode"), errorMessage = $("#errorMessage"), roomPanel = $("#roomPanel");
const readyButton = $("#readyButton"), startButton = $("#startButton");
const charactersEl = $("#characters"), playersListEl = $("#playersList"), canvas = $("#board"), ctx = canvas.getContext("2d");
const toastEl = $("#toast");

let socket, localPlayerId = null, roomCode = null, characterOptions = [], state = null, targets = new Map(), renderPositions = new Map();
let held = new Set(), toastTimer, previousEffects = new Set(), matchStarted = false, opponentLeft = false;
let visualEffectsEnabled = localStorage.getItem("tr-visual-effects") !== "false";
let soundVolume = Number(localStorage.getItem("tr-sound-volume") ?? 65) / 100;
let musicEnabled = localStorage.getItem("tr-music") === "true";
let audioContext = null, masterGain = null, musicTimer = null, musicBeat = 0, previousTerritory = null, particles = [], claimFlashes = [];
let finalReplayTimer = null, finalReplayDone = false, activeReplay = null;
let popups = [], motionTrails = new Map(), shake = { power: 0, until: 0, duration: 1 };
let lastCountdown = 0, goUntil = 0, lastTickSecond = null, finalPhase = false, finishBannerShown = false, finishBannerActive = false, finishBannerTimer = null;
let dailyBoardEntries = [], dailyChallengeDay = "", dailyReplay = null;
const dailyPlayerKey = localStorage.getItem("tr-daily-player") || (() => { const id = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`; localStorage.setItem("tr-daily-player", id); return id; })();
$("#playerName").value = localStorage.getItem("tr-player-name") || localStorage.getItem("tr-daily-name") || "";
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
  const presets = { claim: [480, 790, .2, "sine", .16], power: [620, 980, .15, "triangle", .15], penalty: [190, 75, .32, "sawtooth", .16], move: [280, 220, .05, "sine", .035], tick: [1250, 1100, .05, "square", .05], count: [520, 520, .16, "square", .09], go: [700, 1400, .38, "sawtooth", .11], emote: [880, 1320, .09, "sine", .07] };
  const [from, to, duration, wave, level] = presets[kind] || presets.power;
  const osc = audioContext.createOscillator(), envelope = audioContext.createGain(), start = audioContext.currentTime;
  osc.type = wave; osc.frequency.setValueAtTime(from, start); osc.frequency.exponentialRampToValueAtTime(to, start + duration);
  envelope.gain.setValueAtTime(.0001, start); envelope.gain.exponentialRampToValueAtTime(level, start + .018); envelope.gain.exponentialRampToValueAtTime(.0001, start + duration);
  osc.connect(envelope); envelope.connect(masterGain); osc.start(start); osc.stop(start + duration + .025);
}
function playNotes(notes, step = .12, wave = "triangle", level = .12) {
  if (!audioContext || !masterGain || soundVolume <= 0) return;
  notes.forEach((frequency, index) => {
    const osc = audioContext.createOscillator(), envelope = audioContext.createGain(), start = audioContext.currentTime + index * step, length = step * 2.4;
    osc.type = wave; osc.frequency.setValueAtTime(frequency, start);
    envelope.gain.setValueAtTime(.0001, start); envelope.gain.exponentialRampToValueAtTime(level, start + .02); envelope.gain.exponentialRampToValueAtTime(.0001, start + length);
    osc.connect(envelope); envelope.connect(masterGain); osc.start(start); osc.stop(start + length + .03);
  });
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
  }, finalPhase ? 240 : 480);
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
    matchStarted = true; opponentLeft = false; lobby.classList.add("hidden"); gameView.classList.remove("hidden");
    $("#resultOverlay").classList.add("hidden"); $("#rematchButton").disabled = false; $("#rematchButton").textContent = "Rematch";
    resetMatchFx(); previousTerritory = null; previousEffects.clear(); finalReplayDone = false; clearTimeout(finalReplayTimer); activeReplay = null; dailyReplay = null; $("#replayOverlay").classList.add("hidden"); $("#skipReplay").textContent = "Skip"; $("#matchMode").textContent = message.mode === "daily" ? "DAILY CHALLENGE" : `1V1 ARENA · ${String(message.difficulty || "normal").toUpperCase()}`; startMusic();
  }
  if (message.type === "state") { state = message; updateTargets(); if (message.status === "finished" || message.finished || message.status === "disconnected") showResult(message); }
  if (message.type === "rematch-pending") {
    const button = $("#rematchButton");
    if (message.playerId === localPlayerId) { button.disabled = true; button.textContent = "Waiting for rival…"; }
    else { button.disabled = false; button.textContent = "Accept rematch"; }
  }
  if (message.type === "opponent-disconnected") { showToast(message.message, "penalty"); setTimeout(() => showResult(state || {}), 1200); }
  if (message.type === "emote" && EMOTES[message.emote]) {
    emoteBubbles.set(message.playerId, { text: EMOTES[message.emote], startedAt: performance.now() }); playSound("emote");
    setMood(message.playerId, ["happy", "happy", "determined", "worried"][message.emote], 1600);
  }
  if (message.type === "opponent-left") {
    opponentLeft = true; showToast(message.message, "penalty");
    $("#rematchButton").disabled = true; $("#rematchButton").textContent = "Rival left";
  }
  if (message.type === "error") setError(message.message || "Something went wrong.");
}
function renderCharacters() {
  charactersEl.replaceChildren();
  for (const character of characterOptions) {
    const button = document.createElement("button"); button.className = "character"; button.dataset.id = character.id;
    button.style.setProperty("--char", character.color);
    button.innerHTML = `<canvas class="character-portrait" width="96" height="96" aria-hidden="true"></canvas>${escapeHtml(character.name)}`;
    button.addEventListener("click", () => { setError(""); send("select-character", { characterId: character.id }); });
    button.addEventListener("pointerenter", () => showCharacterBlurb(character.id));
    charactersEl.append(button);
  }
}
let selectedCharacterId = null;
function showCharacterBlurb(id = selectedCharacterId) {
  const character = characterOptions.find((c) => c.id === id);
  const blurb = $("#characterBlurb");
  blurb.innerHTML = character ? `<b>${escapeHtml(character.name)}</b> · ${escapeHtml(CHARACTER_BLURBS[character.id] || "")}` : "Every character has its own look and personality";
  blurb.style.setProperty("--char", character?.color || "#8a95a8");
}
charactersEl.addEventListener("pointerleave", () => showCharacterBlurb());
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
    const character = characterOptions.find((c) => c.id === el.dataset.id);
    el.title = isTaken ? "Already selected by another player" : `${character?.name} · ${CHARACTER_BLURBS[el.dataset.id] || ""}`;
  }
  selectedCharacterId = me?.character || null;
  if (!charactersEl.matches(":hover")) showCharacterBlurb();
  playersListEl.innerHTML = message.players.map((p) => {
    const char = characterOptions.find((c) => c.id === p.character);
    const status = p.bot ? "READY" : p.ready ? "READY" : char ? "SELECTED" : "CHOOSING";
    return `<div class="player-row"><span class="mini-dot" style="--color:${p.color || "#697487"}"></span><bdi>${escapeHtml(p.name)}</bdi><small>${escapeHtml(char?.name || status)} · ${status}</small></div>`;
  }).join("");
  const versusBot = message.players.some((p) => p.bot);
  paintDifficulty("room", message.difficulty || "normal", !versusBot && !isHost);
  paintArena("room", message.arena || "random", !versusBot && !isHost);
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
  board.innerHTML = dailyBoardEntries.map((entry) => `<div class="daily-row"><span class="daily-rank">${String(entry.rank).padStart(2, "0")}</span><b dir="auto">${escapeHtml(entry.name)}</b><strong>${entry.score}</strong><button class="button quiet watch-daily" data-rank="${entry.rank}">Watch</button></div>`).join("");
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
  players.forEach((p) => setTarget(p.id, p.x, p.y, true));
  $("#lobby").classList.add("hidden"); gameView.classList.remove("hidden");
  $("#resultOverlay").classList.add("hidden"); $("#replayTitle").textContent = `TOP DAILY RUN · ${isolate(message.entry.name)} · ${message.entry.score} PTS`;
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
    setTarget(player.id, player.x, player.y, true);
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

function playerName() {
  const text = $("#playerName").value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
  // Count user-perceived characters so emoji and combining marks are never split.
  const parts = typeof Intl.Segmenter === "function" ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((part) => part.segment) : Array.from(text);
  const name = parts.slice(0, 18).join("");
  if (name) localStorage.setItem("tr-player-name", name);
  else localStorage.removeItem("tr-player-name");
  return name || "Player";
}
function isolate(name) { return `\u2068${name}\u2069`; }
const DIFFICULTY_IDS = ["easy", "normal", "hard"];
let difficulty = DIFFICULTY_IDS.includes(localStorage.getItem("tr-difficulty")) ? localStorage.getItem("tr-difficulty") : "normal";
function paintDifficulty(scope, value, locked = false) {
  for (const button of document.querySelectorAll(`.difficulty-options[data-scope="${scope}"] button`)) {
    const active = button.dataset.difficulty === value;
    button.classList.toggle("active", active); button.setAttribute("aria-checked", String(active)); button.setAttribute("role", "radio");
    button.disabled = locked;
    button.dataset.tip ??= button.title;
    button.title = locked ? "Only the room host can change the difficulty" : button.dataset.tip;
  }
}
paintDifficulty("lobby", difficulty);
$('.difficulty-options[data-scope="lobby"]').addEventListener("click", (event) => {
  const button = event.target.closest("button[data-difficulty]");
  if (!button) return;
  difficulty = button.dataset.difficulty; localStorage.setItem("tr-difficulty", difficulty); paintDifficulty("lobby", difficulty);
});
$('.difficulty-options[data-scope="room"]').addEventListener("click", (event) => {
  const button = event.target.closest("button[data-difficulty]");
  if (button && !button.disabled) { setError(""); send("set-difficulty", { difficulty: button.dataset.difficulty }); }
});
const ARENA_NAMES = { random: "Random", neon: "Neon Circuit", city: "Downtown Grid", park: "Sunny Park", ocean: "Coral Bay" };
let arenaChoice = Object.hasOwn(ARENA_NAMES, localStorage.getItem("tr-arena")) ? localStorage.getItem("tr-arena") : "random";
function paintArena(scope, value, locked = false) {
  const group = document.querySelector(`.arena-options[data-scope="${scope}"]`);
  group.closest(".arena-field").querySelector(".arena-name-label").textContent = ARENA_NAMES[value] || "Random";
  for (const button of group.querySelectorAll("button")) {
    const active = button.dataset.arena === value;
    button.classList.toggle("active", active); button.setAttribute("role", "radio"); button.setAttribute("aria-checked", String(active));
    button.disabled = locked;
    button.dataset.tip ??= button.title;
    button.title = locked ? "Only the room host can change the arena" : button.dataset.tip;
  }
}
paintArena("lobby", arenaChoice);
$('.arena-options[data-scope="lobby"]').addEventListener("click", (event) => {
  const button = event.target.closest("button[data-arena]");
  if (!button) return;
  arenaChoice = button.dataset.arena; localStorage.setItem("tr-arena", arenaChoice); paintArena("lobby", arenaChoice);
});
$('.arena-options[data-scope="room"]').addEventListener("click", (event) => {
  const button = event.target.closest("button[data-arena]");
  if (button && !button.disabled) { setError(""); send("set-arena", { arena: button.dataset.arena }); }
});
createButton.addEventListener("click", () => { setError(""); send("create-room", { name: playerName(), difficulty, arena: arenaChoice }); });
botButton.addEventListener("click", () => { setError(""); send("play-bot", { name: playerName(), difficulty, arena: arenaChoice }); });
readyButton.addEventListener("click", () => { setError(""); send("player-ready", { ready: true }); });
startButton.addEventListener("click", () => { setError(""); send("start-match"); });
$("#dailyButton").addEventListener("click", () => { setError(""); send("daily-challenge", { name: playerName(), playerKey: dailyPlayerKey }); });
$("#dailyLeaderboard").addEventListener("click", (event) => {
  const button = event.target.closest(".watch-daily");
  if (button) send("daily-replay-request", { day: dailyChallengeDay, rank: Number(button.dataset.rank) });
});
joinButton.addEventListener("click", () => {
  setError(""); const code = roomCodeInput.value.trim().toUpperCase();
  if (code.length !== 5) return setError("Enter the five-character room code.");
  send("join-room", { code, name: playerName() });
});
roomCodeInput.addEventListener("input", () => { roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5); });
roomCodeInput.addEventListener("keydown", (event) => { if (event.key === "Enter") joinButton.click(); });

function updateTargets() {
  if (!state?.players) return;
  trackTerritoryChanges();
  noteSnapshotArrival();
  state.players.forEach((player, index) => {
    setTarget(player.id, player.x, player.y);
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
  updateCountdown(countdown);
  updateFinalStretch(countdown);
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
    if (effect.type === "claim") { const breach = effect.breached ? ` · BREACH +${effect.breached}` : ""; showToast(effect.playerId === localPlayerId ? `Territory claimed · +${effect.cells} cells${breach}` : `Opponent claimed territory${breach}`, "claim"); playSound("claim");
      const claimer = state.players.find((player) => player.id === effect.playerId);
      if (claimer) setMood(claimer.id, "happy", 1100);
      if (claimer && effect.cells) {
        const pos = renderPositions.get(claimer.id) || claimer;
        addPopup(pos.x, pos.y - 22, `+${effect.cells}${effect.bonus ? " BONUS" : ""}`, claimer.color, 14 + Math.min(14, effect.cells / 5));
        if (effect.breached) addPopup(pos.x, pos.y - 46, "BREACH!", "#ff83ce", 15);
        addShake(effect.playerId === localPlayerId ? Math.min(7, 1.5 + effect.cells / 12) : 1.5, 260);
      }
    }
    if (effect.type === "crown-active") { showToast("THE CROWN IS LIVE · claim the gold beacon", "power"); playSound("power"); }
    if (effect.type === "crown-moved") { showToast("THE CROWN MOVED · race to its new beacon", "power"); playSound("power"); }
    if (effect.type === "crown-moving") { showToast("CROWN SHIFTS IN 5 SECONDS · get ready", "power"); playSound("power"); }
    if (effect.type === "crown-control") showToast(effect.playerId === localPlayerId ? "CROWN CLAIMED · hold for points" : "Rival claimed the Crown", "power");
    if (effect.type === "crown-point") {
      showToast(`${effect.playerId === localPlayerId ? "Crown secured" : "Rival scored"} · ${effect.points} point${effect.points === 1 ? "" : "s"}`, "power");
      if (state.crown?.cell) { const size = state.map.cellSize; addPopup((state.crown.cell.x + .5) * size, (state.crown.cell.y + .5) * size - 16, "+4 ♛", "#ffd45c", 18); addShake(2, 180); }
    }
    if (effect.type === "penalty") {
      showToast(effect.playerId === localPlayerId ? "Trail cut! Territory lost — back to base" : "Opponent caught · territory lost", "penalty"); playSound("penalty");
      if (visualEffectsEnabled) { const frame = $(".board-frame"); frame.classList.remove("impact"); void frame.offsetWidth; frame.classList.add("impact"); setTimeout(() => frame.classList.remove("impact"), 300); }
      const caught = state.players.find((player) => player.id === effect.playerId);
      if (caught) spawnBurst(caught.x, caught.y, "#ff6e91", 18);
      for (const player of state.players) setMood(player.id, player.id === effect.playerId ? "hurt" : "happy", 1300);
      if (effect.hitCell) {
        const [hx, hy] = parseCell(effect.hitCell), size = state.map.cellSize;
        spawnBurst((hx + .5) * size, (hy + .5) * size, "#ff6e91", 26);
        addPopup((hx + .5) * size, (hy + .5) * size - 12, `CUT! −${({ easy: 8, hard: 18 })[state.difficulty] ?? 12}%`, "#ff6e91", 22);
      }
      addShake(effect.playerId === localPlayerId ? 9 : 5, 380);
    }
    if (effect.type === "shield-block") {
      showToast(effect.playerId === localPlayerId ? "Shield absorbed the hit" : "Opponent's shield blocked the hit", "power"); playSound("power");
      const owner = state.players.find((player) => player.id === effect.playerId);
      if (owner) { const pos = renderPositions.get(owner.id) || owner; addPopup(pos.x, pos.y - 24, "BLOCKED!", "#84e6ff", 16); addShake(3, 200); }
    }
    if (effect.type === "power-collect") {
      showToast(`${effect.playerId === localPlayerId ? "You collected" : "Opponent collected"} ${powerName(effect.powerType)}`, "power"); playSound("power");
      const collector = state.players.find((player) => player.id === effect.playerId);
      const colors = { speed: "#ffd45c", shield: "#70d8ff", freeze: "#9ba8ff", bonus: "#ff83ce" };
      if (collector) setMood(collector.id, "happy", 700);
      if (collector) { spawnBurst(collector.x, collector.y, colors[effect.powerType] || "#fff", 15); addPopup(collector.x, collector.y - 16, powerName(effect.powerType).toUpperCase(), colors[effect.powerType] || "#fff", 13); }
    }
  }
}
function resetMatchFx() {
  popups = []; motionTrails.clear(); facing.clear(); moods.clear(); lastCountdown = 0; goUntil = 0; lastTickSecond = null; finalPhase = false;
  finishBannerShown = false; finishBannerActive = false; clearTimeout(finishBannerTimer);
  $("#finishBanner").className = "finish-banner hidden";
  $(".timer-box").classList.remove("final-countdown"); $(".board-frame").classList.remove("final-countdown");
}
function restartAnimation(element) { element.style.animation = "none"; void element.offsetWidth; element.style.animation = ""; }
function updateCountdown(countdown) {
  const overlay = $("#countdownOverlay"), number = $("#countdownNumber"), caption = overlay.querySelector("span");
  if (countdown > 0 && countdown !== lastCountdown) { number.textContent = String(countdown); caption.textContent = "GET READY"; restartAnimation(number); playSound("count"); }
  if (countdown <= 0 && lastCountdown > 0) { number.textContent = "GO!"; caption.textContent = "RUSH!"; restartAnimation(number); playSound("go"); goUntil = performance.now() + 700; }
  lastCountdown = countdown;
  overlay.classList.toggle("go", countdown <= 0);
  overlay.classList.toggle("hidden", state.finished || (countdown <= 0 && performance.now() > goUntil));
}
function updateFinalStretch(countdown) {
  const seconds = Math.ceil((state.remainingMs || 0) / 1000), live = countdown <= 0 && !state.finished && state.status === "playing";
  if (live && seconds <= 30 && !finalPhase) { finalPhase = true; showToast("FINAL 30 SECONDS · make your move", "power"); stopMusic(); startMusic(); }
  const critical = live && seconds <= 10;
  $(".timer-box").classList.toggle("final-countdown", critical); $(".board-frame").classList.toggle("final-countdown", critical);
  if (critical && seconds !== lastTickSecond) { lastTickSecond = seconds; playSound("tick"); }
}
function addPopup(x, y, text, color, size = 16) {
  if (!visualEffectsEnabled) return;
  popups.push({ x: Math.max(50, Math.min(canvas.width - 50, x)), y: Math.max(26, y), text, color, size, startedAt: performance.now() });
  popups = popups.slice(-24);
}
function addShake(power, duration) {
  if (!visualEffectsEnabled) return;
  const now = performance.now(), current = shake.until > now ? shake.power * (shake.until - now) / shake.duration : 0;
  if (power >= current) shake = { power, until: now + duration, duration };
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
  if (finalReplayDone || finishBannerActive) return;
  if ((message.finished || message.status === "finished") && !finishBannerShown) {
    finishBannerShown = finishBannerActive = true;
    showFinishBanner(message);
    finishBannerTimer = setTimeout(() => { finishBannerActive = false; $("#finishBanner").classList.add("hidden"); showResult(message); }, 2000);
    return;
  }
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
function showFinishBanner(message) {
  const winnerId = message.winnerId ?? state?.winnerId, draw = message.draw ?? state?.draw;
  const outcome = draw ? "draw" : winnerId === localPlayerId ? "win" : "lose";
  const banner = $("#finishBanner");
  banner.querySelector("strong").textContent = { win: "VICTORY", lose: "DEFEAT", draw: "DRAW" }[outcome];
  banner.querySelector("span").textContent = { win: "THE MAP IS YOURS", lose: "YOUR RIVAL HOLDS THE GROUND", draw: "DEAD EVEN" }[outcome];
  banner.className = `finish-banner ${outcome}`;
  stopMusic(); $(".timer-box").classList.remove("final-countdown"); $(".board-frame").classList.remove("final-countdown");
  if (outcome === "win") playNotes([523.25, 659.25, 783.99, 1046.5], .13, "triangle", .13);
  else if (outcome === "lose") playNotes([392, 329.63, 261.63, 196], .16, "sawtooth", .06);
  else playNotes([440, 523.25, 440], .14, "triangle", .11);
  addShake(outcome === "win" ? 6 : 4, 450);
  if (outcome === "win") {
    const me = state?.players?.find((player) => player.id === localPlayerId);
    for (let i = 0; i < 6; i++) spawnBurst(80 + Math.random() * (canvas.width - 160), 80 + Math.random() * (canvas.height - 160), me?.color || "#7effd6", 14);
  }
}
function playFinalReplay(items, index, message) {
  if (index >= items.length) { activeReplay = null; $("#replayOverlay").classList.add("hidden"); displayResult(message); return; }
  const item = items[index];
  activeReplay = { ...item, startedAt: performance.now(), duration: 2300 };
  $("#replayTitle").textContent = item.kind === "capture" ? `${isolate(item.name)} · Biggest Capture · ${item.score} cells` : `${isolate(item.name)} · Longest Trail Cut · ${item.score} cells`;
  $("#replayOverlay").classList.remove("hidden");
  finalReplayTimer = setTimeout(() => playFinalReplay(items, index + 1, message), activeReplay.duration);
}
function displayResult(message) {
  const winnerId = message.winnerId ?? state?.winnerId;
  const draw = message.draw ?? state?.draw;
  const winner = state?.players?.find((p) => p.id === winnerId);
  $("#resultTitle").textContent = draw ? "It’s a draw" : winnerId === localPlayerId ? "You win!" : winner ? `${isolate(winner.name)} wins` : "Match ended";
  const scores = state?.players?.map((p) => `${isolate(p.name)} ${p.matchScore ?? p.territoryCells ?? 0}`).join(" · ") || "";
  $("#resultText").textContent = message.message || `Final score ${scores} · land cells + 4 per Crown point`;
  $("#resultStats").innerHTML = (state?.players || []).map((p) => {
    const stats = p.stats || {};
    return `<div class="result-stat has-avatar" style="--stat-color:${p.color}"><canvas class="result-avatar" width="96" height="96" data-id="${escapeHtml(String(p.id))}" aria-hidden="true"></canvas><span><bdi>${escapeHtml(p.name)}</bdi>${p.id === localPlayerId ? " · YOU" : ""}</span><strong>${p.matchScore ?? p.territoryCells ?? 0} PTS</strong><small>${p.territoryPercent.toFixed(1)}% territory · ${stats.crownPoints || 0} Crown points · ${stats.cellsClaimed || 0} cells captured · ${stats.trailCuts || 0} cuts · ${stats.powerUpsCollected || 0} pickups</small></div>`;
  }).join("");
  const unavailable = message.status === "disconnected" || state?.status === "disconnected";
  $("#rematchButton").classList.toggle("hidden", unavailable);
  $("#rematchButton").disabled = unavailable || opponentLeft;
  if (opponentLeft) $("#rematchButton").textContent = "Rival left";
  $("#resultOverlay").classList.remove("hidden");
  matchStarted = false; stopMusic();
}
$("#skipReplay").addEventListener("click", () => { if (dailyReplay) return exitDailyReplay(); clearTimeout(finalReplayTimer); activeReplay = null; $("#replayOverlay").classList.add("hidden"); if (state) displayResult({ winnerId: state.winnerId, draw: state.draw, status: "finished" }); });
function backToLobby() { send("leave-room"); location.reload(); }
$("#leaveButton").addEventListener("click", backToLobby);
$("#backButton").addEventListener("click", backToLobby);
$("#rematchButton").addEventListener("click", () => send("rematch"));

function fitText(g, text, maxWidth) {
  if (g.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && g.measureText(`${chars.join("")}…`).width > maxWidth) chars.pop();
  return `${chars.join("")}…`;
}
async function buildShareImage() {
  if (!state?.players?.length || !state.map) return null;
  await document.fonts?.ready;
  const W = 1200, H = 630, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#0c1420"); bg.addColorStop(1, "#161b2e");
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#9bc8dc0d"; g.lineWidth = 1;
  for (let x = 0; x <= W; x += 48) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let y = 0; y <= H; y += 48) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

  const me = state.players.find((p) => p.id === localPlayerId) || state.players[0];
  const rival = state.players.find((p) => p !== me);
  const won = !state.draw && state.winnerId === me.id;
  const accent = state.draw ? "#ffd45c" : won ? "#57e389" : "#ff6e91";
  const glow = g.createRadialGradient(250, 230, 0, 250, 230, 420); glow.addColorStop(0, colorAlpha(accent, .16)); glow.addColorStop(1, colorAlpha(accent, 0));
  g.fillStyle = glow; g.fillRect(0, 0, W, H);

  const mono = (size, weight = 600) => `${weight} ${size}px "DM Mono", Consolas, monospace`;
  const sans = (size, weight = 700) => `${weight} ${size}px "Space Grotesk", Inter, "Segoe UI", "Segoe UI Emoji", sans-serif`;
  g.textBaseline = "alphabetic"; g.textAlign = "left";
  g.font = mono(18); g.fillStyle = "#7effd6"; g.fillText("TERRITORY RUSH", 64, 84);
  const mode = state.mode === "daily" ? "DAILY CHALLENGE" : `1V1 ARENA · ${String(state.difficulty || "normal").toUpperCase()}`;
  g.font = mono(15, 500); g.fillStyle = "#8a95a8"; g.fillText(`${mode} · ${(state.theme?.name || "Arena").toUpperCase()}`, 64, 114);
  g.save(); g.font = sans(104, 800); g.fillStyle = accent; g.shadowColor = colorAlpha(accent, .55); g.shadowBlur = 28;
  g.fillText(state.draw ? "DRAW" : won ? "VICTORY" : "DEFEAT", 58, 236); g.restore();

  [me, rival].filter(Boolean).forEach((p, i) => {
    const y = 318 + i * 86;
    g.fillStyle = colorAlpha(p.color, .12); roundRect(g, 64, y - 38, 472, 70, 14); g.fill();
    g.strokeStyle = colorAlpha(p.color, .45); g.lineWidth = 1.5; g.stroke();
    const mood = state.draw ? "idle" : state.winnerId === p.id ? "happy" : "worried";
    paintCharacter(g, { character: p.character, color: p.color, x: 92, y: y - 2, scale: 1.3, mood });
    g.font = sans(24, 700); g.fillStyle = "#f1f4f8"; g.fillText(fitText(g, p.name, 230), 118, y + 3);
    if (p === me) { const w = g.measureText(fitText(g, p.name, 230)).width; g.font = mono(12); g.fillStyle = "#9fb0c4"; g.fillText("YOU", 128 + w, y + 2); }
    g.font = mono(13, 500); g.fillStyle = "#8a95a8"; g.fillText(`${(p.territoryPercent || 0).toFixed(1)}% land · ${p.stats?.crownPoints || 0} ♛`, 118, y + 22);
    g.textAlign = "right"; g.font = sans(30, 800); g.fillStyle = p.color; g.fillText(`${p.matchScore ?? p.territoryCells ?? 0}`, 470, y + 8);
    g.font = mono(13); g.fillStyle = "#9fb0c4"; g.fillText("PTS", 516, y + 8); g.textAlign = "left";
  });
  const s = me.stats || {};
  g.font = sans(17, 500); g.fillStyle = "#c6d0dc";
  g.fillText(`${s.cellsClaimed || 0} cells captured  ·  cut ${s.trailCuts || 0}×  ·  ${s.powerUpsCollected || 0} pickups`, 64, 526);
  g.font = mono(14, 500); g.fillStyle = "#6d7a8c";
  g.fillText(`${new Date().toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}  ·  Play at ${location.host}`, 64, 578);

  const { width: mw, height: mh, walls } = state.map, boxW = 536, cs = boxW / mw, boxH = cs * mh, bx = 600, by = (H - boxH) / 2 + 12;
  g.font = mono(13); g.fillStyle = "#8a95a8"; g.fillText("FINAL BOARD", bx, by - 16);
  g.save(); g.shadowColor = colorAlpha(accent, .35); g.shadowBlur = 30; roundRect(g, bx - 8, by - 8, boxW + 16, boxH + 16, 16); g.fillStyle = "#0a1018"; g.fill(); g.restore();
  g.strokeStyle = colorAlpha(accent, .5); g.lineWidth = 2; roundRect(g, bx - 8, by - 8, boxW + 16, boxH + 16, 16); g.stroke();
  g.fillStyle = "#131c28"; g.fillRect(bx, by, boxW, boxH);
  for (const p of state.players) {
    g.fillStyle = colorAlpha(p.color, .78);
    for (const packed of p.territory) { const [x, y] = parseCell(packed); g.fillRect(bx + x * cs + .5, by + y * cs + .5, cs - 1, cs - 1); }
  }
  g.fillStyle = "#3a4a5f";
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (walls[y][x]) g.fillRect(bx + x * cs, by + y * cs, cs, cs);
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
$("#shareButton").addEventListener("click", async () => {
  const button = $("#shareButton"), label = "📸 Share result";
  button.disabled = true;
  try {
    const blob = await buildShareImage();
    if (!blob) return;
    const file = new File([blob], "territory-rush-result.png", { type: "image/png" });
    // Phones get the native share sheet; desktops download the image and also copy it for quick pasting.
    if (matchMedia("(pointer: coarse)").matches && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "Territory Rush", text: "My Territory Rush result" });
      button.textContent = "Shared ✓";
    } else {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      let copied = false;
      try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch {}
      button.textContent = copied ? "Saved & copied ✓" : "Saved ✓";
    }
  } catch (error) {
    if (error?.name !== "AbortError") button.textContent = "Couldn't create image";
  } finally {
    button.disabled = false; setTimeout(() => { button.textContent = label; }, 2200);
  }
});

function keyDirection(event) {
  if (event.target.closest?.("input, textarea, select, [contenteditable]")) return undefined;
  const k = event.key.toLowerCase();
  return ({ w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right" })[k];
}
function sendInput() { if (matchStarted) send("input", { input: { up: held.has("up"), down: held.has("down"), left: held.has("left"), right: held.has("right") } }); }
const EMOTES = ["GG", "😂", "Catch me!", "Oops"], emoteBubbles = new Map();
let lastEmoteSentAt = 0;
function sendEmote(index) {
  if (!matchStarted || !EMOTES[index] || performance.now() - lastEmoteSentAt < 1000) return;
  lastEmoteSentAt = performance.now(); send("emote", { emote: index });
}
window.addEventListener("keydown", (event) => {
  if (event.repeat || event.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const index = ["1", "2", "3", "4"].indexOf(event.key);
  if (index >= 0) sendEmote(index);
});
$("#emoteBar").addEventListener("click", (event) => { const button = event.target.closest("button[data-emote]"); if (button) { sendEmote(Number(button.dataset.emote)); button.blur(); } });
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
// Every portrait (arena, scoreboard, lobby cards, results, share image) comes from paintCharacter,
// drawn in a unit space where the body is about 10 units across its radius.
const CHARACTER_BLURBS = {
  comet: "Streaks around with a stardust tail",
  moss: "Chill sprout that loves green space",
  blaze: "Hot-headed and always fired up",
  violet: "Cool crystal with a sparkle",
  sunny: "Beams under a spinning sun halo",
  berry: "Sweet, round and sneaky",
};
function characterPath(g, shape, t) {
  g.beginPath();
  if (shape === "blaze") {
    const tip = Math.sin(t / 130) * 1.6, flick = Math.sin(t / 90) * 1.1;
    g.moveTo(tip, -14 - flick);
    g.bezierCurveTo(4, -9, 10, -5, 10, 2); g.bezierCurveTo(10, 8, 5, 10.5, 0, 10.5);
    g.bezierCurveTo(-5, 10.5, -10, 8, -10, 2); g.bezierCurveTo(-10, -5, -4, -9, tip, -14 - flick);
  } else if (shape === "violet") {
    for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 2; g.lineTo(Math.cos(a) * 11, Math.sin(a) * 11); }
    g.closePath();
  } else if (shape === "berry") {
    g.moveTo(0, 11);
    g.bezierCurveTo(-7, 9.5, -11, 3, -10.5, -2.5); g.bezierCurveTo(-10, -8, -4.5, -9, 0, -8);
    g.bezierCurveTo(4.5, -9, 10, -8, 10.5, -2.5); g.bezierCurveTo(11, 3, 7, 9.5, 0, 11);
  } else if (shape === "moss") {
    const w = Math.sin(t / 420) * .5;
    g.moveTo(-10.5, 3);
    g.bezierCurveTo(-11, -5, -6, -9.5 + w, 0, -9.5); g.bezierCurveTo(6, -9.5 - w, 11, -5, 10.5, 3);
    g.bezierCurveTo(10, 8.5, 5, 9.5, 0, 9.5); g.bezierCurveTo(-5, 9.5, -10, 8.5, -10.5, 3);
  } else g.arc(0, 0, shape === "sunny" ? 9 : 10, 0, Math.PI * 2);
}
function sparkle(g, x, y, s, color) {
  g.beginPath(); g.moveTo(x, y - s * 2);
  g.quadraticCurveTo(x, y, x + s * 2, y); g.quadraticCurveTo(x, y, x, y + s * 2);
  g.quadraticCurveTo(x, y, x - s * 2, y); g.quadraticCurveTo(x, y, x, y - s * 2);
  g.fillStyle = color; g.fill();
}
function paintCharacter(g, { character, color = "#57e389", x, y, scale = 1, time = 0, dir = { x: 1, y: 0 }, moving = false, mood = "idle", seed = 0, shadow = false }) {
  const shape = CHARACTER_BLURBS[character] ? character : "comet", t = time + seed * 977, frozen = mood === "frozen";
  const hop = moving && !frozen ? Math.abs(Math.sin(t / 105)) : 0, cheer = mood === "happy" ? Math.abs(Math.sin(t / 140)) : 0;
  const angle = Math.atan2(dir.y, dir.x), stretch = moving && !frozen ? .07 : 0, breathe = frozen ? 0 : Math.sin(t / 480) * .03;
  const dark = mixColor(color, -.35), light = mixColor(color, .5), ink = "#101a26";
  g.save();
  g.translate(x + (frozen ? Math.sin(t / 25) * .5 * scale : 0), y); g.scale(scale, scale);
  if (shadow) { g.fillStyle = "#05091170"; g.beginPath(); g.ellipse(0, 11, 8.5 - hop * 1.5, 3, 0, 0, Math.PI * 2); g.fill(); }
  g.translate(0, -hop * 2.2 - cheer * 1.8);
  g.rotate(angle); g.scale(1 + stretch, 1 - stretch * .8); g.rotate(-angle); g.scale(1 - breathe * .5, 1 + breathe);
  g.lineCap = "round"; g.lineJoin = "round";

  if (shape === "comet") {
    const len = moving ? 26 : 15, wob = Math.sin(t / 70) * 1.2;
    g.save(); g.rotate(angle);
    const tail = g.createLinearGradient(-4, 0, -len - 4, 0); tail.addColorStop(0, colorAlpha(color, .85)); tail.addColorStop(1, colorAlpha(color, 0));
    g.fillStyle = tail; g.beginPath(); g.moveTo(-2, -8); g.quadraticCurveTo(-len * .55, -5 + wob, -len - 4, wob * .6); g.quadraticCurveTo(-len * .55, 5 + wob, -2, 8); g.closePath(); g.fill();
    for (let i = 0; i < 3; i++) { const p = (t / 380 + i / 3) % 1; g.globalAlpha = 1 - p; sparkle(g, -7 - p * len, Math.sin(i * 2.1 + t / 200) * 4, .9 * (1 - p) + .3, "#ffffff"); }
    g.globalAlpha = 1; g.restore();
  } else if (shape === "sunny") {
    g.save(); g.rotate(t / 1600); g.fillStyle = "#ffe07a";
    const pulse = Math.sin(t / 260) * .8;
    for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); g.beginPath(); g.moveTo(-2.6, -8.5); g.lineTo(0, -13.8 - pulse); g.lineTo(2.6, -8.5); g.closePath(); g.fill(); }
    g.restore();
  } else if (shape === "blaze") {
    g.fillStyle = "#ffb347";
    for (const side of [-1, 1]) {
      const f = Math.sin(t / 85 + side) * 1.3;
      g.beginPath(); g.moveTo(side * 7, -3); g.quadraticCurveTo(side * 12.5, -6, side * (11 + f * .5), -11 - f); g.quadraticCurveTo(side * 10, -3, side * 9.5, 3); g.closePath(); g.fill();
    }
  }

  characterPath(g, shape, t);
  g.save(); g.shadowColor = colorAlpha(color, .7); g.shadowBlur = 10 * scale; g.strokeStyle = "#08101a"; g.lineWidth = 3.2; g.stroke(); g.restore();
  const body = g.createRadialGradient(-3.5, -5, 1, 0, 0, 13);
  body.addColorStop(0, light); body.addColorStop(.38, color); body.addColorStop(1, dark);
  g.fillStyle = body; g.fill();
  g.strokeStyle = "#f5fbffcc"; g.lineWidth = 1.1; g.stroke();
  if (shape === "violet") {
    g.strokeStyle = "#ffffff5c"; g.lineWidth = .9; g.beginPath();
    g.moveTo(0, -11); g.lineTo(-4.5, -5.5); g.lineTo(4.5, -5.5); g.closePath(); g.moveTo(-9.5, -5.5); g.lineTo(-4.5, -5.5); g.moveTo(9.5, -5.5); g.lineTo(4.5, -5.5); g.stroke();
  } else if (shape === "berry") {
    g.fillStyle = "#ffe3f0";
    for (const [sx, sy] of [[-7, -3.5], [7, -3.5], [-7.8, 2.5], [7.8, 2.5], [-3.8, 7.6], [3.8, 7.6], [0, 9]]) { g.beginPath(); g.ellipse(sx, sy, .7, 1.1, sx * .05, 0, Math.PI * 2); g.fill(); }
  } else if (shape === "moss") {
    g.fillStyle = "#e4ffe833";
    for (const [sx, sy, r] of [[-6.5, -4.5, 1.6], [7, 5, 1.3], [-7.5, 5.5, 1]]) { g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill(); }
  }
  if (frozen) {
    characterPath(g, shape, t); g.fillStyle = "rgba(176,226,255,.5)"; g.fill();
    g.strokeStyle = "#e6f8ff"; g.lineWidth = 1; g.beginPath(); g.moveTo(-8, -6); g.lineTo(-5.5, -3.5); g.moveTo(7.5, -6.5); g.lineTo(5.5, -4); g.stroke();
  }

  g.save();
  const lookX = frozen ? 0 : dir.x * 1.2, lookY = frozen ? 0 : dir.y * 1.1;
  g.translate(lookX * .6, (shape === "blaze" ? 1.5 : 0) + lookY * .5);
  const blink = time > 0 && t % 3700 < 120;
  if (mood === "happy") {
    g.strokeStyle = ink; g.lineWidth = 1.5;
    for (const ex of [-3.6, 3.6]) { g.beginPath(); g.arc(ex, -.2, 2.1, Math.PI * 1.15, Math.PI * 1.85); g.stroke(); }
  } else if (mood === "hurt") {
    g.strokeStyle = ink; g.lineWidth = 1.4;
    for (const ex of [-3.6, 3.6]) { g.beginPath(); g.moveTo(ex - 1.7, -2.9); g.lineTo(ex + 1.7, .5); g.moveTo(ex + 1.7, -2.9); g.lineTo(ex - 1.7, .5); g.stroke(); }
  } else if (frozen || blink) {
    g.strokeStyle = ink; g.lineWidth = 1.4;
    for (const ex of [-3.6, 3.6]) { g.beginPath(); g.moveTo(ex - 2, -1); g.lineTo(ex + 2, -1); g.stroke(); }
  } else {
    const pupil = mood === "worried" ? 1.05 : 1.45;
    for (const ex of [-3.6, 3.6]) {
      g.fillStyle = "#fbfdff"; g.beginPath(); g.ellipse(ex, -1.2, 2.5, 2.9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = ink; g.beginPath(); g.arc(ex + lookX, -1.2 + lookY, pupil, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#fff"; g.beginPath(); g.arc(ex + lookX - .5, -1.9 + lookY, .5, 0, Math.PI * 2); g.fill();
    }
  }
  if (mood === "worried" || mood === "determined") {
    const [inner, outer] = mood === "worried" ? [-6.2, -4.8] : [-4.3, -5.9];
    g.strokeStyle = ink; g.lineWidth = 1.3; g.beginPath();
    g.moveTo(-5.8, outer); g.lineTo(-1.8, inner); g.moveTo(5.8, outer); g.lineTo(1.8, inner); g.stroke();
  }
  if (shape !== "berry" && !frozen) {
    g.fillStyle = "rgba(255,120,160,.38)";
    for (const cx of [-6.6, 6.6]) { g.beginPath(); g.ellipse(cx, 2.4, 1.7, 1.1, 0, 0, Math.PI * 2); g.fill(); }
  }
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1.3; g.beginPath();
  if (mood === "happy" || (moving && mood === "idle")) {
    g.moveTo(-2.8, 3); g.quadraticCurveTo(0, 7.4, 2.8, 3); g.closePath(); g.fill();
    g.fillStyle = "#ff7d9a"; g.beginPath(); g.ellipse(0, 4.6, 1.2, .7, 0, 0, Math.PI * 2); g.fill();
  } else if (mood === "worried" || mood === "hurt") { g.ellipse(0, 4.4, 1.5, mood === "hurt" ? 1.9 : 1.2, 0, 0, Math.PI * 2); g.fill(); }
  else if (frozen) { g.moveTo(-2.6, 4); for (let i = 1; i <= 4; i++) g.lineTo(-2.6 + i * 1.3, i % 2 ? 3.3 : 4); g.stroke(); }
  else if (mood === "determined") { g.moveTo(-2.2, 4.2); g.quadraticCurveTo(0, 5.2, 2.2, 3.6); g.stroke(); }
  else { g.arc(0, 2.6, 2.4, Math.PI * .2, Math.PI * .8); g.stroke(); }
  if (mood === "worried") {
    g.fillStyle = "#9fe3ff"; g.beginPath(); g.moveTo(8.4, -7.5); g.quadraticCurveTo(10.3, -4, 8.4, -3.4); g.quadraticCurveTo(6.5, -4, 8.4, -7.5); g.fill();
  }
  g.restore();

  if (shape === "moss") {
    g.save(); g.translate(0, -9); g.rotate(Math.sin(t / 380) * .28);
    g.strokeStyle = "#2f9b58"; g.lineWidth = 1.3; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-.5, -3, 0, -4.5); g.stroke();
    g.fillStyle = "#b9ffc4"; g.beginPath(); g.ellipse(-2.6, -5, 3, 1.6, -.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#8ef0a4"; g.beginPath(); g.ellipse(2.6, -5.4, 3, 1.6, .5, 0, Math.PI * 2); g.fill();
    g.restore();
  } else if (shape === "berry") {
    g.strokeStyle = "#2f8a45"; g.lineWidth = 1.2; g.beginPath(); g.moveTo(0, -9); g.lineTo(.8, -12.8); g.stroke();
    g.fillStyle = "#4fcf6d"; g.strokeStyle = "#08101a"; g.lineWidth = .8;
    for (const a of [-1.15, -.4, .4, 1.15]) { g.save(); g.translate(0, -8); g.rotate(a); g.beginPath(); g.ellipse(0, -2.6, 1.5, 3.1, 0, 0, Math.PI * 2); g.fill(); g.stroke(); g.restore(); }
  } else if (shape === "violet") {
    const a = t / 650;
    sparkle(g, Math.cos(a) * 13.5, Math.sin(a) * 4.5 - 7, 1.4 + Math.sin(t / 150) * .5, "#f3e8ff");
  } else if (shape === "comet") {
    sparkle(g, 6.2, -7.2, .9 + Math.sin(t / 170) * .35, "#ffffff");
  } else if (shape === "blaze") {
    const p = (t / 900) % 1; g.globalAlpha = 1 - p;
    g.fillStyle = "#ffd36b"; g.beginPath(); g.arc(Math.sin(t / 160) * 3, -14 - p * 8, 1.2 * (1 - p) + .3, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }
  g.restore();
}
// Facing and short-lived reactions are tracked client-side so faces follow movement and match events.
const facing = new Map(), moods = new Map();
function setMood(id, mood, ms) { moods.set(id, { mood, until: performance.now() + ms }); }
function facingOf(player) {
  let face = facing.get(player.id);
  if (!face) {
    const mid = (state?.map?.width || 48) * (state?.map?.cellSize || 20) / 2;
    face = { x: player.x < mid ? 1 : -1, y: 0, moving: false }; facing.set(player.id, face);
  }
  const target = targets.get(player.id), dx = target ? target.x - target.fromX : 0, dy = target ? target.y - target.fromY : 0, len = Math.hypot(dx, dy);
  if (len > .4) { face.x = dx / len; face.y = dy / len; }
  face.moving = len > .4;
  return face;
}
function characterMood(player, players = []) {
  const flash = moods.get(player.id), fresh = flash && flash.until > performance.now();
  if (fresh && flash.mood === "hurt") return "hurt";
  if (player.freezeActive) return "frozen";
  if (fresh) return flash.mood;
  if (player.trail?.length) {
    const rival = players.find((p) => p.id !== player.id), reach = 5 * (state?.map?.cellSize || 20);
    return rival && Math.hypot(rival.x - player.x, rival.y - player.y) < reach ? "worried" : "determined";
  }
  if (player.speedActive || player.character === "blaze") return "determined";
  return "idle";
}
function drawAvatar(player, x, y, time, players) {
  const face = facingOf(player);
  paintCharacter(ctx, { character: player.character, color: player.color, x, y, scale: 1.05, time, dir: face, moving: face.moving && time > 0, mood: characterMood(player, players), seed: player.id.charCodeAt(0) || 0, shadow: true });
  ctx.save();
  ctx.strokeStyle = colorAlpha(player.color, .7); ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(x, y, 17.5, time / 1200, time / 1200 + Math.PI * 1.55); ctx.stroke();
  if (player.shield) {
    ctx.beginPath(); ctx.arc(x, y, 20.5, 0, Math.PI * 2); ctx.strokeStyle = "#84e6ff"; ctx.lineWidth = 1.8; ctx.shadowColor = "#59dfff"; ctx.shadowBlur = 10; ctx.stroke();
  }
  ctx.restore();
}
// Arena looks. Floors and walls are painted once per map into offscreen layers, then reused every frame.
function cellHash(x, y, salt = 0) {
  let h = (Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263) + Math.imul(salt + 1, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function mixColor(hex, amount) {
  const n = Number.parseInt(hex.slice(1, 7), 16), target = amount < 0 ? 0 : 255, p = Math.abs(amount);
  const ch = (v) => Math.round(v + (target - v) * p);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}
const isWallAt = (map, x, y) => x < 0 || y < 0 || x >= map.width || y >= map.height || Boolean(map.walls[y][x]);
function forCells(map, fn, wantWall) {
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) if (Boolean(map.walls[y][x]) === wantWall) fn(x, y, x * map.cellSize, y * map.cellSize);
}
function wallClusters(map) {
  const { width, height, walls } = map, id = walls.map((row) => row.map(() => -1)), border = new Set();
  let next = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!walls[y][x] || id[y][x] >= 0) continue;
    const stack = [[x, y]]; id[y][x] = next;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx === 0 || cy === 0 || cx === width - 1 || cy === height - 1) border.add(next);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && walls[ny][nx] && id[ny][nx] < 0) { id[ny][nx] = next; stack.push([nx, ny]); }
      }
    }
    next++;
  }
  return { id, border };
}
function disc(g, x, y, r, color) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = color; g.fill(); }
function classicLook(floorStops, wall, accent) {
  return {
    territoryFill: .20, edgeAlpha: .72,
    floor(g, map) {
      const W = map.width * map.cellSize, H = map.height * map.cellSize, grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, floorStops[0]); grad.addColorStop(.48, floorStops[1]); grad.addColorStop(1, floorStops[2]);
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      g.strokeStyle = colorAlpha(accent, .045); g.lineWidth = 1;
      for (let x = 0; x <= map.width; x += 2) { g.beginPath(); g.moveTo(x * map.cellSize, 0); g.lineTo(x * map.cellSize, H); g.stroke(); }
      for (let y = 0; y <= map.height; y += 2) { g.beginPath(); g.moveTo(0, y * map.cellSize); g.lineTo(W, y * map.cellSize); g.stroke(); }
    },
    walls(g, map) {
      const cs = map.cellSize, block = g.createLinearGradient(0, 0, cs, cs);
      block.addColorStop(0, wall[0]); block.addColorStop(.18, "#344357"); block.addColorStop(1, wall[1]);
      forCells(map, (x, y, px, py) => {
        g.fillStyle = "#0a1018"; g.fillRect(px, py + 2, cs, cs);
        roundRect(g, px + 1, py + 1, cs - 2, cs - 3, 3); g.fillStyle = block; g.fill();
        g.fillStyle = "#d6e5f01b"; g.fillRect(px + 3, py + 3, cs - 6, 1.5);
        g.fillStyle = "#0a101833"; g.fillRect(px + 3, py + cs - 5, cs - 6, 2);
      }, true);
    },
  };
}
const ARENA_LOOKS = {
  neon: classicLook(["#1a2a37", "#172a32", "#101923"], ["#526176", "#273345"], "#56edc0"),
  // Older daily replays may still reference these two retired arenas.
  copper: classicLook(["#30251f", "#241f1d", "#171917"], ["#74604e", "#39302a"], "#ffb45f"),
  frost: classicLook(["#1c3040", "#192b39", "#101b2b"], ["#637b91", "#2d435b"], "#8eeaff"),
  city: {
    territoryFill: .4, edgeAlpha: .95, solidTerritory: true, edgeContrast: "#0000004d",
    floor(g, map) {
      const cs = map.cellSize, lane = 6, mid = 3;
      g.fillStyle = "#3a404b"; g.fillRect(0, 0, map.width * cs, map.height * cs);
      forCells(map, (x, y, px, py) => {
        const besideBuilding = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWallAt(map, x + dx, y + dy));
        if (besideBuilding) { g.fillStyle = "#555d6b"; g.fillRect(px, py, cs, cs); g.fillStyle = "#00000026"; g.fillRect(px, py, cs, 1); g.fillRect(px, py, 1, cs); }
        for (let k = 0; k < 3; k++) if (cellHash(x, y, k) < .55) { g.fillStyle = cellHash(x, y, k + 9) < .5 ? "#ffffff0c" : "#00000022"; g.fillRect(px + cellHash(x, y, k + 3) * 17, py + cellHash(x, y, k + 6) * 17, 2, 2); }
        if (besideBuilding) return;
        const row = y % lane === mid, col = x % lane === mid;
        const nearCross = (v) => v % lane === mid - 1 || v % lane === mid + 1;
        g.fillStyle = "#ffffffa8";
        if (row && !col && nearCross(x)) { for (let i = 0; i < 4; i++) g.fillRect(px + 2 + i * 4.5, py + 3, 2.5, cs - 6); }
        else if (col && !row && nearCross(y)) { for (let i = 0; i < 4; i++) g.fillRect(px + 3, py + 2 + i * 4.5, cs - 6, 2.5); }
        else if (row && !col) { g.fillStyle = "#f4d35ec0"; g.fillRect(px + 4, py + cs / 2 - 1, 12, 2); }
        else if (col && !row) { g.fillStyle = "#f4d35ec0"; g.fillRect(px + cs / 2 - 1, py + 4, 2, 12); }
        else if (cellHash(x, y, 30) < .02) { disc(g, px + cs / 2, py + cs / 2, 4.5, "#555c68"); disc(g, px + cs / 2, py + cs / 2, 3.5, "#2c3139"); }
      }, false);
    },
    walls(g, map) {
      const cs = map.cellSize, { id, border } = wallClusters(map);
      const palette = ["#e07a5f", "#5b8fd9", "#f2c14e", "#9aa7bb", "#c38fd8", "#5fbf9f", "#f28fad", "#7fb3e6"];
      forCells(map, (x, y, px, py) => { g.fillStyle = "#00000055"; g.fillRect(px + 3, py + 4, cs, cs); }, true);
      forCells(map, (x, y, px, py) => {
        const cluster = id[y][x], edge = border.has(cluster);
        const roof = edge ? "#4b5363" : palette[Math.floor(cellHash(cluster, 7) * palette.length)];
        g.fillStyle = roof; g.fillRect(px, py, cs, cs);
        g.fillStyle = "#00000030";
        if (!isWallAt(map, x, y - 1)) g.fillRect(px, py, cs, 2);
        if (!isWallAt(map, x - 1, y)) g.fillRect(px, py, 2, cs);
        if (!isWallAt(map, x + 1, y)) g.fillRect(px + cs - 2, py, 2, cs);
        if (!isWallAt(map, x, y - 1)) { g.fillStyle = "#ffffff30"; g.fillRect(px + 2, py + 2, cs - 4, 1.5); }
        if (!isWallAt(map, x, y + 1)) {
          g.fillStyle = mixColor(roof, -.4); g.fillRect(px, py + cs - 6, cs, 6);
          for (let i = 0; i < 4; i++) { g.fillStyle = cellHash(x, y, i + 40) < .6 ? "#ffe39a" : "#262c38"; g.fillRect(px + 2 + i * 4.4, py + cs - 4.5, 2.6, 2.6); }
        }
        if (edge) { if ((x + y) % 2 === 0) { g.fillStyle = "#ffffff0e"; g.fillRect(px + 4, py + 4, cs - 8, cs - 10); } return; }
        const r = cellHash(x, y, 5);
        if (r < .18) { g.fillStyle = "#dfe4ea"; g.fillRect(px + 5, py + 4, 7, 5); g.fillStyle = "#8f98a3"; g.fillRect(px + 6, py + 5.5, 5, 1); g.fillRect(px + 6, py + 7, 5, 1); }
        else if (r < .26) { disc(g, px + 10, py + 8, 4, "#7a4b35"); disc(g, px + 10, py + 8, 2.8, "#a8694a"); }
        else if (r < .33) { disc(g, px + 9, py + 8, 4.5, "#4f9e45"); disc(g, px + 11, py + 7, 2.5, "#74c35f"); }
        else if (r < .41) { g.fillStyle = "#cfeaffaa"; g.fillRect(px + 5, py + 4, 10, 5); g.fillStyle = "#ffffff66"; g.fillRect(px + 5, py + 4, 10, 1.5); }
      }, true);
    },
  },
  park: {
    territoryFill: .55, edgeAlpha: 1, solidTerritory: true, edgeContrast: "#0b2a1299",
    floor(g, map) {
      const cs = map.cellSize, W = map.width * cs, H = map.height * cs;
      g.fillStyle = "#5dab4c"; g.fillRect(0, 0, W, H);
      g.fillStyle = "#ffffff12";
      for (let x = 0; x < map.width; x += 4) g.fillRect(x * cs, 0, cs * 2, H);
      forCells(map, (x, y, px, py) => {
        g.strokeStyle = "#3f8c3a"; g.lineWidth = 1.2;
        for (let k = 0; k < 2; k++) if (cellHash(x, y, k) < .6) {
          const tx = px + 3 + cellHash(x, y, k + 2) * 14, ty = py + 5 + cellHash(x, y, k + 4) * 12;
          g.beginPath(); g.moveTo(tx - 2, ty - 3); g.lineTo(tx, ty); g.lineTo(tx + 2, ty - 3); g.stroke();
        }
        if (cellHash(x, y, 50) < .07) {
          const color = ["#ffffff", "#ffc2dc", "#ffe066", "#cdb4ff"][Math.floor(cellHash(x, y, 51) * 4)];
          const fx = px + 5 + cellHash(x, y, 52) * 10, fy = py + 5 + cellHash(x, y, 53) * 10;
          for (let i = 0; i < 4; i++) disc(g, fx + Math.cos(i * Math.PI / 2) * 2, fy + Math.sin(i * Math.PI / 2) * 2, 1.7, color);
          disc(g, fx, fy, 1.2, "#f4a300");
        }
      }, false);
    },
    walls(g, map) {
      const cs = map.cellSize, { id, border } = wallClusters(map);
      forCells(map, (x, y, px, py) => { g.beginPath(); g.ellipse(px + cs / 2 + 3, py + cs / 2 + 4, 10, 8, 0, 0, Math.PI * 2); g.fillStyle = "#1e4d1a55"; g.fill(); }, true);
      forCells(map, (x, y, px, py) => {
        const cx = px + cs / 2, cy = py + cs / 2;
        if (border.has(id[y][x])) {
          roundRect(g, px - .5, py - .5, cs + 1, cs + 1, 4); g.fillStyle = "#2f7a34"; g.fill();
          disc(g, px + 6, py + 7, 5, "#3a9140"); disc(g, px + 14, py + 12, 5, "#3a9140"); disc(g, px + 7, py + 6, 1.8, "#6cc36c66");
          return;
        }
        const kind = cellHash(x, y, 9);
        const [base, light] = kind < .14 ? ["#ef9fc0", "#f8c8dc"] : kind < .24 ? ["#e3972f", "#f5c04a"] : kind < .6 ? ["#2e8b3e", "#48a94b"] : ["#277a38", "#3f9d45"];
        disc(g, cx, cy - 1, 10.5, base);
        disc(g, cx - 3, cy - 4, 6, light); disc(g, cx + 4, cy - 1, 4, light);
        disc(g, cx - 4, cy - 6, 2.2, "#ffffff38");
        if (kind < .14) for (let i = 0; i < 4; i++) disc(g, px + 4 + cellHash(x, y, 60 + i) * 12, py + 3 + cellHash(x, y, 70 + i) * 12, 1.1, "#ffffff");
      }, true);
    },
  },
  ocean: {
    territoryFill: .55, edgeAlpha: 1, solidTerritory: true, edgeContrast: "#04283d99",
    floor(g, map) {
      const cs = map.cellSize, W = map.width * cs, H = map.height * cs, grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, "#1f97c6"); grad.addColorStop(1, "#11679a");
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      forCells(map, (x, y, px, py) => {
        const nearShore = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWallAt(map, x + dx, y + dy));
        if (nearShore) { g.fillStyle = "#66e0e833"; g.fillRect(px, py, cs, cs); }
        if (cellHash(x, y, 1) < .14) {
          g.strokeStyle = "#ffffff30"; g.lineWidth = 1.2;
          const wx = px + 4 + cellHash(x, y, 2) * 10, wy = py + 8 + cellHash(x, y, 3) * 8;
          g.beginPath(); g.arc(wx, wy, 4, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
          g.beginPath(); g.arc(wx + 6, wy, 4, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
        }
      }, false);
    },
    animate(g, map, time) {
      const W = map.width * map.cellSize, H = map.height * map.cellSize;
      for (let i = 0; i < 22; i++) {
        const glow = (Math.sin(time / 650 + i * 1.7) + 1) / 2;
        if (glow < .7) continue;
        const x = cellHash(i, 3, 91) * W, y = cellHash(i, 5, 92) * H;
        if (isWallAt(map, Math.floor(x / map.cellSize), Math.floor(y / map.cellSize))) continue;
        g.fillStyle = `rgba(255,255,255,${(glow - .7) * 2.6})`; g.fillRect(x - 2, y - .5, 4, 1); g.fillRect(x - .5, y - 2, 1, 4);
      }
    },
    walls(g, map) {
      const cs = map.cellSize, { id, border } = wallClusters(map);
      g.fillStyle = "#ffffffb3"; forCells(map, (x, y, px, py) => { roundRect(g, px - 2.5, py - 2.5, cs + 5, cs + 5, 7); g.fill(); }, true);
      g.fillStyle = "#d4b066"; forCells(map, (x, y, px, py) => { roundRect(g, px - 1, py - 1, cs + 2, cs + 2, 6); g.fill(); }, true);
      g.fillStyle = "#f0d58f"; forCells(map, (x, y, px, py) => {
        roundRect(g, px + .5, py, cs - 1, cs - 2, 5); g.fill();
        if (isWallAt(map, x + 1, y) && x + 1 < map.width) g.fillRect(px + cs / 2, py, cs, cs - 2);
        if (isWallAt(map, x, y + 1) && y + 1 < map.height) g.fillRect(px + .5, py + cs / 2, cs - 1, cs);
      }, true);
      forCells(map, (x, y, px, py) => {
        for (let k = 0; k < 3; k++) { g.fillStyle = "#c9a45c88"; g.fillRect(px + 3 + cellHash(x, y, k + 20) * 14, py + 3 + cellHash(x, y, k + 23) * 12, 1.5, 1.5); }
        const r = cellHash(x, y, 5), edge = border.has(id[y][x]);
        if (!edge && r < .17) {
          g.strokeStyle = "#8a5a2b"; g.lineWidth = 2.2; g.lineCap = "round";
          g.beginPath(); g.moveTo(px + 8, py + 16); g.quadraticCurveTo(px + 7, py + 10, px + 11, py + 6); g.stroke();
          for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + (i - 2) * .75;
            g.save(); g.translate(px + 11, py + 6); g.rotate(a); g.beginPath(); g.ellipse(4.5, 0, 5, 1.8, 0, 0, Math.PI * 2); g.fillStyle = i % 2 ? "#2f9e44" : "#40c057"; g.fill(); g.restore();
          }
          disc(g, px + 10, py + 7, 1.3, "#6b3f1d"); disc(g, px + 12, py + 7.5, 1.3, "#6b3f1d");
        } else if (!edge && r < .31) { disc(g, px + 8, py + 10, 3.5, "#8d99a6"); disc(g, px + 12, py + 12, 2.5, "#a9b4bf"); disc(g, px + 7, py + 9, 1.2, "#ffffff55"); }
        else if (edge ? r < .05 : r < .37) {
          g.save(); g.translate(px + 10, py + 9); g.fillStyle = "#ff8a5c";
          for (let i = 0; i < 5; i++) { g.rotate(Math.PI * 2 / 5); g.beginPath(); g.ellipse(0, -2.4, 1.1, 2.6, 0, 0, Math.PI * 2); g.fill(); }
          g.restore();
        }
      }, true);
    },
  },
};
let arenaCache = { key: "", mapRef: null, floor: null, walls: null, look: null };
function arenaLayers(map, themeId) {
  if (arenaCache.mapRef === map && arenaCache.themeId === themeId) return arenaCache;
  const look = ARENA_LOOKS[themeId] || ARENA_LOOKS.neon;
  const key = `${themeId}|${map.width}x${map.height}|${map.walls.map((row) => row.map(Number).join("")).join("")}`;
  if (arenaCache.key !== key) {
    const layer = () => { const c = document.createElement("canvas"); c.width = map.width * map.cellSize; c.height = map.height * map.cellSize; return c; };
    const floor = layer(), walls = layer();
    look.floor(floor.getContext("2d"), map); look.walls(walls.getContext("2d"), map);
    arenaCache = { key, floor, walls, look };
  }
  arenaCache.mapRef = map; arenaCache.themeId = themeId;
  return arenaCache;
}

function draw(time = 0) {
  requestAnimationFrame(draw);
  advanceDailyReplay();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state?.map) { ctx.fillStyle = "#121925"; ctx.fillRect(0, 0, canvas.width, canvas.height); return; }
  ctx.save();
  if (visualEffectsEnabled && shake.until > performance.now()) {
    const strength = shake.power * (shake.until - performance.now()) / shake.duration;
    ctx.fillStyle = "#0b1019"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate((Math.random() * 2 - 1) * strength, (Math.random() * 2 - 1) * strength);
  }
  const motionTime = visualEffectsEnabled ? time : 0;
  const { width, height, cellSize, walls } = state.map;
  const arena = arenaLayers(state.map, state.theme?.id), look = arena.look;
  ctx.drawImage(arena.floor, 0, 0);
  if (look.animate) look.animate(ctx, state.map, motionTime);
  const players = state.players || [];
  const ownerByCell = new Map();
  for (const player of players) for (const packed of player.territory) ownerByCell.set(packed, player);
  for (const [packed, player] of ownerByCell) {
    const [x, y] = parseCell(packed), px = x * cellSize, py = y * cellSize;
    if (look.solidTerritory) {
      // Gapless paint with a diagonal hatch, so claimed land never blends into grass, water, or asphalt.
      ctx.fillStyle = colorAlpha(player.color, look.territoryFill); ctx.fillRect(px, py, cellSize, cellSize);
      ctx.strokeStyle = "#ffffff26"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py + cellSize); ctx.lineTo(px + cellSize, py); ctx.stroke();
      continue;
    }
    const shade = look.territoryFill + ((x * 17 + y * 31) % 5) * .012;
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
  // Edges sit just inside the owner's cells so two rivals sharing a border each keep their own color.
  const inset = 1.25, far = cellSize - inset;
  for (const player of players) {
    ctx.beginPath();
    for (const packed of player.territory) {
      const [x, y] = parseCell(packed), px = x * cellSize, py = y * cellSize;
      if (ownerByCell.get(`${x},${y - 1}`) !== player) { ctx.moveTo(px, py + inset); ctx.lineTo(px + cellSize, py + inset); }
      if (ownerByCell.get(`${x + 1},${y}`) !== player) { ctx.moveTo(px + far, py); ctx.lineTo(px + far, py + cellSize); }
      if (ownerByCell.get(`${x},${y + 1}`) !== player) { ctx.moveTo(px, py + far); ctx.lineTo(px + cellSize, py + far); }
      if (ownerByCell.get(`${x - 1},${y}`) !== player) { ctx.moveTo(px + inset, py); ctx.lineTo(px + inset, py + cellSize); }
    }
    // Bright arenas get a dark under-stroke so territory edges stay readable on grass and water.
    if (look.edgeContrast) { ctx.strokeStyle = look.edgeContrast; ctx.lineWidth = 3.5; ctx.stroke(); }
    ctx.strokeStyle = colorAlpha(player.color, look.edgeAlpha); ctx.lineWidth = look.edgeContrast ? 2 : 1.5; ctx.shadowColor = colorAlpha(player.color, .55); ctx.shadowBlur = 5; ctx.stroke(); ctx.shadowBlur = 0;
  }
  ctx.drawImage(arena.walls, 0, 0);
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
    if (visualEffectsEnabled) drawMotionTrail(player, pos);
    drawAvatar(player, pos.x, pos.y, motionTime, players);
  }
  drawEmoteBubbles(players);
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
    popups = popups.filter((popup) => now - popup.startedAt < 1000);
    for (const popup of popups) {
      const progress = (now - popup.startedAt) / 1000, pop = progress < .15 ? 1.45 - progress / .15 * .45 : 1;
      ctx.save(); ctx.globalAlpha = progress > .6 ? (1 - progress) / .4 : 1;
      ctx.translate(popup.x, popup.y - progress * 30); ctx.scale(pop, pop);
      ctx.font = `800 ${popup.size}px Inter, "Segoe UI", sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 4; ctx.lineJoin = "round"; ctx.strokeStyle = "#060b12"; ctx.strokeText(popup.text, 0, 0);
      ctx.shadowColor = popup.color; ctx.shadowBlur = 12; ctx.fillStyle = popup.color; ctx.fillText(popup.text, 0, 0);
      ctx.restore();
    }
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
  ctx.restore();
  // Soft vignette focuses attention on the playable maze.
  const vignette = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 170, canvas.width / 2, canvas.height / 2, 680);
  vignette.addColorStop(0, "#050b1400"); vignette.addColorStop(1, "#050b1433");
  ctx.fillStyle = vignette; ctx.fillRect(0, 0, canvas.width, canvas.height);
}
// Glide at a constant pace from where the player is drawn to the newest server position, spread over one
// snapshot interval, so motion stays even instead of surging and pausing between 20 Hz updates.
let snapshotInterval = 50, lastSnapshotAt = 0;
function setTarget(id, x, y, instant = false) {
  const now = performance.now(), rendered = renderPositions.get(id);
  const from = !instant && rendered ? { x: rendered.x, y: rendered.y } : { x, y };
  // Large jumps are respawns; snap instead of sliding across the maze.
  if (Math.hypot(x - from.x, y - from.y) > 60) { from.x = x; from.y = y; motionTrails.delete(id); }
  targets.set(id, { fromX: from.x, fromY: from.y, x, y, at: now });
  if (!rendered) renderPositions.set(id, { x: from.x, y: from.y });
}
function noteSnapshotArrival() {
  const now = performance.now();
  if (lastSnapshotAt) snapshotInterval += (Math.min(120, Math.max(25, now - lastSnapshotAt)) - snapshotInterval) * .2;
  lastSnapshotAt = now;
}
function interpolate(id, x, y) {
  const target = targets.get(id) || { fromX: x, fromY: y, x, y, at: 0 };
  const rendered = renderPositions.get(id) || { x: target.x, y: target.y };
  const progress = Math.min(1, (performance.now() - target.at) / snapshotInterval);
  rendered.x = target.fromX + (target.x - target.fromX) * progress;
  rendered.y = target.fromY + (target.y - target.fromY) * progress;
  renderPositions.set(id, rendered);
  return rendered;
}
function drawEmoteBubbles(players) {
  const now = performance.now(), life = 1800;
  for (const player of players) {
    const bubble = emoteBubbles.get(player.id), pos = renderPositions.get(player.id);
    if (!bubble || !pos) continue;
    const age = now - bubble.startedAt;
    if (age > life) { emoteBubbles.delete(player.id); continue; }
    const pop = age < 140 ? .6 + age / 140 * .4 : 1, fade = age > life - 300 ? (life - age) / 300 : 1;
    ctx.save(); ctx.globalAlpha = fade;
    ctx.font = `700 14px Inter, "Segoe UI", "Segoe UI Emoji", sans-serif`;
    const w = Math.max(34, ctx.measureText(bubble.text).width + 18), h = 26;
    const x = Math.min(Math.max(pos.x, w / 2 + 4), canvas.width - w / 2 - 4), y = Math.max(h + 6, pos.y - 25);
    ctx.translate(x, y); ctx.scale(pop, pop);
    ctx.shadowColor = colorAlpha(player.color, .6); ctx.shadowBlur = 10;
    roundedRect(-w / 2, -h, w, h, 9); ctx.fillStyle = "#0f1722f2"; ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = player.color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-5, -.5); ctx.lineTo(0, 6); ctx.lineTo(5, -.5); ctx.closePath(); ctx.fillStyle = "#0f1722f2"; ctx.fill();
    ctx.fillStyle = "#f4f7fa"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(bubble.text, 0, -h / 2 + .5);
    ctx.restore();
  }
}
function drawMotionTrail(player, pos) {
  const now = performance.now(), boosted = player.speedActive, life = boosted ? 360 : 200, history = motionTrails.get(player.id) || [];
  const last = history[history.length - 1];
  if (!last || Math.hypot(pos.x - last.x, pos.y - last.y) > 1.5) history.push({ x: pos.x, y: pos.y, t: now });
  while (history.length && now - history[0].t > life) history.shift();
  motionTrails.set(player.id, history);
  ctx.save(); ctx.fillStyle = player.color;
  history.forEach((point, index) => {
    const fade = 1 - (now - point.t) / life;
    if (boosted && index % 3 === 0) { ctx.globalAlpha = fade * .3; ctx.beginPath(); ctx.arc(point.x, point.y, 9, 0, Math.PI * 2); ctx.fill(); }
    ctx.globalAlpha = fade * (boosted ? .5 : .28); ctx.beginPath(); ctx.arc(point.x, point.y, 2 + fade * (boosted ? 6 : 4.5), 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
  if (boosted && Math.random() < .4) particles.push({ x: pos.x, y: pos.y, vx: (Math.random() - .5) * 40, vy: (Math.random() - .5) * 40, color: "#ffd45c", startedAt: now, life: 280 });
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
    roomStatusButton.innerHTML = `↩ Back to your room <small>${escapeHtml(roomCode)}</small>`;
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
      roomStatusButton.innerHTML = `↩ Back to your room <small>${escapeHtml(message.code)}</small>`;
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
  const face = facing.get(player.id) || { x: 1, y: 0 };
  paintCharacter(target, { character: player.character, color: player.color || "#57e389", x: 24, y: 26, scale: .95, time, dir: face, mood: characterMood(player, state?.players), seed: player.id.charCodeAt(0) || 0 });
  if (player.shield) { target.strokeStyle = "#84e6ff"; target.lineWidth = 2; target.beginPath(); target.arc(24, 25, 21, 0, Math.PI * 2); target.stroke(); }
}
// Lobby cards and result rows hold small canvases that are repainted only while they are on screen.
function paintPortrait(canvas, options) {
  const g = canvas.getContext("2d"), s = canvas.width / 96;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, canvas.width, canvas.height);
  paintCharacter(g, { x: 48 * s, y: 54 * s, scale: 2.35 * s, ...options });
}
function animatePortraits(time) {
  const t = visualEffectsEnabled ? time : 0;
  if (!roomPanel.classList.contains("hidden")) {
    [...charactersEl.children].forEach((el, index) => {
      const canvas = el.querySelector("canvas"), character = characterOptions.find((c) => c.id === el.dataset.id);
      if (!canvas || !character) return;
      const selected = el.classList.contains("selected"), lively = selected || el.matches(":hover:not(:disabled)");
      const dir = { x: Math.cos(t / 1700 + index * 1.3), y: Math.sin(t / 2300 + index) * .5 };
      paintPortrait(canvas, { character: character.id, color: character.color, time: t, dir, moving: lively && !selected, mood: selected ? "happy" : el.disabled ? "idle" : characterMood({ id: character.id, character: character.id }), seed: index });
    });
  }
  if (!$("#resultOverlay").classList.contains("hidden")) {
    for (const canvas of document.querySelectorAll(".result-avatar")) {
      const player = state?.players?.find((p) => String(p.id) === canvas.dataset.id);
      if (!player) continue;
      const mood = state.draw ? "idle" : state.winnerId === player.id ? "happy" : "worried";
      paintPortrait(canvas, { character: player.character, color: player.color, time: t, dir: { x: 1, y: .2 }, mood, seed: canvas.dataset.id.charCodeAt(0) || 0 });
    }
  }
}
function animateScoreCharacters(time = 0) {
  requestAnimationFrame(animateScoreCharacters); animatePortraits(time); if (!state?.players) return;
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
