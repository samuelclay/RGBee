import { GameRoom } from './game';

export { GameRoom };

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Set with: npx wrangler secret put TAVUS_API_KEY
  TAVUS_API_KEY?: string;
}

// Simple shared key for the host reset endpoint (this is a casual party game,
// not a secret-bearing app). Rotate by editing here.
const RESET_KEY = 'buzz-reset-9f3a';

// Charlie the host persona (created via the Tavus MCP).
const CHARLIE_PERSONA = 'p6986c7f98e2';

const JSON_HEADERS = { 'content-type': 'application/json' };

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

    // Charlie: create a CVI conversation (the presentation screen then joins its
    // Daily room with daily-js to render the video and push/pull app-messages).
    if (url.pathname === '/charlie/start' && request.method === 'POST') {
      if (!env.TAVUS_API_KEY) {
        return new Response(JSON.stringify({ error: 'TAVUS_API_KEY not set' }), {
          status: 503,
          headers: JSON_HEADERS,
        });
      }
      const r = await fetch('https://tavusapi.com/v2/conversations', {
        method: 'POST',
        headers: { 'x-api-key': env.TAVUS_API_KEY, ...JSON_HEADERS },
        body: JSON.stringify({
          persona_id: CHARLIE_PERSONA,
          conversation_name: 'RGBee — Charlie the host',
          properties: { max_call_duration: 3600, enable_recording: false },
        }),
      });
      const body = await r.text();
      return new Response(body, { status: r.status, headers: JSON_HEADERS });
    }

    // Charlie: end a conversation when the presentation screen goes away.
    if (url.pathname === '/charlie/end' && request.method === 'POST') {
      if (!env.TAVUS_API_KEY) return new Response('{}', { headers: JSON_HEADERS });
      let id = '';
      try {
        id = ((await request.json()) as { conversation_id?: string }).conversation_id ?? '';
      } catch {
        /* ignore */
      }
      if (!id) return new Response('{}', { headers: JSON_HEADERS });
      const r = await fetch(`https://tavusapi.com/v2/conversations/${id}/end`, {
        method: 'POST',
        headers: { 'x-api-key': env.TAVUS_API_KEY },
      });
      return new Response(JSON.stringify({ ended: r.ok }), { headers: JSON_HEADERS });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
