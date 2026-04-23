import * as vscode from 'vscode';
import { SerialGateway } from './serialGateway';
import { ActivityTracker } from './activityTracker';

export class StateWriter implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly gateway: SerialGateway,
    private readonly tracker: ActivityTracker,
  ) {}

  start(): void {
    if (this.timer) { return; }
    this._sendTimeSync();
    this.timer = setInterval(() => this._push(), 800);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private _sourceLabel(source: string | null): string {
    if (!source || !source.trim()) { return 'AI'; }
    return source.charAt(0).toUpperCase() + source.slice(1);
  }

  private _push(): void {
    const connected = this.gateway.status === 'connected';
    const snapshot = this.tracker.snapshot;
    const mode = snapshot.mode;
    const sourceLabel = this._sourceLabel(snapshot.source);

    let total = 0;
    let running = 0;
    let waiting = 0;
    let msg = 'No activity';

    if (!connected) {
      msg = 'Device disconnected';
    } else if (!snapshot.hasData) {
      msg = 'No activity';
    } else if (mode === 'sleep') {
      msg = `${sourceLabel} sleeping`;
    } else if (mode === 'attention') {
      total = 1;
      waiting = 1;
      msg = `${sourceLabel} awaiting approval`;
    } else if (mode === 'busy') {
      total = 1;
      running = 1;
      msg = `${sourceLabel} busy`;
    } else if (mode === 'idle') {
      total = 1;
      msg = `${sourceLabel} active`;
    }

    const payload: Record<string, unknown> = { total, running, waiting, msg, entries: [msg] };

    this.gateway.sendLine(payload);
  }

  private _sendTimeSync(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const tzOffsetSec = -new Date().getTimezoneOffset() * 60;
    this.gateway.sendLine({ time: [nowSec, tzOffsetSec] });
  }

  dispose(): void { this.stop(); }
}
