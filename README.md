# RGBee

RGBee is a drop-in-anytime color-guessing party game. The big screen shows a curated random
color; everyone races to guess its hex from their phone; a living leaderboard keeps it cutthroat.

## How it works — one continual global game, no host

There is no host and no lobby. A single global game runs **forever**, cycling rounds automatically:

```
GUESS (20s)  ->  REVEAL (~8s)  ->  next round  ->  ...
```

- Exactly **one** Durable Object instance (`GameRoom`, keyed `"global"`) owns all state.
- Rounds keep cycling as long as at least one client (player or spectator) is connected.
  When the last client disconnects, the game goes idle (no timer scheduled). On the next
  connection it immediately starts a round, so it always feels "already running."
- The round counter and leaderboard persist across idle periods and DO evictions
  (DO storage is the source of truth; an in-memory cache is just an optimization).
- Round timing is driven entirely by the DO **alarm**, which survives WebSocket hibernation —
  no client clock can cheat, and the server alone decides when a round ends.

## One unified interface

`public/index.html` is the entire frontend (responsive HTML + CSS + JS). It shows the live
color, round number, countdown, and leaderboard, and offers two choices:

- **Type a name to PLAY** — submit hex guesses from your phone.
- **Tap "Just watch / Present"** — enter PRESENTATION mode: a big-screen view with a huge
  color swatch, round/countdown, full leaderboard, a dramatic reveal with a top-3 spotlight,
  and a join QR code + URL.

Same page, same data — phone player vs. projector spectator differ only in layout.

## Develop

```bash
npm install
npm run dev        # local Worker + Durable Object via wrangler
```

Then open the printed local URL. Open a second tab/device and tap "Just watch / Present"
to see the spectator view alongside a player.

Type-check without emitting:

```bash
npm run typecheck
```

## Deploy

```bash
npm run deploy     # npx wrangler deploy
```

This deploys the Worker, the single `GameRoom` Durable Object (SQLite-backed, free-plan
friendly), and the static frontend via Workers Static Assets. The Worker runs first only for
`/ws`; everything else is served straight from `public/`.

## Scoring — all percentages, in OKLab

Color distance is measured in the perceptually-uniform **OKLab** space (Ottosson), not raw RGB,
so "close" means close to how the human eye sees it.

1. Each guess hex and the target are converted to OKLab.
2. Euclidean distance `dist` between guess and target is computed.
3. `score = round(100 * exp(-K_FALLOFF * dist))`, clamped to `0..100` (`K_FALLOFF = 4.0`).
   A pretty-close guess lands around 85-90; a wild miss bottoms out near zero.

Target colors are generated in OKLCh (uniform hue, chroma `0.08..0.22`, lightness `0.50..0.85`),
converted to hex, and resampled if out of the sRGB gamut — this avoids muddy dead-zone colors.

## Volume-aware ranking

A player who nails one lucky round shouldn't outrank someone consistently great over many
rounds. The leaderboard sorts by a **shrinkage-adjusted** score, not the raw average:

```
trueAvg     = rounds > 0 ? total / rounds : 0
rankedScore = (PRIOR_MEAN * PRIOR_WEIGHT + total) / (PRIOR_WEIGHT + rounds)
```

with `PRIOR_MEAN = 55` and `PRIOR_WEIGHT = 3`. Each player starts pulled toward the prior mean
and earns their way off it by playing more rounds. So, for example, 94% over 10 rounds
**outranks** 97% over a single round. Ties on `rankedScore` break by total score descending.

Players are only charged a round when they actually submit a guess, so latecomers and AFK
players are never penalized for rounds they missed.
