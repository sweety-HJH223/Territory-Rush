import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { GAME, createGame, setPlayerInput, tickGame, territoryPercent } from "./game/core.js";
import { updateBotInput } from "./game/bot.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicDir = join(root, "public");
const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const sockets = new Map();
const dailyScoresFile = join(root, "server", "data", "daily-leaderboard.json");
let dailyScores = { days: {} };
try { dailyScores = JSON.parse(readFileSync(dailyScoresFile, "utf8")); } catch { dailyScores = { days: {} }; }
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const characters = [
  { id: "comet", name: "Comet", color: "#45d7ff" },
  { id: "moss", name: "Moss", color: "#57e389" },
  { id: "blaze", name: "Blaze", color: "#ff694f" },
  { id: "violet", name: "Violet", color: "#b58aff" },
  { id: "sunny", name: "Sunny", color: "#ffd45c" },
  { id: "berry", name: "Berry", color: "#ff70b8" },
];

function utcDay() { return new Date().toISOString().slice(0, 10); }
function seededRandom(label) {
  let seed = 2166136261;
  for (const char of String(label)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return () => { seed = (seed + 0x6d2b79f5) | 0; let value = seed; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
function leaderboard(day = utcDay()) { return dailyScores.days?.[day] || []; }
function sendLeaderboard(socket, day = utcDay()) { send(socket, "daily-leaderboard", { day, entries: leaderboard(day).map(({ replay, playerKey, ...entry }, index) => ({ ...entry, rank: index + 1 })) }); }

function createDailyRecorder(game, day) {
  return {
    day, map: { width: game.width, height: game.height, cellSize: game.cellSize, walls: game.walls }, theme: game.theme,
    players: game.players.map((p) => ({ name: p.name, character: p.character, color: p.color, base: p.base })),
    initialTerritories: game.players.map((p) => [...p.territory]), frames: [], events: [],
    lastFrameAt: -250, lastTerritories: game.players.map((p) => new Set(p.territory)),
  };
}

function recordDailyFrame(room, now) {
  const recorder = room.dailyReplay, game = room.game;
  if (!recorder || now < game.startedAt) return;
  const t = Math.min(GAME.durationMs, now - game.startedAt);
  if (t - recorder.lastFrameAt >= 250) {
    recorder.frames.push({
      t, positions: game.players.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
      crown: game.crown.active ? { cell: game.crown.cell, ownerIndex: game.players.findIndex((p) => p.id === game.crown.ownerId), moveInMs: game.crown.moveAt ? Math.max(0, game.crown.moveAt - now) : null, points: game.players.map((p) => p.stats.crownPoints || 0) } : null,
    });
    recorder.lastFrameAt = t;
  }
  game.players.forEach((player, index) => {
    const previous = recorder.lastTerritories[index], current = player.territory;
    const added = [...current].filter((cell) => !previous.has(cell));
    const removed = [...previous].filter((cell) => !current.has(cell));
    if (added.length || removed.length) recorder.events.push({ type: "territory", t, index, added, removed });
    recorder.lastTerritories[index] = new Set(current);
  });
}

function saveDailyResult(room) {
  if (!room.dailyChallenge || room.dailySaved || !room.game) return;
  room.dailySaved = true;
  const game = room.game, playerIndex = game.players.findIndex((p) => !p.bot), player = game.players[playerIndex];
  const entry = {
    name: player.name, playerKey: room.dailyPlayerKey, score: player.territory.size + (player.stats.crownPoints || 0) * 4,
    territoryCells: player.territory.size, crownPoints: player.stats.crownPoints || 0,
    completedAt: new Date().toISOString(),
    replay: {
      day: room.dailyReplay.day, map: room.dailyReplay.map, theme: room.dailyReplay.theme,
      players: room.dailyReplay.players, initialTerritories: room.dailyReplay.initialTerritories,
      frames: room.dailyReplay.frames, events: room.dailyReplay.events, humanIndex: playerIndex,
    },
  };
  const today = leaderboard(room.dailyDay);
  const prior = today.find((item) => item.playerKey === entry.playerKey);
  if (prior && prior.score >= entry.score) return sendLeaderboard([...room.players.values()][0]?.socket, room.dailyDay);
  const entries = [...today.filter((item) => item.playerKey !== entry.playerKey), entry]
    .sort((a, b) => b.score - a.score || a.completedAt.localeCompare(b.completedAt)).slice(0, 10);
  dailyScores.days ??= {};
  dailyScores.days[room.dailyDay] = entries;
  for (const day of Object.keys(dailyScores.days).sort().slice(0, -14)) delete dailyScores.days[day];
  mkdirSync(join(root, "server", "data"), { recursive: true });
  writeFileSync(dailyScoresFile, JSON.stringify(dailyScores));
  const socket = [...room.players.values()][0]?.socket;
  if (socket) sendLeaderboard(socket, room.dailyDay);
}

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname);
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\]|\.\.(?:[/\\]|$))+/, "");
  const file = resolve(publicDir, relative);
  if (!(file === publicDir || file.startsWith(publicDir + sep)) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Territory Rush frontend is not installed yet. Stage 4 adds it.\n");
    return;
  }
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server, path: "/ws" });

function send(socket, type, data = {}) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, ...data }));
}

function broadcast(room, type, data = {}) {
  for (const player of room.players.values()) send(player.socket, type, data);
}

function makeCode() {
  let code;
  do {
    const bytes = randomBytes(5);
    code = [...bytes].map((b) => codeAlphabet[b % codeAlphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function playerList(room) {
  const humans = [...room.players.values()].map((p) => ({ id: p.id, name: p.name, character: p.character, color: p.color, ready: Boolean(p.character) }));
  if (room.botEnabled && room.bot) humans.push({ ...room.bot, ready: true, bot: true });
  return humans;
}

function lobbyUpdate(room) {
  broadcast(room, "lobby", { code: room.code, status: room.status, players: playerList(room) });
}

function sendSnapshot(room) {
  const game = room.game;
  if (!game) return;
  const players = game.players.map((p) => ({
    id: p.id, name: p.name, character: p.character, color: p.color,
    x: p.x, y: p.y, base: p.base,
    territory: [...p.territory], trail: p.trail,
    territoryPercent: territoryPercent(game, p), territoryCells: p.territory.size,
    matchScore: p.territory.size + (p.stats.crownPoints || 0) * 4, shield: p.shield, stats: p.stats,
    speedActive: p.speedUntil > Date.now(), freezeActive: p.freezeUntil > Date.now(), bot: p.bot,
  }));
  const now = Date.now();
  broadcast(room, "state", {
    roomCode: room.code, status: room.status, mode: room.dailyChallenge ? "daily" : "standard", dailyDay: room.dailyDay || null,
    map: { width: game.width, height: game.height, cellSize: game.cellSize, walls: game.walls },
    players, powerUps: game.powerUps, theme: game.theme, crown: game.crown, startedAt: game.startedAt, endsAt: game.endsAt,
    countdownMs: Math.max(0, game.startedAt - now),
    remainingMs: Math.min(GAME.durationMs, Math.max(0, game.endsAt - Math.max(now, game.startedAt))),
    finished: game.finished, winnerId: game.winnerId, draw: game.draw,
    highlights: game.finished ? game.highlights : [],
    effects: game.effects.splice(0),
  });
}

function startMatch(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
  room.rematchVotes = new Set();
  const playerListNow = [...room.players.values()];
  const participants = playerListNow.map((p) => ({ id: p.id, name: p.name, character: p.character, color: p.color }));
  if (room.botEnabled && room.bot) participants.push({ ...room.bot, bot: true });
  const countdownMs = 3_000;
  const options = { players: participants, startDelayMs: countdownMs };
  if (room.dailyChallenge) options.seed = seededRandom(room.dailyDay);
  room.game = createGame(options);
  room.dailySaved = false;
  room.dailyReplay = room.dailyChallenge ? createDailyRecorder(room.game, room.dailyDay) : null;
  room.status = "playing";
  for (const p of playerListNow) send(p.socket, "match-start", { roomCode: room.code, durationMs: GAME.durationMs, countdownMs, theme: room.game.theme, mode: room.dailyChallenge ? "daily" : "standard", dailyDay: room.dailyDay });
  sendSnapshot(room);
}

function addPlayer(room, socket, name = "Player") {
  const id = randomUUID();
  const player = { id, name: String(name).slice(0, 20) || "Player", character: null, color: null, socket };
  room.players.set(id, player);
  sockets.set(socket, { room, player });
  return player;
}

function handleMessage(socket, message) {
  const session = sockets.get(socket);
  if (message.type === "daily-leaderboard-request") return sendLeaderboard(socket);
  if (message.type === "daily-replay-request") {
    const day = String(message.day || utcDay());
    const rank = Math.max(1, Math.min(10, Number(message.rank) || 1));
    const entry = leaderboard(day)[rank - 1];
    if (!entry?.replay) return send(socket, "error", { message: "That daily replay is no longer available." });
    return send(socket, "daily-replay", { entry: { name: entry.name, score: entry.score, rank }, replay: entry.replay });
  }
  if (message.type === "daily-challenge") {
    if (session) return send(socket, "error", { message: "Leave your current room before starting the daily challenge." });
    const room = { code: makeCode(), players: new Map(), status: "waiting", game: null, botEnabled: true, dailyChallenge: true, dailyDay: utcDay(), dailyPlayerKey: /^[\w-]{12,80}$/.test(String(message.playerKey || "")) ? message.playerKey : randomUUID(), cleanupTimer: null };
    rooms.set(room.code, room);
    const human = addPlayer(room, socket, message.name);
    human.character = characters[0].id; human.color = characters[0].color;
    const botCharacter = characters[1];
    room.bot = { id: randomUUID(), name: "Rush Bot", character: botCharacter.id, color: botCharacter.color };
    send(socket, "room-created", { code: room.code, playerId: human.id, characters, solo: true, daily: true });
    startMatch(room);
    return;
  }
  if (message.type === "play-bot") {
    if (session) return send(socket, "error", { message: "This connection is already in a room." });
    const room = { code: makeCode(), players: new Map(), status: "waiting", game: null, botEnabled: true, cleanupTimer: null };
    rooms.set(room.code, room);
    const human = addPlayer(room, socket, message.name);
    const botCharacter = characters[1];
    room.bot = { id: randomUUID(), name: "Rush Bot", character: botCharacter.id, color: botCharacter.color };
    send(socket, "room-created", { code: room.code, playerId: human.id, characters, solo: true });
    lobbyUpdate(room);
    return;
  }
  if (message.type === "create-room") {
    if (session) return send(socket, "error", { message: "This connection is already in a room." });
    const room = { code: makeCode(), players: new Map(), status: "waiting", game: null, cleanupTimer: null };
    rooms.set(room.code, room);
    addPlayer(room, socket, message.name);
    send(socket, "room-created", { code: room.code, playerId: [...room.players.keys()][0], characters });
    lobbyUpdate(room);
    return;
  }
  if (message.type === "join-room") {
    if (session) return send(socket, "error", { message: "This connection is already in a room." });
    const code = String(message.code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.status !== "waiting" || room.botEnabled || room.players.size >= 2) return send(socket, "error", { message: "Room not found or already in a match." });
    const player = addPlayer(room, socket, message.name);
    send(socket, "room-joined", { code: room.code, playerId: player.id, characters });
    lobbyUpdate(room);
    return;
  }
  if (!session) return send(socket, "error", { message: "Create or join a room first." });
  const { room, player } = session;
  if (message.type === "select-character") {
    if (room.status !== "waiting") return;
    const selected = characters.find((character) => character.id === message.characterId);
    if (!selected) return send(socket, "error", { message: "Choose one of the available characters." });
    const alreadyTaken = [...room.players.values()].some((other) => other.id !== player.id && other.character === selected.id)
      || Boolean(room.botEnabled && room.bot?.character === selected.id);
    if (alreadyTaken) return send(socket, "error", { message: "That character is already taken. Choose a different one." });
    player.character = selected.id;
    player.color = selected.color;
    lobbyUpdate(room);
    if (room.botEnabled && player.character) startMatch(room);
    else if (room.players.size === 2 && [...room.players.values()].every((p) => p.character)) startMatch(room);
    return;
  }
  if (message.type === "rematch" && room.status === "finished") {
    room.rematchVotes ??= new Set();
    room.rematchVotes.add(player.id);
    if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
    room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 90_000);
    const requiredVotes = room.players.size;
    if (requiredVotes > 0 && room.rematchVotes.size >= requiredVotes) startMatch(room);
    else broadcast(room, "rematch-pending", { playerId: player.id, message: "A player wants a rematch." });
    return;
  }
  if (message.type === "input" && room.status === "playing" && room.game && !room.game.finished) {
    setPlayerInput(room.game, player.id, message.input);
    return;
  }
  if (message.type === "leave-room") disconnect(socket);
}

function disconnect(socket) {
  const session = sockets.get(socket);
  if (!session) return;
  sockets.delete(socket);
  const { room, player } = session;
  room.players.delete(player.id);
  if (room.status === "playing") {
    room.status = "disconnected";
    if (room.game) {
      room.game.finished = true;
      room.game.winnerId = [...room.players.keys()][0] ?? null;
    }
    broadcast(room, "opponent-disconnected", { message: `${player.name} disconnected. This room has ended.` });
    sendSnapshot(room);
    room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 90_000);
  } else {
    if (!room.players.size) rooms.delete(room.code);
    else lobbyUpdate(room);
  }
}

wss.on("connection", (socket) => {
  send(socket, "welcome", { characters, protocolVersion: 1 });
  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { return send(socket, "error", { message: "Message must be valid JSON." }); }
    if (!message || typeof message.type !== "string") return send(socket, "error", { message: "Message type is required." });
    try { handleMessage(socket, message); }
    catch (error) { console.error("WebSocket message failed:", error); send(socket, "error", { message: "The server could not process that action." }); }
  });
  socket.on("close", () => disconnect(socket));
  socket.on("error", () => disconnect(socket));
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status !== "playing" || !room.game) continue;
    if (room.botEnabled) updateBotInput(room.game, now);
    tickGame(room.game, now);
    if (room.dailyChallenge) recordDailyFrame(room, now);
    if (room.game.finished) {
      room.status = "finished";
      saveDailyResult(room);
      if (!room.cleanupTimer) room.cleanupTimer = setTimeout(() => rooms.delete(room.code), 90_000);
    }
    sendSnapshot(room);
  }
}, GAME.tickMs);

server.listen(port, "0.0.0.0", () => console.log(`Territory Rush server listening at http://localhost:${port}`));
