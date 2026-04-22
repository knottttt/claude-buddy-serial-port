import * as http from 'http';
import * as vscode from 'vscode';
import { PermissionBroker } from './permissionBroker';

export interface HealthInfo {
  ok: boolean;
  serial_connected: boolean;
  waiting: number;
  mode: string;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: object): void {
  const body = JSON.stringify(obj) + '\n';
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch {
    // client disconnected before response (hook process killed)
  }
}

export class BuddyHttpServer implements vscode.Disposable {
  private server: http.Server | null = null;

  constructor(
    private readonly broker: PermissionBroker,
    private readonly getHealth: () => HealthInfo,
  ) {}

  start(port = 19191): void {
    if (this.server) { return; }
    this.server = http.createServer((req, res) => {
      void this._handle(req, res);
    });
    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[buddy-http] port ${port} already in use`);
      }
    });
    this.server.listen(port, '127.0.0.1');
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, this.getHealth());
      return;
    }

    if (req.method === 'POST' && req.url === '/permission') {
      let body: string;
      try { body = await readBody(req); }
      catch { sendJson(res, 400, { ok: false, error: 'read_error' }); return; }

      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(body) as Record<string, unknown>; }
      catch { sendJson(res, 400, { ok: false, error: 'bad_json' }); return; }

      const id = String(parsed.id ?? '').trim();
      if (!id) { sendJson(res, 400, { ok: false, error: 'missing_id' }); return; }

      const tool = String(parsed.tool ?? 'Tool').slice(0, 20);
      const hint = String(parsed.hint ?? '').slice(0, 43);
      const timeoutS = Math.max(1, Math.min(300, Number(parsed.timeout ?? 60)));

      const decision = await this.broker.request(id, tool, hint, timeoutS);
      if (decision === 'serial_unavailable') {
        sendJson(res, 503, { ok: false, id, decision: 'deny', error: 'serial_unavailable' });
      } else {
        sendJson(res, 200, { ok: true, id, decision });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not_found' });
  }

  dispose(): void { this.stop(); }
}
