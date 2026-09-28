# Territory Rush

**Claim the map. Hold your ground.**

Territory Rush is a fast, browser-based territory-control game. Leave your colored base to draw a trail, close a loop, and claim the tiles inside. Every trip beyond your territory creates an opening your rival can attack.

**Play now:** [territory-rush.onrender.com](https://territory-rush.onrender.com/)

## How to play

- Move with **WASD** or the **arrow keys**.
- Leave your colored territory to draw a trail.
- Return to your territory to close the loop and claim the enclosed area.
- Your exposed trail can be cut by your rival. A cut costs you **12% of your territory** (8% on Easy, 18% on Hard) and sends you back to base. A Shield blocks one hit.
- Collect items by moving over them. Their effects are shown in the in-game field guide.
- Matches last **3 minutes**. The player with the higher final score wins.

### Pickups

| Pickup | Effect |
| --- | --- |
| Speed Boost | Move faster for 5 seconds. |
| Shield | Blocks one trail-cut penalty. |
| Trail-Freeze | Stops your rival from drawing a trail for 3 seconds. |
| Territory Bonus | Claims up to 9 nearby unclaimed tiles. |

### The Crown

The Crown activates with **1:30 remaining** and moves at **0:45**. It always appears on a tile the same walking distance from both bases, so neither player gets a head start. Stand on its tile for 5 seconds to earn a Crown point. Each Crown point adds **4 points** to your final score.

**Final score = territory cells + 4 points per Crown point.**

## Game modes

- **Create Room:** Host a private match and share the room code with a friend.
- **Join Room:** Enter a friend’s five-character room code.
- **Play vs Bot:** Challenge the Rush Bot solo.
- **Arenas:** Choose one of four arenas in the lobby, or 🎲 for a random one: Neon Circuit, Downtown Grid (buildings and streets), Sunny Park (trees and hedges), or Coral Bay (islands and beaches). In multiplayer the room host picks; the Daily Challenge always uses the day's seeded arena. Obstacles are mirrored, so both bases face the same map, and no area can be sealed off. Corner assist slides you around obstacle corners instead of letting you snag on them.
- **Emotes:** Press **1–4** during a match (or click the buttons under the arena) to pop a GG, 😂, "Catch me!" or "Oops" bubble over your character. Rush Bot taunts back when it cuts you.
- **Share result:** The results screen can save an image of your score, stats, and the final board (on desktop it is also copied to the clipboard; on phones it opens the share sheet).
- **Difficulty (Easy / Normal / Hard):** Pick it before creating a room or playing the bot; the room host can change it in the lobby. Harder settings mean faster movement, a bigger loss when your trail is cut, and more land stolen per capture. Against the bot, it also sets how aggressive the Rush Bot plays. The Daily Challenge always uses Normal.
- **Daily Challenge:** Compete on the same daily seed and compare scores on the leaderboard.

Choose a character in the room lobby. Each player must choose a different character. The six characters are Comet, Moss, Blaze, Violet, Sunny, and Berry. Each one has its own animated look (Comet's stardust tail, Moss's sprout, Blaze's flames, Violet's crystal sparkle, Sunny's spinning rays, Berry's leaf cap). Their eyes follow the direction they move, and their faces react to the match: happy after a capture, determined while drawing a trail, worried when the rival is close, dizzy when cut, and shivering when frozen. The characters are cosmetic, so every pick plays the same.

## Run locally

You’ll need Node.js and npm installed.

```bash
git clone https://github.com/sweety-HJH223/Territory-Rush.git
cd Territory-Rush
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser. For development with automatic server restarts, run:

```bash
npm run dev
```

## Built with

- HTML, CSS, and browser JavaScript
- Node.js and WebSockets (`ws`)

## Settings

Use **Settings** in the game lobby to adjust sound volume, toggle music, or turn visual effects on or off.
