import * as vscode from 'vscode';
import { SerialGateway } from './serialGateway';

interface PendingItem {
  resolve: (decision: string) => void;
  tool: string;
  hint: string;
  createdAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionBroker implements vscode.Disposable {
  private pending = new Map<string, PendingItem>();
  private _sub: vscode.Disposable;

  constructor(private readonly gateway: SerialGateway) {
    this._sub = gateway.onDeviceLine(line => this._onDeviceLine(line));
  }

  async request(id: string, tool: string, hint: string, timeoutS: number): Promise<string> {
    const sent = this.gateway.sendLine({ prompt: { id, tool, hint } });
    if (!sent) { return 'serial_unavailable'; }

    return new Promise<string>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.gateway.sendLine({ prompt: null });
        resolve('deny');
      }, timeoutS * 1000);

      this.pending.set(id, { resolve, tool, hint, createdAt: Date.now(), timer });
    });
  }

  waitingCount(): number { return this.pending.size; }

  currentPrompt(): { id: string; tool: string; hint: string } | null {
    if (this.pending.size === 0) { return null; }
    let oldest: [string, PendingItem] | null = null;
    for (const entry of this.pending.entries()) {
      if (!oldest || entry[1].createdAt < oldest[1].createdAt) { oldest = entry; }
    }
    return oldest ? { id: oldest[0], tool: oldest[1].tool, hint: oldest[1].hint } : null;
  }

  private _onDeviceLine(line: string): void {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    if (obj.cmd !== 'permission') { return; }
    const id = String(obj.id ?? '');
    const item = this.pending.get(id);
    if (!item) { return; }
    clearTimeout(item.timer);
    this.pending.delete(id);
    this.gateway.sendLine({ prompt: null });
    const dec = String(obj.decision ?? '');
    item.resolve(['allow', 'once', 'always'].includes(dec) ? 'once' : 'deny');
  }

  dispose(): void {
    for (const [, item] of this.pending) {
      clearTimeout(item.timer);
      item.resolve('deny');
    }
    this.pending.clear();
    this._sub.dispose();
  }
}
