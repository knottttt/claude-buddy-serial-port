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

  private _push(): void {
    const connected = this.gateway.status === 'connected';
    const mode = this.tracker.snapshot.mode;

    let total = 0;
    let running = 0;
    let waiting = 0;
    let msg = 'No Claude activity';

    if (!connected) {
      msg = 'Device disconnected';
    } else if (mode === 'attention') {
      total = 1;
      waiting = 1;
      msg = 'awaiting approval';
    } else if (mode === 'busy') {
      total = 1;
      running = 1;
      msg = 'Claude busy';
    } else if (mode === 'idle') {
      total = 1;
      msg = 'Claude active';
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
