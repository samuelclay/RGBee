import { GameRoom } from './game';

export { GameRoom };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// Simple shared key for the host reset endpoint (this is a casual party game,
// not a secret-bearing app). Rotate by editing here.
const RESET_KEY = 'buzz-reset-9f3a';

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const id = env.ROOMS.idFromName('global');
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // Host/admin: GET /admin/reset?key=... wipes the leaderboard.
    if (url.pathname === '/admin/reset') {
      if (url.searchParams.get('key') !== RESET_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName('global'));
      return stub.fetch(new Request('https://do/reset'));
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
