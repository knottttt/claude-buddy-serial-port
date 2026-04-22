import * as cp from 'child_process';
import * as vscode from 'vscode';

export type GatewayStatus = 'stopped' | 'starting' | 'connected' | 'disconnected';

export class SerialGateway implements vscode.Disposable {
  private proc: cp.ChildProcess | null = null;
  private lineBuf = '';
  private _status: GatewayStatus = 'stopped';

  private _onStatusChange = new vscode.EventEmitter<GatewayStatus>();
  private _onDeviceLine = new vscode.EventEmitter<string>();
  private _onLog = new vscode.EventEmitter<string>();

  readonly onStatusChange = this._onStatusChange.event;
  readonly onDeviceLine = this._onDeviceLine.event;
  readonly onLog = this._onLog.event;

  get status(): GatewayStatus { return this._status; }

  constructor(private readonly scriptPath: string) {}

  start(port: string, baud: number): void {
    if (this.proc) { return; }
    this._setStatus('starting');
    this.proc = cp.spawn('python', [this.scriptPath, port, '--baud', String(baud)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => this._onStdout(chunk.toString()));
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const l = line.trim();
        if (l) { this._onLog.fire(l); }
      }
    });
    this.proc.on('exit', () => {
      this.proc = null;
      this._setStatus('disconnected');
    });
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this._setStatus('stopped');
  }

  sendLine(obj: object): boolean {
    if (!this.proc?.stdin?.writable) { return false; }
    try {
      this.proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  private _onStdout(data: string): void {
    this.lineBuf += data;
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { continue; }
      // Check for gateway status messages first.
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.status === 'string') {
          if (obj.status === 'connected') {
            this._setStatus('connected');
          } else if (obj.status === 'disconnected') {
            this._setStatus('disconnected');
          }
          // Don't forward status lines to the broker.
          continue;
        }
      } catch { /* not JSON, ignore */ }
      this._onDeviceLine.fire(line);
    }
  }

  private _setStatus(s: GatewayStatus): void {
    if (this._status !== s) {
      this._status = s;
      this._onStatusChange.fire(s);
    }
  }

  dispose(): void {
    this.stop();
    this._onStatusChange.dispose();
    this._onDeviceLine.dispose();
    this._onLog.dispose();
  }
}
