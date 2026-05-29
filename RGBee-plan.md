# RGBee — Workshop Plan

A drop-in-anytime party game: the big screen shows a curated random color, everyone races to guess its hex from their phone, and a living leaderboard keeps it cutthroat. Closest eye wins.

## The pitch in one line

*"You see a color. You type `#______`. Closest eye wins — jump in anytime."*

---

## Core loop

1. **Host** opens the game on a big screen (TV, laptop, projector). A room code + QR + URL appear, and stay visible the whole game so newcomers always know they can join.
2. **Players** join from their phones anytime — between games, mid-game, even mid-round. They enter a name and they're in. If a round is already running and there's still time on the clock, they can jump straight into it.
3. Each round the screen fills with one curated color. Each player's phone shows **the same color, the current round number, and a live countdown**, plus a hex input.
4. Round ends when the timer hits zero (**20s by default**, host-overridable) **or** when everyone active has submitted (whichever comes first — see "force to zero" below).
5. Big reveal: the true color, then **how close everyone was** (all players, ranked by score, swatch next to swatch), with the **top three spotlighted**.
6. The **living leaderboard** updates and stays on screen between rounds. Repeat for as many rounds as you like; host can end anytime for a final winner screen.

The game lives or dies on the **reveal beat** — your `#3A7F2C` sitting next to the real `#2E8B1F`, the gasp, the leaderboard shuffle. Design everything around making that moment land.

---

## Scoring — OKLab

Hex codes get scored by **perceptual distance in OKLab**, which is uniform (a given numeric distance looks like the same amount of "off" to a human regardless of where it is in color space) and avoids the traps of cosine similarity (brightness-blindness, undefined on black).

**Pipeline** (per guess and per target):

1. Hex → sRGB channels in 0–1.
2. Linearize each channel (undo gamma): `c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`.
3. Linear sRGB → LMS via Ottosson's matrix, then cube-root each.
4. LMS' → OKLab `(L, a, b)` via the second matrix.

**Distance:** Euclidean in OKLab — `dist = sqrt(ΔL² + Δa² + Δb²)`.

**Score:** map distance to a friendly 0–100 with an exponential falloff so near-misses still feel rewarding rather than crushed into a narrow band: `score = round(100 * exp(-k * dist))`. `k` is a single tuning knob — playtest it so a "pretty close" guess lands ~85–90 and a wild miss bottoms out low. (Linear mapping feels worse; everything clusters.)

I can hand you a ~30-line pure JS module (`hexToOklab`, `oklabDistance`, `scoreGuess`) that runs identically on the client for previews and on the server for the authoritative score.

### Living leaderboard — show both

The leaderboard displays **two numbers per player: average score per round and cumulative total**, plus rounds played. Rank by **average** — that's what keeps it competitive and fair to latecomers, since someone who joins at round 8 can still shoot to the top with sharp eyes rather than being permanently buried under everyone's accumulated totals. The total sits alongside as the "grinder's" bragging-rights number and the tiebreaker.

One nuance worth a playtest: pure average lets a one-round wonder leapfrog the field. If that feels cheap, gate the top spots behind a small minimum (e.g., must have played ≥3 rounds to hold #1). Easy to add later; the DO already tracks rounds-played per person.

---

## Color generation — pretty, not muddy

Uniform random RGB is the enemy; it piles up in murky mid-tones. Since we're already in OKLab land, generate targets in **OKLCh** (lightness, chroma, hue) and convert to hex. That gives direct control over exactly the dimensions that make a color pleasant:

- **Hue:** uniform 0–360.
- **Chroma:** sampled from a curated band so colors are vivid but not radioactive (and not washed-out gray).
- **Lightness:** kept out of the dead-center muddy zone — bias toward clearly-light or clearly-saturated rather than sludge.
- Clamp/reject anything that falls outside the displayable sRGB gamut after conversion, and resample.

This also unlocks clean **difficulty modes** by just shifting the bands: "Pastels" (high L, low chroma), "Neon" (mid L, high chroma), "Grayscale" (chroma ≈ 0, brutal). Worth a host toggle eventually.

---

## Architecture on Cloudflare

The real-time coordination problem ("Cloudflare always knows the round status, time left, who's submitted") maps perfectly onto **Durable Objects**.

- **One Durable Object per room**, keyed by room code. The DO is the single authoritative source of truth: current round number, target color, round start time, deadline, the player roster, this round's submissions, and cumulative scores. Because a DO is single-threaded, there are no races — it just *knows* the state.
- **WebSocket Hibernation API** for the connections. Every phone and the host screen hold a WebSocket to the room's DO. Hibernation lets the DO evict from memory between bursts while keeping sockets open, so idle rooms cost ~nothing but reconnect instantly.
- **Timer = DO alarm, not setTimeout.** When a round starts, the DO sets `storage.setAlarm(deadline)`. `setTimeout` doesn't survive hibernation; an alarm does. When the alarm fires, the DO ends the round, computes OKLab scores server-side (authoritative — never trust the client's self-reported score), and broadcasts the reveal.
- **Force-to-zero:** every time a submission arrives, the DO checks "have all currently-active players submitted?" If yes, it cancels the alarm and runs the end-round routine immediately. That's trivial here precisely because the DO already holds the full roster and submission set.
- **Late join = free.** A new WebSocket gets a full state snapshot on connect (current round, color, remaining time, live leaderboard), so anyone arriving mid-game is instantly oriented. If a round is live with time remaining, they're dropped straight into it and can submit; if it's already past deadline or in reveal, they're queued for the next round.
- **Time sync:** the DO is the clock authority. It broadcasts the round's absolute deadline as a server timestamp (plus its own "now" for offset correction); phones render the countdown locally but the DO alone decides when the round actually ends. No phone-clock drift can cheat or desync the game.
- **Frontend:** static host screen + phone client served from Workers static assets / Pages. A thin Worker routes the WebSocket upgrade to the right DO via `env.ROOMS.idFromName(code)`.
- Persist roster + scores in **DO storage** (not just memory) so an eviction mid-game never loses the leaderboard.

---

## MVP scope

- Host screen: room code + QR, current color, countdown, reveal, living leaderboard.
- Phone client: join with a name anytime, see color + round + countdown, submit hex.
- DO-backed rounds with alarm timer, force-to-zero, server-side OKLab scoring.
- Reveal showing everyone's closeness + top-three spotlight; cumulative leaderboard; host "end game" → winner screen.

No accounts, no app install, no external DB for the MVP — the DO is the database.

## Stretch ideas

- Difficulty modes via OKLCh band shifts (above).
- Streak bonuses for back-to-back close guesses.
- "Most confidently wrong" comedy award each round.
- Reverse mode: show a hex, tap the matching swatch from a grid.
- Color-blind-friendly mode (intersects with fairness — worth thinking about early).

---

## Naming & brand

**RGBee** — "RGB" + spelling-bee format: round-based, competitive, obvious bee mascot, and the wordmark writes itself (a bee with `#RRGGBB` stripes). Check availability before committing (`rgbee.xyz`, `playrgbee.com`, handles). Backups: **Hexactly**, **Hue Knew**, **Gradient Descent**.

---

## Open questions

- Reveal choreography: dramatic countdown/wipe before showing the target, or instant?
- Player cap per room?
- Do you want a minimum-players-to-start gate, or does round 1 fire whenever the host hits go?
- The one-round-wonder gate on the leaderboard (min rounds to hold #1) — want it from the start, or wait and see if it's actually a problem?
