// Authoritative, dependency-free Territory Rush rules.
// Players move in continuous map coordinates; territory and trails occupy cells.

export const GAME = Object.freeze({
  width: 48,
  height: 32,
  cellSize: 20,
  durationMs: 180_000,
  tickMs: 50,
  playerRadius: 7,
  baseSpeed: 280,
  penaltyFraction: 0.12,
  maxCaptureFraction: 0.09,
  maxBreachCells: 6,
  // A trail tile turns solid after hardenAfterMs, then cracks back to a cuttable tile hardenForMs later,
  // so a hardened trail can block a rival but never trap them for long.
  hardenAfterMs: 4_000,
  hardenForMs: 6_000,
  // Each player's echo replays their own movement from this long ago, and respawns on every multiple of it.
  echoDelayMs: 30_000,
  // The Rewind pickup brings the echo back immediately, following this far behind its owner until the next wave.
  rewindDelayMs: 10_000,
});
// Per-match rules; "normal" matches GAME so the Daily Challenge stays comparable.
export const DIFFICULTIES = Object.freeze({
  easy: { id: "easy", speed: 240, penaltyFraction: 0.08, maxBreachCells: 4 },
  normal: { id: "normal", speed: GAME.baseSpeed, penaltyFraction: GAME.penaltyFraction, maxBreachCells: GAME.maxBreachCells },
  hard: { id: "hard", speed: 310, penaltyFraction: 0.18, maxBreachCells: 10 },
});
export const ARENA_THEMES = [
  { id: "neon", name: "Neon Circuit", accent: "#56edc0" },
  { id: "city", name: "Downtown Grid", accent: "#ffcf5c" },
  { id: "park", name: "Sunny Park", accent: "#8be36b" },
  { id: "ocean", name: "Coral Bay", accent: "#5fd6ff" },
];

const key = (x, y) => `${x},${y}`;
const parseKey = (value) => value.split(",").map(Number);
const inBounds = (map, x, y) => x >= 0 && y >= 0 && x < map.width && y < map.height;
const center = (map, x, y) => ({ x: (x + 0.5) * map.cellSize, y: (y + 0.5) * map.cellSize });
const POWER_TYPES = ["speed", "shield", "freeze", "bonus", "rewind", "lock"];

function carveMaze(width, height, rng) {
  // Odd-sized logical maze cells become 2x2 physical-cell rooms and corridors.
  const grid = Array.from({ length: height }, () => Array(width).fill(true));
  const start = { x: 1, y: 1 };
  grid[start.y][start.x] = false;
  const stack = [start];
  while (stack.length) {
    const at = stack[stack.length - 1];
    const options = [[2, 0], [-2, 0], [0, 2], [0, -2]]
      .map(([dx, dy]) => ({ x: at.x + dx, y: at.y + dy, dx, dy }))
      .filter((p) => p.x > 0 && p.y > 0 && p.x < width - 1 && p.y < height - 1 && grid[p.y][p.x]);
    if (!options.length) { stack.pop(); continue; }
    const next = options[Math.floor(rng() * options.length)];
    grid[at.y + next.dy / 2][at.x + next.dx / 2] = false;
    grid[next.y][next.x] = false;
    stack.push({ x: next.x, y: next.y });
  }
  // Widen the corridors and rooms while retaining a maze-like structure.
  const walls = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) return true;
      return grid[Math.floor(y / 2) * 2 + 1]?.[Math.floor(x / 2) * 2 + 1] ?? true;
    }));
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (!grid[y][x]) walls[y][x] = false;
  }
  return walls;
}

// Small point-symmetric obstacle clusters (buildings, trees, islands) so both bases face the same map.
// Every cluster keeps two open cells to any other wall, so no area can ever be sealed off.
function scatterObstacles(walls, width, height, rng) {
  const bases = [{ x: 4, y: 4 }, { x: width - 5, y: height - 5 }];
  const pairs = 9 + Math.floor(rng() * 4);
  const clear = (x, y) => {
    if (bases.some((b) => Math.abs(x - b.x) <= 4 && Math.abs(y - b.y) <= 4)) return false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (walls[y + dy]?.[x + dx] !== false) return false;
    return true;
  };
  for (let placed = 0, tries = 0; placed < pairs && tries < 500; tries++) {
    const long = 1 + Math.floor(rng() * 3), short = 1 + Math.floor(rng() * 2), turn = rng() < .5;
    const w = turn ? short : long, h = turn ? long : short;
    const x0 = 3 + Math.floor(rng() * (width - 6 - w)), y0 = 3 + Math.floor(rng() * (height - 6 - h));
    const cells = [];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push([x0 + dx, y0 + dy], [width - 1 - x0 - dx, height - 1 - y0 - dy]);
    if (!cells.every(([x, y]) => clear(x, y))) continue;
    for (const [x, y] of cells) walls[y][x] = true;
    placed++;
  }
}

function openBase(walls, cx, cy, radius = 2) {
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) {
    if (y > 0 && x > 0 && y < walls.length - 1 && x < walls[0].length - 1) walls[y][x] = false;
  }
}

export function createGame({ players, seed = Math.random, now = Date.now(), startDelayMs = 0, difficulty = "normal", arena = "random" } = {}) {
  if (!Array.isArray(players) || players.length !== 2) throw new Error("A match requires exactly two players.");
  const rules = DIFFICULTIES[difficulty] || DIFFICULTIES.normal;
  const width = GAME.width, height = GAME.height, cellSize = GAME.cellSize;
  const walls = carveMaze(width, height, seed);
  scatterObstacles(walls, width, height, seed);
  const bases = [{ x: 4, y: 4 }, { x: width - 5, y: height - 5 }];
  bases.forEach((b) => openBase(walls, b.x, b.y));
  const state = {
    width, height, cellSize, walls, rules,
    players: players.map((p, i) => {
      const b = bases[i];
      return {
        id: p.id, name: p.name ?? `Player ${i + 1}`, character: p.character ?? "", color: p.color ?? (i ? "#ef476f" : "#06d6a0"),
        x: center({ cellSize }, b.x, b.y).x, y: center({ cellSize }, b.x, b.y).y,
        base: { ...b }, input: { up: false, down: false, left: false, right: false },
        territory: new Set(), trail: [], trailSet: new Set(), trailTimes: new Map(), trailStart: null, shield: false,
        history: [], echo: null, echoLockedUntil: 0,
        baseSpeed: rules.speed, speedUntil: 0, freezeUntil: 0, connected: true, bot: Boolean(p.bot), touchingTrail: false,
        stats: { claims: 0, trailCuts: 0, powerUpsCollected: 0, cellsClaimed: 0, crownPoints: 0, echoCells: 0, echoCuts: 0, echoesBroken: 0 },
      };
    }),
    startedAt: now + startDelayMs, endsAt: now + startDelayMs + GAME.durationMs, finished: false, winnerId: null, draw: false,
    theme: ((roll) => ARENA_THEMES.find((theme) => theme.id === arena) || ARENA_THEMES[Math.floor(roll * ARENA_THEMES.length)])(seed()),
    effects: [], highlights: [], powerUps: [], random: seed,
  crown: { active: false, cell: null, ownerId: null, activateAt: now + startDelayMs + 90_000, moveAt: now + startDelayMs + 135_000, moveAnnounced: false, nextPointAt: null },
    nextPowerUpAt: now + startDelayMs + 6_000 + Math.floor(seed() * 3_001),
  };
  state.players.forEach((p) => paintBase(state, p));
  state.crown.cell = fairCrownCell(state, { near: { x: width / 2, y: height / 2 } });
  return state;
}

function walkDistances(state, from) {
  const distance = Array.from({ length: state.height }, () => Array(state.width).fill(Infinity));
  const queue = [from];
  distance[from.y][from.x] = 0;
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(state, nx, ny) || state.walls[ny][nx] || distance[ny][nx] !== Infinity) continue;
      distance[ny][nx] = distance[y][x] + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return distance;
}

// Fair means the same walking distance through the maze from both bases, not straight-line distance.
function fairCrownCell(state, { near, awayFrom } = {}) {
  const [fromA, fromB] = state.players.map((player) => walkDistances(state, player.base));
  const occupied = new Set(state.players.flatMap((player) => [...player.territory]));
  const cells = [];
  for (let y = 1; y < state.height - 1; y++) for (let x = 1; x < state.width - 1; x++) {
    if (state.walls[y][x] || fromA[y][x] === Infinity || fromB[y][x] === Infinity) continue;
    cells.push({ x, y, gap: Math.abs(fromA[y][x] - fromB[y][x]), free: !occupied.has(key(x, y)) });
  }
  if (!cells.length) return { x: Math.floor(state.width / 2), y: Math.floor(state.height / 2) };
  const bestGap = Math.min(...cells.map((cell) => cell.gap));
  let pool = cells.filter((cell) => cell.gap <= bestGap + 1);
  if (awayFrom) {
    const distant = pool.filter((cell) => Math.abs(cell.x - awayFrom.x) + Math.abs(cell.y - awayFrom.y) >= 10);
    if (distant.length) pool = distant;
  }
  if (pool.some((cell) => cell.free)) pool = pool.filter((cell) => cell.free);
  const cell = near
    ? pool.sort((a, b) => ((a.x - near.x) ** 2 + (a.y - near.y) ** 2) - ((b.x - near.x) ** 2 + (b.y - near.y) ** 2) || a.y - b.y || a.x - b.x)[0]
    : pool[Math.floor(state.random() * pool.length)];
  if (!cell.free) for (const player of state.players) player.territory.delete(key(cell.x, cell.y));
  return { x: cell.x, y: cell.y };
}

function crownController(state) {
  if (!state.crown.active || !state.crown.cell) return null;
  const packed = key(state.crown.cell.x, state.crown.cell.y);
  return state.players.find((player) => player.territory.has(packed))?.id ?? null;
}

function tickCrown(state, now) {
  const crown = state.crown;
  if (!crown.active && now >= crown.activateAt) {
    crown.active = true;
    crown.cell = fairCrownCell(state, { near: { x: state.width / 2, y: state.height / 2 } });
    state.effects.push({ type: "crown-active", cell: crown.cell });
  }
  if (crown.active && crown.moveAt && now >= crown.moveAt - 5_000 && !crown.moveAnnounced) {
    crown.moveAnnounced = true;
    state.effects.push({ type: "crown-moving", inMs: Math.max(0, crown.moveAt - now) });
  }
  if (crown.active && crown.moveAt && now >= crown.moveAt) {
    crown.cell = fairCrownCell(state, { awayFrom: crown.cell });
    crown.moveAt = null;
    crown.ownerId = null;
    crown.nextPointAt = null;
    state.effects.push({ type: "crown-moved", cell: crown.cell });
  }
  if (!crown.active) return;
  const controller = crownController(state);
  if (controller !== crown.ownerId) {
    crown.ownerId = controller;
    crown.nextPointAt = controller ? now + 5_000 : null;
    if (controller) state.effects.push({ type: "crown-control", playerId: controller });
  } else if (controller && now >= crown.nextPointAt) {
    const player = state.players.find((item) => item.id === controller);
    player.stats.crownPoints++;
    crown.nextPointAt = now + 5_000;
    state.effects.push({ type: "crown-point", playerId: controller, points: player.stats.crownPoints });
  }
}

function matchScore(player) { return player.territory.size + (player.stats.crownPoints || 0) * 4; }

function paintBase(state, player) {
  for (let y = player.base.y - 2; y <= player.base.y + 2; y++) for (let x = player.base.x - 2; x <= player.base.x + 2; x++) {
    if (inBounds(state, x, y) && !state.walls[y][x]) player.territory.add(key(x, y));
  }
}

export function cellAt(state, x, y) {
  return { x: Math.floor(x / state.cellSize), y: Math.floor(y / state.cellSize) };
}

function clearTrail(entity) {
  entity.trail = []; entity.trailSet.clear(); entity.trailTimes.clear(); entity.trailStart = null;
}

export function isHardened(entity, cell, now) {
  const placedAt = entity.trailTimes?.get(cell);
  if (placedAt === undefined) return false;
  const age = now - placedAt;
  return age >= GAME.hardenAfterMs && age < GAME.hardenAfterMs + GAME.hardenForMs;
}

// [cell, msUntilItCracks] for every hardened tile of a player's or echo's trail.
export function hardenedTrail(entity, now) {
  const hard = [];
  for (const cell of entity.trail) if (isHardened(entity, cell, now)) hard.push([cell, GAME.hardenAfterMs + GAME.hardenForMs - (now - entity.trailTimes.get(cell))]);
  return hard;
}

const trailOwners = (player) => (player.echo?.alive ? [player, player.echo] : [player]);

// Cells this player cannot walk through: the hardened trail tiles of every rival and their echo.
export function solidCellsFor(state, player, now) {
  const solid = new Set();
  for (const rival of state.players) {
    if (rival.id === player.id) continue;
    for (const entity of trailOwners(rival)) for (const cell of entity.trail) if (isHardened(entity, cell, now)) solid.add(cell);
  }
  return solid;
}

function collidesWithWall(state, x, y, solid = null) {
  const r = GAME.playerRadius, s = state.cellSize;
  const minX = Math.floor((x - r) / s), maxX = Math.floor((x + r) / s);
  const minY = Math.floor((y - r) / s), maxY = Math.floor((y + r) / s);
  for (let cy = minY; cy <= maxY; cy++) for (let cx = minX; cx <= maxX; cx++) {
    if (!inBounds(state, cx, cy) || state.walls[cy][cx] || solid?.has(key(cx, cy))) {
      const nx = Math.max(cx * s, Math.min(x, (cx + 1) * s));
      const ny = Math.max(cy * s, Math.min(y, (cy + 1) * s));
      if ((x - nx) ** 2 + (y - ny) ** 2 < r ** 2) return true;
    }
  }
  return false;
}

export function playerSpeed(player, now) {
  const base = player.baseSpeed ?? GAME.baseSpeed;
  return player.speedUntil > now ? base * 1.6 : base;
}

// Returns how much of the distance could not be travelled because a wall was in the way.
function moveAxis(state, player, axis, distance, solid) {
  // Small sub-steps let players slide flush against walls instead of stopping a whole step short.
  const steps = Math.ceil(Math.abs(distance) / 2);
  if (!steps) return 0;
  const step = distance / steps;
  for (let i = 0; i < steps; i++) {
    const nx = axis === "x" ? player.x + step : player.x, ny = axis === "y" ? player.y + step : player.y;
    if (collidesWithWall(state, nx, ny, solid)) return Math.abs(step) * (steps - i);
    player.x = nx; player.y = ny;
  }
  return 0;
}

// Corner assist: when a straight move clips an obstacle corner, slide toward the lane centre so the
// player rounds the corner instead of grinding against it.
function assistCorner(state, player, axis, blocked, solid) {
  const other = axis === "x" ? "y" : "x", centre = (Math.floor(player[other] / state.cellSize) + .5) * state.cellSize;
  const offset = centre - player[other];
  if (Math.abs(offset) < .01) return;
  moveAxis(state, player, other, Math.sign(offset) * Math.min(Math.abs(offset), blocked), solid);
}

function movePlayer(state, player, dt, now, hardCells) {
  const input = player.input;
  const dx = Number(input.right) - Number(input.left), dy = Number(input.down) - Number(input.up);
  if (!dx && !dy) return;
  // A player already overlapping a tile that just hardened may walk out of it freely.
  const solid = hardCells?.size && !collidesWithWall(state, player.x, player.y, hardCells) ? hardCells : null;
  const length = Math.hypot(dx, dy), speed = playerSpeed(player, now);
  // Axis-separated collision allows sliding along walls.
  const blockedX = dx ? moveAxis(state, player, "x", dx / length * speed * dt, solid) : 0;
  const blockedY = dy ? moveAxis(state, player, "y", dy / length * speed * dt, solid) : 0;
  if (blockedX && !dy) assistCorner(state, player, "x", blockedX, solid);
  if (blockedY && !dx) assistCorner(state, player, "y", blockedY, solid);
}

function ownedRoute(state, player, fromKey, toKey) {
  const queue = [fromKey], previous = new Map([[fromKey, null]]);
  for (let i = 0; i < queue.length; i++) {
    const here = queue[i];
    if (here === toKey) break;
    const [x, y] = parseKey(here);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const next = key(x + dx, y + dy);
      if (player.territory.has(next) && !previous.has(next)) { previous.set(next, here); queue.push(next); }
    }
  }
  if (!previous.has(toKey)) return [];
  const path = [];
  for (let at = toKey; at; at = previous.get(at)) path.push(at);
  return path.reverse();
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (((a.y > y) !== (b.y > y)) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function captureLoop(state, player, closingCell) {
  const closing = parseKey(closingCell);
  const startBoundary = player.trailStart || player.trail[0];
  const route = ownedRoute(state, player, startBoundary, closingCell);
  const boundary = [
    ...player.trail.map((packed) => { const [x, y] = parseKey(packed); return { x: x + 0.5, y: y + 0.5 }; }),
    { x: closing[0] + 0.5, y: closing[1] + 0.5 },
    ...route.slice(0, -1).reverse().map((packed) => { const [x, y] = parseKey(packed); return { x: x + 0.5, y: y + 0.5 }; }),
  ];
  const outline = new Set(player.trailSet);
  outline.add(closingCell);
  // Rivals are matched by id because an echo claims for its owner, whose player object is not the echo.
  const enemyCells = new Set(state.players.filter((p) => p.id !== player.id).flatMap((p) => [...p.territory]));
  const capturable = [], breached = [];
  const paintable = state.width * state.height - state.walls.flat().filter(Boolean).length;
  const captureLimit = Math.max(12, Math.floor(paintable * GAME.maxCaptureFraction));
  const distanceToOutline = (x, y) => {
    let closest = Infinity;
    for (const packed of outline) {
      const [ox, oy] = parseKey(packed);
      closest = Math.min(closest, Math.abs(x - ox) + Math.abs(y - oy));
      if (closest <= 1) return closest;
    }
    return closest;
  };
  for (let y = 0; y < state.height; y++) for (let x = 0; x < state.width; x++) {
    const k = key(x, y);
    if (state.walls[y][x] || player.territory.has(k) || !(outline.has(k) || insidePolygon(x + 0.5, y + 0.5, boundary))) continue;
    if (!enemyCells.has(k)) capturable.push({ k, distance: distanceToOutline(x, y) });
    else {
      const rival = state.players.find((p) => p.id !== player.id && p.territory.has(k));
      if (rival && (Math.abs(x - rival.base.x) > 2 || Math.abs(y - rival.base.y) > 2)) breached.push({ k, rival, distance: distanceToOutline(x, y) });
    }
  }
  capturable.sort((a, b) => a.distance - b.distance || a.k.localeCompare(b.k));
  breached.sort((a, b) => a.distance - b.distance || a.k.localeCompare(b.k));
  const capturedCells = capturable.slice(0, captureLimit).map(({ k }) => k);
  for (const packed of capturedCells) player.territory.add(packed);
  const breachCells = breached.slice(0, state.rules?.maxBreachCells ?? GAME.maxBreachCells);
  for (const { k, rival } of breachCells) { rival.territory.delete(k); player.territory.add(k); }
  const claimed = capturedCells.length + breachCells.length;
  clearTrail(player);
  player.route = [];
  if (claimed) { player.stats.claims++; player.stats.cellsClaimed += claimed; }
  if (claimed && player.isEcho) player.stats.echoCells += claimed;
  state.effects.push({ type: "claim", playerId: player.id, cells: claimed, breached: breachCells.length, echo: Boolean(player.isEcho) });
  if (claimed) {
    const item = { kind: "capture", playerId: player.id, name: player.name, color: player.color, trail: [...boundary.map(({ x, y }) => key(Math.floor(x), Math.floor(y)))], cells: [...capturedCells, ...breachCells.map(({ k }) => k)], score: claimed };
    const previous = state.highlights.find((entry) => entry.kind === "capture");
    if (!previous || claimed > previous.score) state.highlights = [...state.highlights.filter((entry) => entry.kind !== "capture"), item];
    state.effects.push({ type: "capture-replay", ...item });
  }
}

function traceTrail(state, player, now) {
  const { x, y } = cellAt(state, player.x, player.y);
  if (!inBounds(state, x, y)) return;
  const k = key(x, y);
  if (player.territory.has(k)) {
    if (player.trail.length) captureLoop(state, player, k);
    return;
  }
  if (state.walls[y][x] || player.trailSet.has(k)) return;
  // Crossing the opponent's claimed land does not convert it; it remains a boundary.
  if (!player.trail.length) {
    const neighbor = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dy]) => key(x + dx, y + dy))
      .find((candidate) => player.territory.has(candidate));
    player.trailStart = neighbor || player.base && key(player.base.x, player.base.y);
  }
  player.trail.push(k); player.trailSet.add(k); player.trailTimes.set(k, now);
}

function loseTerritory(state, player) {
  const target = Math.max(1, Math.floor(player.territory.size * (state.rules?.penaltyFraction ?? GAME.penaltyFraction)));
  const candidates = [...player.territory].filter((k) => {
    const [x, y] = parseKey(k);
    return Math.abs(x - player.base.x) > 2 || Math.abs(y - player.base.y) > 2;
  }).map((k) => {
    const [x, y] = parseKey(k);
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return !inBounds(state, nx, ny) || state.walls[ny][nx] || !player.territory.has(key(nx, ny));
    });
    return { k, edge };
  }).sort((a, b) => Number(b.edge) - Number(a.edge));
  for (const item of candidates.slice(0, target)) player.territory.delete(item.k);
}

// Returns false when a Shield absorbed the hit.
function penalize(state, owner, now, hitCell, byEcho = false) {
  if (owner.shield) { owner.shield = false; state.effects.push({ type: "shield-block", playerId: owner.id }); return false; }
  const cutTrail = [...owner.trail];
  loseTerritory(state, owner);
  owner.stats.trailCuts++;
  clearTrail(owner);
  owner.route = [];
  const spawn = center(state, owner.base.x, owner.base.y);
  owner.x = spawn.x; owner.y = spawn.y;
  const effect = { type: "penalty", playerId: owner.id, at: now, trail: cutTrail, color: owner.color, hitCell, byEcho };
  state.effects.push(effect);
  if (cutTrail.length) {
    const previous = state.highlights.find((entry) => entry.kind === "cut");
    if (!previous || cutTrail.length > previous.score) state.highlights = [...state.highlights.filter((entry) => entry.kind !== "cut"), { kind: "cut", playerId: owner.id, name: owner.name, color: owner.color, trail: cutTrail, hitCell, score: cutTrail.length }];
  }
  return true;
}

function spawnPowerUp(state, now) {
  const existing = new Set(state.powerUps.map((power) => power.type));
  const available = POWER_TYPES.filter((type) => !existing.has(type));
  if (!available.length) return;
  const candidates = [];
  for (let y = 1; y < state.height - 1; y++) for (let x = 1; x < state.width - 1; x++) {
    const k = key(x, y);
    if (state.walls[y][x] || state.players.some((p) => p.territory.has(k) || p.trailSet.has(k))) continue;
    candidates.push({ x, y });
  }
  if (!candidates.length) return;
  const random = state.random;
  const cell = candidates[Math.floor(random() * candidates.length)];
  const type = available[Math.floor(random() * available.length)];
  const power = { id: `${now}-${Math.floor(random() * 1e9)}`, type, ...cell, expiresAt: now + 20_000 };
  state.powerUps.push(power);
  state.effects.push({ type: "power-spawn", powerUp: { ...power } });
}

function grantBonus(state, player) {
  const origin = cellAt(state, player.x, player.y);
  const occupied = new Set(state.players.flatMap((p) => [...p.territory]));
  const candidates = [];
  for (let y = 1; y < state.height - 1; y++) for (let x = 1; x < state.width - 1; x++) {
    const k = key(x, y);
    if (!state.walls[y][x] && !occupied.has(k) && !player.trailSet.has(k)) candidates.push({ x, y, k, d: (x - origin.x) ** 2 + (y - origin.y) ** 2 });
  }
  candidates.sort((a, b) => a.d - b.d);
  const gained = candidates.slice(0, 9);
  for (const cell of gained) player.territory.add(cell.k);
  if (gained.length) { player.stats.claims++; player.stats.cellsClaimed += gained.length; }
  state.effects.push({ type: "claim", playerId: player.id, cells: gained.length, bonus: true });
}

function collectPowerUps(state, player, now) {
  const { x, y } = cellAt(state, player.x, player.y);
  const index = state.powerUps.findIndex((power) => power.x === x && power.y === y);
  if (index < 0) return;
  const [power] = state.powerUps.splice(index, 1);
  if (power.type === "speed") player.speedUntil = Math.max(player.speedUntil, now + 5_000);
  if (power.type === "shield") player.shield = true;
  if (power.type === "freeze") {
    const opponent = state.players.find((p) => p !== player);
    if (opponent) opponent.freezeUntil = Math.max(opponent.freezeUntil, now + 3_000);
  }
  if (power.type === "bonus") grantBonus(state, player);
  const generation = Math.floor((now - state.startedAt) / GAME.echoDelayMs);
  if (power.type === "rewind") {
    const delay = Math.min(GAME.rewindDelayMs, Math.max(0, now - state.startedAt));
    spawnEcho(state, player, generation, sampleAt(player.history, now - delay) || player, delay);
  }
  if (power.type === "lock") {
    const opponent = state.players.find((p) => p.id !== player.id);
    if (opponent) {
      opponent.echoLockedUntil = generation + 1;
      if (opponent.echo?.alive) breakEcho(state, opponent, null, player, true);
    }
  }
  player.stats.powerUpsCollected++;
  state.effects.push({ type: "power-collect", powerType: power.type, playerId: player.id });
}

function tickPowerUps(state, now) {
  const expired = state.powerUps.filter((power) => power.expiresAt <= now);
  state.powerUps = state.powerUps.filter((power) => power.expiresAt > now);
  for (const power of expired) state.effects.push({ type: "power-expire", powerType: power.type });
  if (now >= state.nextPowerUpAt) {
    spawnPowerUp(state, now);
    state.nextPowerUpAt = now + 8_000 + Math.floor(state.random() * 4_001);
  }
}

// Latest recorded position at or before `time`; history is ordered by time.
function sampleAt(history, time) {
  let lo = 0, hi = history.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (history[mid].at <= time) { found = history[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// An echo shares its owner's territory and stats, so everything it claims counts for the owner.
// A regular wave is skipped while an Echo Lock covers it; a Rewind always goes through.
function spawnEcho(state, player, generation, sample, delay) {
  const rewind = delay !== GAME.echoDelayMs, locked = !rewind && generation <= player.echoLockedUntil;
  player.echo = {
    id: player.id, name: player.name, color: player.color, isEcho: true, generation, delay, alive: !locked,
    territory: player.territory, base: player.base, stats: player.stats,
    x: sample.x, y: sample.y, trail: [], trailSet: new Set(), trailTimes: new Map(), trailStart: null, touchingTrail: false,
  };
  state.effects.push(locked ? { type: "echo-blocked", playerId: player.id } : { type: "echo-spawn", playerId: player.id, generation, rewind });
}

function moveEcho(state, player, at) {
  const generation = Math.floor((at - state.startedAt) / GAME.echoDelayMs), history = player.history;
  while (history.length > 1 && history[1].at <= at - GAME.echoDelayMs) history.shift();
  if (generation >= 1 && (player.echo?.generation ?? 0) < generation) {
    const sample = sampleAt(history, at - GAME.echoDelayMs);
    if (sample) spawnEcho(state, player, generation, sample, GAME.echoDelayMs);
    return;
  }
  const echo = player.echo;
  if (!echo?.alive) return;
  const sample = sampleAt(history, at - echo.delay);
  if (!sample) return;
  // A jump means the owner respawned at that moment; drop the trail rather than closing a loop across the map.
  if (Math.hypot(sample.x - echo.x, sample.y - echo.y) > state.cellSize * 1.5) clearTrail(echo);
  echo.x = sample.x; echo.y = sample.y;
}

function breakEcho(state, owner, hitCell, breaker, byLock = false) {
  const echo = owner.echo;
  state.effects.push({ type: "echo-broken", playerId: owner.id, trail: [...echo.trail], hitCell, color: owner.color, byLock });
  if (breaker) breaker.stats.echoesBroken++;
  echo.alive = false;
  clearTrail(echo);
}

// An echo cuts the rival's trail like its owner would; the rival breaks the echo by touching the echo's trail.
function resolveEchoContacts(state, now) {
  for (const owner of state.players) {
    if (!owner.echo?.alive) continue;
    const echo = owner.echo, rival = state.players.find((p) => p.id !== owner.id);
    if (!rival) continue;
    const at = cellAt(state, echo.x, echo.y), echoCell = key(at.x, at.y);
    const touching = rival.trailSet.has(echoCell) && !isHardened(rival, echoCell, now);
    if (touching && !echo.touchingTrail && penalize(state, rival, now, echoCell, true)) owner.stats.echoCuts++;
    echo.touchingTrail = touching;
    const rivalAt = cellAt(state, rival.x, rival.y), rivalCell = key(rivalAt.x, rivalAt.y);
    if (rival.connected && echo.trailSet.has(rivalCell) && !isHardened(echo, rivalCell, now)) breakEcho(state, owner, rivalCell, rival);
  }
}

export function territoryPercent(state, player) {
  const paintable = state.width * state.height - state.walls.flat().filter(Boolean).length;
  return paintable ? player.territory.size / paintable * 100 : 0;
}

export function tickGame(state, now = Date.now()) {
  if (state.finished) return state;
  if (now < state.startedAt) return state;
  const dt = Math.min(GAME.tickMs, Math.max(0, now - (state.lastTickAt ?? now))) / 1000;
  state.lastTickAt = now;
  tickPowerUps(state, now);
  tickCrown(state, now);
  // Split fast ticks so nobody moves more than ~3/4 of a cell per step and trails never skip a cell.
  const fastest = Math.max(...state.players.map((player) => playerSpeed(player, now)));
  const subSteps = Math.max(1, Math.ceil(fastest * dt / (state.cellSize * 0.75)));
  const hardCells = new Map(state.players.map((player) => [player.id, solidCellsFor(state, player, now)]));
  for (let step = 0; step < subSteps; step++) {
    // Each sub-step is recorded with its own timestamp so echoes replay the same cell-by-cell path.
    const at = now - dt * 1000 * (subSteps - 1 - step) / subSteps;
    for (const player of state.players) if (player.connected) movePlayer(state, player, dt / subSteps, now, hardCells.get(player.id));
    for (const player of state.players) { player.history.push({ at, x: player.x, y: player.y }); moveEcho(state, player, at); }
    for (const player of state.players) if (player.connected) collectPowerUps(state, player, now);
    for (const player of state.players) if (player.connected && player.freezeUntil <= now) traceTrail(state, player, now);
    for (const player of state.players) if (player.echo?.alive) traceTrail(state, player.echo, now);
    // Detect every cut before applying any, so simultaneous cuts hit both players instead of favoring player one.
    const cuts = state.players.map((toucher, i) => {
      const victim = state.players[1 - i], position = cellAt(state, toucher.x, toucher.y), cell = key(position.x, position.y);
      const touching = victim.trailSet.has(cell) && !isHardened(victim, cell, now), fresh = touching && !toucher.touchingTrail;
      toucher.touchingTrail = touching;
      return fresh ? { victim, cell } : null;
    });
    for (const cut of cuts) if (cut) penalize(state, cut.victim, now, cut.cell);
    resolveEchoContacts(state, now);
  }
  if (now >= state.endsAt) {
    const [a, b] = state.players.map(matchScore);
    state.finished = true; state.draw = a === b;
    state.winnerId = state.draw ? null : state.players[a > b ? 0 : 1].id;
    state.effects.push({ type: "finished", winnerId: state.winnerId, draw: state.draw });
  }
  return state;
}

export function setPlayerInput(state, playerId, input) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return false;
  for (const direction of ["up", "down", "left", "right"]) player.input[direction] = input?.[direction] === true;
  return true;
}
