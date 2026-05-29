/// <reference types="@cloudflare/workers-types" />

import { scoreGuess, randomTargetColor, rankedScore } from './oklab';

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// ---------------------------------------------------------------------------
// Tunable lifecycle constants
// ---------------------------------------------------------------------------

const ROUND_MS = 20000; // length of the GUESS phase
const REVEAL_MS = 8000; // length of the REVEAL phase

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'guess' | 'reveal' | 'idle';

interface Oklab {
  L: number;
  a: number;
  b: number;
}

interface PlayerRecord {
  name: string;
  total: number; // sum of percentage scores across submitted rounds
  rounds: number; // count of rounds the player actually submitted
}

interface Submission {
  hex: string;
  score?: number; // computed at guess time, withheld from others until reveal
}

interface Attachment {
  playerId?: string;
  role: 'player' | 'spectator';
}

interface LeaderboardEntry {
  playerId: string;
  name: string;
  rankedScore: number;
  trueAvg: number;
  rounds: number;
  total: number;
  connected: boolean;
}

interface ResultEntry {
  playerId: string;
  name: string;
  guess: string;
  score: number;
  rank: number;
}

// ---------------------------------------------------------------------------
// GameRoom Durable Object
// ---------------------------------------------------------------------------

export class GameRoom implements DurableObject {
  private ctx: DurableObjectState;
  private env: Env;

  // Persisted (source of truth = storage; these are the in-memory cache).
  private round = 0;
  private phase: Phase = 'idle';
  private target = '#000000';
  private targetOklab: Oklab = { L: 0, a: 0, b: 0 };
  private deadline = 0;
  private revealEndsAt = 0;
  private submissions = new Map<string, Submission>(); // current round only
  private players = new Map<string, PlayerRecord>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    this.ctx.blockConcurrencyWhile(async () => {
      await this.hydrate();
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private async hydrate(): Promise<void> {
    const s = this.ctx.storage;
    this.round = (await s.get<number>('round')) ?? 0;
    this.phase = (await s.get<Phase>('phase')) ?? 'idle';
    this.target = (await s.get<string>('target')) ?? '#000000';
    this.targetOklab =
      (await s.get<Oklab>('targetOklab')) ?? { L: 0, a: 0, b: 0 };
    this.deadline = (await s.get<number>('deadline')) ?? 0;
    this.revealEndsAt = (await s.get<number>('revealEndsAt')) ?? 0;

    const subs = await s.get<[string, Submission][]>('submissions');
    this.submissions = new Map(subs ?? []);

    const pls = await s.get<[string, PlayerRecord][]>('players');
    this.players = new Map(pls ?? []);
  }

  private async persist(): Promise<void> {
    // Single batched put so persistence is atomic: an eviction can never leave
    // players written but submissions stale (or vice versa), which would
    // otherwise produce an inconsistent hydrate / double-count on replay.
    await this.ctx.storage.put({
      round: this.round,
      phase: this.phase,
      target: this.target,
      targetOklab: this.targetOklab,
      deadline: this.deadline,
      revealEndsAt: this.revealEndsAt,
      submissions: [...this.submissions.entries()],
      players: [...this.players.entries()],
    });
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Default identity: a spectator until they explicitly join/watch.
    const attachment: Attachment = { role: 'spectator' };
    server.serializeAttachment(attachment);

    // Hibernation API: the DO will receive webSocketMessage/Close/Error.
    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'hello':
        await this.onHello(ws, msg);
        break;
      case 'join':
        await this.onJoin(ws, msg);
        break;
      case 'watch':
        await this.onWatch(ws);
        break;
      case 'guess':
        await this.onGuess(ws, msg);
        break;
      default:
        break;
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    // Mark roster connection state so the leaderboard reflects reality.
    const att = this.attachmentOf(ws);
    try {
      ws.close();
    } catch {
      // already closing
    }

    // If this was the last connected client, we do NOT immediately go idle;
    // the current alarm cycle will finish and alarm() will detect zero
    // clients and goIdle() instead of starting the next round. But we should
    // not leave a guess round hanging forever waiting on a now-gone player:
    // re-evaluate force-to-zero among the *remaining* connected players.
    const now = Date.now();
    if (this.phase === 'guess' && now < this.deadline) {
      // Exclude the closing socket: under the Hibernation API it is still
      // returned by getWebSockets() here, so without exclusion the departing
      // (possibly un-submitted) player would be counted and the round would
      // hang until the ROUND_MS alarm.
      if (this.allConnectedPlayersSubmitted(ws)) {
        await this.ctx.storage.deleteAlarm();
        await this.endRound();
        return;
      }
    }

    // Roster changed (a player may have disconnected): push a leaderboard
    // update so spectators see connected flags flip.
    if (att?.role === 'player') {
      this.broadcast({
        type: 'leaderboard',
        leaderboard: this.buildLeaderboard(),
        serverNow: now,
      });
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private async onHello(ws: WebSocket, msg: any): Promise<void> {
    const playerId: string | undefined =
      typeof msg.playerId === 'string' && msg.playerId ? msg.playerId : undefined;

    // A returning player: re-bind their connection to their existing record.
    if (playerId && this.players.has(playerId)) {
      const rec = this.players.get(playerId)!;
      ws.serializeAttachment({ playerId, role: 'player' } as Attachment);
      this.send(ws, { type: 'you', playerId, name: rec.name });
    } else {
      // Unknown / new: stays a spectator until they send join or watch.
      ws.serializeAttachment({ role: 'spectator' } as Attachment);
    }

    // Always send a fresh snapshot and ensure the game is running if idle.
    await this.ensureRunning();
    this.send(ws, this.buildSnapshot(ws));
  }

  private async onJoin(ws: WebSocket, msg: any): Promise<void> {
    const rawName = typeof msg.name === 'string' ? msg.name.trim() : '';
    const name = (rawName || 'Anonymous').slice(0, 32);

    const existing = this.attachmentOf(ws);
    let playerId: string | undefined =
      existing?.playerId && this.players.has(existing.playerId)
        ? existing.playerId
        : undefined;

    if (!playerId) {
      playerId = crypto.randomUUID();
      this.players.set(playerId, { name, total: 0, rounds: 0 });
    } else {
      // Keep score, update display name.
      const rec = this.players.get(playerId)!;
      rec.name = name;
    }

    ws.serializeAttachment({ playerId, role: 'player' } as Attachment);
    await this.persist();

    this.send(ws, { type: 'you', playerId, name });

    // Make sure a round is live, then give them the full picture.
    await this.ensureRunning();
    this.send(ws, this.buildSnapshot(ws));

    // Roster grew — tell everyone.
    this.broadcast({
      type: 'leaderboard',
      leaderboard: this.buildLeaderboard(),
      serverNow: Date.now(),
    });
  }

  private async onWatch(ws: WebSocket): Promise<void> {
    ws.serializeAttachment({ role: 'spectator' } as Attachment);
    await this.ensureRunning();
    this.send(ws, this.buildSnapshot(ws));
  }

  private async onGuess(ws: WebSocket, msg: any): Promise<void> {
    const now = Date.now();
    const att = this.attachmentOf(ws);

    // Must be a registered player.
    const playerId = att?.playerId;
    if (!playerId || !this.players.has(playerId)) {
      this.send(ws, { type: 'guess_ack', accepted: false });
      return;
    }

    // Only during the guess phase, before the deadline.
    if (this.phase !== 'guess' || now >= this.deadline) {
      this.send(ws, { type: 'guess_ack', accepted: false });
      return;
    }

    // One submission per round.
    if (this.submissions.has(playerId)) {
      this.send(ws, { type: 'guess_ack', accepted: false });
      return;
    }

    const hex = this.normalizeHex(msg.hex);
    if (!hex) {
      this.send(ws, { type: 'guess_ack', accepted: false });
      return;
    }

    // Compute the score now so the reveal is instant; withhold from others.
    let score: number;
    try {
      score = scoreGuess(hex, this.targetOklab);
    } catch {
      this.send(ws, { type: 'guess_ack', accepted: false });
      return;
    }

    this.submissions.set(playerId, { hex, score });
    await this.persist();

    // Server is authoritative; we may withhold the score until reveal, but
    // returning it to the submitting player only is harmless and nicer UX.
    this.send(ws, { type: 'guess_ack', accepted: true, score });

    // FORCE-TO-ZERO: if every connected player has now submitted, end early.
    if (this.allConnectedPlayersSubmitted()) {
      await this.ctx.storage.deleteAlarm();
      await this.endRound();
    }
  }

  // -------------------------------------------------------------------------
  // Round lifecycle
  // -------------------------------------------------------------------------

  private async startRound(): Promise<void> {
    const now = Date.now();
    this.round += 1;

    const t = randomTargetColor();
    this.target = t.hex;
    this.targetOklab = t.oklab;

    this.phase = 'guess';
    this.deadline = now + ROUND_MS;
    this.revealEndsAt = 0;
    this.submissions = new Map();

    await this.ctx.storage.setAlarm(this.deadline);
    await this.persist();

    this.broadcast({
      type: 'round_start',
      round: this.round,
      color: this.target,
      deadline: this.deadline,
      serverNow: now,
    });
  }

  private async endRound(): Promise<void> {
    // Idempotency guard: endRound() is reachable from the alarm path AND from
    // the force-to-zero paths (onGuess / webSocketClose). Alarm delivery is
    // at-least-once and submits can interleave across awaits, so without this
    // guard endRound() could run twice for the same round and double-count
    // totals/rounds. Flip the phase BEFORE any await so the first caller wins
    // and any concurrent/re-delivered caller early-returns.
    if (this.phase !== 'guess') return;
    const now = Date.now();
    this.phase = 'reveal';

    // Update cumulative totals for each submitting player and build results.
    const results: ResultEntry[] = [];
    for (const [playerId, sub] of this.submissions.entries()) {
      const rec = this.players.get(playerId);
      if (!rec) continue;

      const score =
        typeof sub.score === 'number'
          ? sub.score
          : safeScore(sub.hex, this.targetOklab);

      rec.total += score;
      rec.rounds += 1; // only counts rounds actually submitted

      results.push({
        playerId,
        name: rec.name,
        guess: sub.hex,
        score,
        rank: 0, // filled after sort
      });
    }

    // Rank by this round's score desc, tiebreak by name for determinism.
    results.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    results.forEach((r, i) => {
      r.rank = i + 1;
    });

    this.revealEndsAt = now + REVEAL_MS;
    await this.ctx.storage.setAlarm(this.revealEndsAt);
    await this.persist();

    this.broadcast({
      type: 'reveal',
      round: this.round,
      target: this.target,
      results,
      leaderboard: this.buildLeaderboard(),
      revealEndsAt: this.revealEndsAt,
      serverNow: now,
    });
  }

  private async goIdle(): Promise<void> {
    this.phase = 'idle';
    this.deadline = 0;
    this.revealEndsAt = 0;
    this.submissions = new Map();
    await this.ctx.storage.deleteAlarm();
    await this.persist();
  }

  /**
   * Alarm fires at deadline (end of guess) or revealEndsAt (end of reveal).
   * Never start a round with zero connected clients.
   */
  async alarm(): Promise<void> {
    if (this.phase === 'guess') {
      await this.endRound();
      return;
    }

    if (this.phase === 'reveal') {
      if (this.connectionCount() > 0) {
        await this.startRound();
      } else {
        await this.goIdle();
      }
      return;
    }

    // phase === 'idle': nothing scheduled should fire, but be safe.
    if (this.connectionCount() > 0) {
      await this.startRound();
    } else {
      await this.goIdle();
    }
  }

  /**
   * If the game is idle and at least one client is connected, kick off a round
   * so the game always feels "already running."
   *
   * Also repairs a wedged game: if an alarm was ever missed or a persist threw
   * after deleteAlarm() (leaving phase=='guess'/'reveal' with a deadline that
   * has already passed and no alarm armed), advance the phase here. Every new
   * connection passes through ensureRunning(), so this self-heals on the next
   * client interaction even though goIdle() deletes the alarm.
   */
  private async ensureRunning(): Promise<void> {
    const now = Date.now();

    // Repair an expired-but-not-advanced guess phase.
    if (this.phase === 'guess' && now >= this.deadline) {
      await this.ctx.storage.deleteAlarm();
      await this.endRound();
      return;
    }

    // Repair an expired-but-not-advanced reveal phase.
    if (this.phase === 'reveal' && now >= this.revealEndsAt) {
      if (this.connectionCount() > 0) {
        await this.startRound();
      } else {
        await this.goIdle();
      }
      return;
    }

    if (this.phase === 'idle' && this.connectionCount() > 0) {
      await this.startRound();
    }
  }

  // -------------------------------------------------------------------------
  // Snapshot / leaderboard builders
  // -------------------------------------------------------------------------

  private buildSnapshot(ws: WebSocket): any {
    const now = Date.now();
    const att = this.attachmentOf(ws);

    const snap: any = {
      type: 'snapshot',
      phase: this.phase,
      round: this.round,
      color: this.target,
      deadline: this.deadline,
      serverNow: now,
      leaderboard: this.buildLeaderboard(),
    };

    if (this.phase === 'reveal') {
      snap.revealEndsAt = this.revealEndsAt;
      snap.target = this.target;
      snap.results = this.buildResults();
    }

    // Identity / per-connection player view.
    if (att?.role === 'player' && att.playerId && this.players.has(att.playerId)) {
      const rec = this.players.get(att.playerId)!;
      snap.you = {
        playerId: att.playerId,
        name: rec.name,
        submittedThisRound: this.submissions.has(att.playerId),
      };
    }

    return snap;
  }

  private buildResults(): ResultEntry[] {
    const results: ResultEntry[] = [];
    for (const [playerId, sub] of this.submissions.entries()) {
      const rec = this.players.get(playerId);
      if (!rec) continue;
      const score =
        typeof sub.score === 'number'
          ? sub.score
          : safeScore(sub.hex, this.targetOklab);
      results.push({ playerId, name: rec.name, guess: sub.hex, score, rank: 0 });
    }
    results.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    results.forEach((r, i) => {
      r.rank = i + 1;
    });
    return results;
  }

  private buildLeaderboard(): LeaderboardEntry[] {
    const connectedIds = this.connectedPlayerIds();

    const entries: LeaderboardEntry[] = [];
    for (const [playerId, rec] of this.players.entries()) {
      const trueAvg = rec.rounds > 0 ? rec.total / rec.rounds : 0;
      const rs = rankedScore(rec.total, rec.rounds);
      entries.push({
        playerId,
        name: rec.name,
        rankedScore: rs,
        trueAvg,
        rounds: rec.rounds,
        total: rec.total,
        connected: connectedIds.has(playerId),
      });
    }

    entries.sort(
      (x, y) => y.rankedScore - x.rankedScore || y.total - x.total,
    );
    return entries;
  }

  // -------------------------------------------------------------------------
  // Connection / identity helpers
  // -------------------------------------------------------------------------

  private attachmentOf(ws: WebSocket): Attachment | undefined {
    try {
      return ws.deserializeAttachment() as Attachment | undefined;
    } catch {
      return undefined;
    }
  }

  private connectionCount(): number {
    return this.ctx.getWebSockets().length;
  }

  /**
   * playerIds whose connection is currently open and is a registered player.
   * `exclude` lets callers skip a specific socket — needed inside
   * webSocketClose, where the closing socket is STILL returned by
   * getWebSockets() under the Hibernation API.
   */
  private connectedPlayerIds(exclude?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      // Skip sockets that are not OPEN (e.g. the one mid-close).
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const att = this.attachmentOf(ws);
      if (att?.role === 'player' && att.playerId && this.players.has(att.playerId)) {
        ids.add(att.playerId);
      }
    }
    return ids;
  }

  /**
   * True when there is >=1 connected player and every connected player has a
   * submission for the current round. Spectators do not count. `exclude` skips
   * a departing socket (see connectedPlayerIds).
   */
  private allConnectedPlayersSubmitted(exclude?: WebSocket): boolean {
    const connected = this.connectedPlayerIds(exclude);
    if (connected.size === 0) return false;
    for (const id of connected) {
      if (!this.submissions.has(id)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Send helpers
  // -------------------------------------------------------------------------

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // connection gone; ignore
    }
  }

  private broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // ignore broken sockets
      }
    }
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  /** Normalize a guess to "#RRGGBB" uppercase, or return null if invalid. */
  private normalizeHex(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    let h = raw.trim();
    if (h.startsWith('#')) h = h.slice(1);

    // Expand 3-digit shorthand.
    if (/^[0-9a-fA-F]{3}$/.test(h)) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }

    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return '#' + h.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function safeScore(hex: string, targetOklab: Oklab): number {
  try {
    return scoreGuess(hex, targetOklab);
  } catch {
    return 0;
  }
}
