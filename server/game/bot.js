import { GAME, cellAt, playerSpeed, setPlayerInput } from "./core.js";

// How often the bot chases your trail, and how often/long it hesitates between moves.
const BRAINS = {
  easy: { hunt: 0.1, hesitateChance: 0.8, hesitateMs: [250, 500] },
  normal: { hunt: 0.22, hesitateChance: 0.5, hesitateMs: [150, 350] },
  hard: { hunt: 0.4, hesitateChance: 0.15, hesitateMs: [80, 160] },
};
const brain = (game) => BRAINS[game.rules?.id] || BRAINS.normal;

const id = (x, y) => `${x},${y}`;
const point = (value) => value.split(",").map(Number);
const same = (a, b) => a?.x === b?.x && a?.y === b?.y;

function findRoute(game, bot, isGoal) {
  const start = cellAt(game, bot.x, bot.y);
  if (game.walls[start.y]?.[start.x]) return [];
  const startKey = id(start.x, start.y), queue = [start], previous = new Map([[startKey, null]]);
  let goal = isGoal(start.x, start.y) ? startKey : null;
  for (let i = 0; i < queue.length && !goal; i++) {
    const at = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = at.x + dx, y = at.y + dy, nextKey = id(x, y);
      if (x < 0 || y < 0 || x >= game.width || y >= game.height || game.walls[y][x] || previous.has(nextKey)) continue;
      previous.set(nextKey, id(at.x, at.y));
      if (isGoal(x, y)) { goal = nextKey; break; }
      queue.push({ x, y });
    }
  }
  if (!goal || goal === startKey) return [];
  const path = [];
  for (let at = goal; at && at !== startKey; at = previous.get(at)) path.push(point(at));
  return path.reverse().map(([x, y]) => ({ x, y }));
}

function chooseRoute(game, bot, opponent, now) {
  const random = game.random;
  const crown = game.crown?.cell;
  const crownKey = crown && id(crown.x, crown.y);
  const here = cellAt(game, bot.x, bot.y);
  if (crown && game.crown.active && bot.trail.length && here.x === crown.x && here.y === crown.y && !bot.territory.has(crownKey)) {
    return findRoute(game, bot, (x, y) => bot.territory.has(id(x, y)));
  }
  if (opponent.trail.length && bot.trail.length < 5 && Math.hypot(bot.x - opponent.x, bot.y - opponent.y) < 300 && random() < brain(game).hunt) {
    const exposed = new Set(opponent.trail);
    const route = findRoute(game, bot, (x, y) => exposed.has(id(x, y)));
    if (route.length) return route;
  }
  if (bot.trail.length >= 7) {
    const owned = new Set(bot.territory);
    const route = findRoute(game, bot, (x, y) => owned.has(id(x, y)));
    if (route.length) return route;
  }
  if (crown && game.crown.active && !bot.territory.has(crownKey)) {
    const route = findRoute(game, bot, (x, y) => x === crown.x && y === crown.y);
    if (route.length) return route;
  }
  const start = cellAt(game, bot.x, bot.y);
  const reachable = [];
  const queue = [{ ...start, distance: 0 }], seen = new Set([id(start.x, start.y)]);
  const claimed = new Set(game.players.flatMap((p) => [...p.territory]));
  const activeTrails = new Set(game.players.flatMap((p) => [...p.trailSet]));
  for (let i = 0; i < queue.length; i++) {
    const at = queue[i];
    if (at.distance >= 4 && at.distance <= 10 && !claimed.has(id(at.x, at.y)) && !activeTrails.has(id(at.x, at.y))) reachable.push(at);
    if (at.distance >= 10) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = at.x + dx, y = at.y + dy, k = id(x, y);
      if (x < 1 || y < 1 || x >= game.width - 1 || y >= game.height - 1 || game.walls[y][x] || seen.has(k)) continue;
      seen.add(k); queue.push({ x, y, distance: at.distance + 1 });
    }
  }
  if (!reachable.length) return findRoute(game, bot, (x, y) => bot.territory.has(id(x, y)));
  const target = reachable[Math.floor(random() * reachable.length)];
  return findRoute(game, bot, (x, y) => x === target.x && y === target.y);
}

export function updateBotInput(game, now = Date.now()) {
  const bot = game.players.find((player) => player.bot);
  if (!bot || game.finished) return;
  const opponent = game.players.find((player) => player !== bot);
  const cell = cellAt(game, bot.x, bot.y);
  // A tick moves a whole step, so tolerances under half a step make the bot overshoot back and forth forever.
  const step = playerSpeed(bot, now) * GAME.tickMs / 1000, aim = Math.max(3, step / 2 + 0.5), arrive = aim + 1.5;
  if (bot.route?.length && Math.abs(bot.x - (bot.route[0].x + 0.5) * game.cellSize) < arrive && Math.abs(bot.y - (bot.route[0].y + 0.5) * game.cellSize) < arrive) bot.route.shift();
  if (!bot.route?.length) {
    const { hesitateChance, hesitateMs: [minMs, maxMs] } = brain(game);
    if (bot.thinkUntil === undefined && game.random() < hesitateChance) bot.thinkUntil = now + minMs + game.random() * (maxMs - minMs);
    if (bot.thinkUntil > now) { setPlayerInput(game, bot.id, {}); return; }
    bot.thinkUntil = undefined;
    bot.route = chooseRoute(game, bot, opponent, now);
  }
  const waypoint = bot.route?.[0];
  if (!waypoint) { setPlayerInput(game, bot.id, {}); return; }
  const tx = (waypoint.x + 0.5) * game.cellSize, ty = (waypoint.y + 0.5) * game.cellSize;
  const input = {};
  if (Math.abs(tx - bot.x) > aim || Math.abs(ty - bot.y) > aim) {
    if (Math.abs(tx - bot.x) >= Math.abs(ty - bot.y)) input[tx > bot.x ? "right" : "left"] = true;
    else input[ty > bot.y ? "down" : "up"] = true;
  }
  setPlayerInput(game, bot.id, input);
  bot.lastCell = cell;
}
