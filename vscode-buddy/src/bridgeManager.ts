import * as vscode from 'vscode';
import { SerialGateway, GatewayStatus } from './serialGateway';
import { ActivityTracker } from './activityTracker';
import { StateWriter } from './stateWriter';

export type BridgeStatus = 'stopped' | 'starting' | 'connected' | 'disconnected' | 'waiting';

export interface BridgeHealth {
  ok: boolean;
  serial_connected: boolean;
  waiting: number;
  mode: string;
}

export class BridgeManager implements vscode.Disposable {
  private gateway: SerialGateway;
  private tracker: ActivityTracker;
  private stateWriter: StateWriter;

  private _status: BridgeStatus = 'stopped';
  private _logs: string[] = [];

  private _onStatusChange = new vscode.EventEmitter<BridgeStatus>();
  private _onLog = new vscode.EventEmitter<string>();

  readonly onStatusChange = this._onStatusChange.event;
  readonly onLog = this._onLog.event;

  get status(): BridgeStatus { return this._status; }
  get health(): BridgeHealth { return this._makeHealth(); }
  get logs(): string[] { return [...this._logs]; }

  constructor(private readonly gatewayScript: string) {
    this.gateway = new SerialGateway(gatewayScript);
    this.tracker = new ActivityTracker();
    this.stateWriter = new StateWriter(this.gateway, this.tracker);

    this.gateway.onStatusChange(s => this._onGatewayStatus(s));
    this.tracker.onSnapshotChange(s => {
      this._appendLog(`[tracker] mode=${s.mode} file=${s.jsonlFile} | ${s.detail}`);
      this._refreshStatus();
    });
    this.gateway.onLog(l => this._appendLog(`[serial] ${l}`));
  }

  async startIfHealthy(): Promise<void> {
    this.start();
  }

  start(): void {
    const cfg = vscode.workspace.getConfiguration('claudeBuddy');
    const port = cfg.get<string>('port', 'auto');
    const baud = cfg.get<number>('baud', 115200);

    this._appendLog('[buddy] starting VS Code bridge');
    this.tracker.start();
    this.gateway.start(port, baud);
    this.stateWriter.start();
    this._setStatus('starting');
  }

  stop(): void {
    this.stateWriter.stop();
    this.gateway.stop();
    this.tracker.stop();
    this._setStatus('stopped');
    this._appendLog('[buddy] stopped');
  }

  restart(): void {
    this.stop();
    setTimeout(() => this.start(), 600);
  }

  isOwnProcess(): boolean { return true; }

  private _onGatewayStatus(s: GatewayStatus): void {
    this._refreshStatus(s);
  }

  private _refreshStatus(s?: GatewayStatus): void {
    const status = s ?? this.gateway.status;
    const mode = this.tracker.snapshot.mode;
    switch (status) {
      case 'connected':    this._setStatus(mode === 'attention' ? 'waiting' : 'connected'); break;
      case 'disconnected': this._setStatus('disconnected'); break;
      case 'starting':     this._setStatus('starting'); break;
      case 'stopped':      this._setStatus('stopped'); break;
    }
  }

  private _setStatus(s: BridgeStatus): void {
    if (this._status !== s) {
      this._status = s;
      this._onStatusChange.fire(s);
    }
  }

  private _appendLog(text: string): void {
    const lines = text.split('\n').filter(l => l.trim());
    for (const line of lines) {
      this._logs.push(line);
      if (this._logs.length > 200) { this._logs.shift(); }
      this._onLog.fire(line);
    }
  }

  private _makeHealth(): BridgeHealth {
    const connected = this.gateway.status === 'connected';
    const mode = connected ? this.tracker.snapshot.mode : 'sleep';
    const waiting = connected && mode === 'attention' ? 1 : 0;
    return {
      ok: this._status !== 'stopped',
      serial_connected: connected,
      waiting,
      mode,
    };
  }

  dispose(): void {
    this.stop();
    this.tracker.dispose();
    this.gateway.dispose();
    this.stateWriter.dispose();
    this._onStatusChange.dispose();
    this._onLog.dispose();
  }
}
