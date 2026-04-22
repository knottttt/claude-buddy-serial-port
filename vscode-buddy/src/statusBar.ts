import * as vscode from 'vscode';
import { BridgeStatus, BridgeHealth } from './bridgeManager';

const LABELS: Record<BridgeStatus, string> = {
  stopped:      '⬡ Buddy: stopped',
  starting:     '⬡ Buddy: starting…',
  connected:    '⬡ Buddy: connected',
  disconnected: '⬡ Buddy: no device',
  waiting:      '⬡ Buddy: waiting approval…',
};

const COLORS: Partial<Record<BridgeStatus, vscode.ThemeColor>> = {
  connected:    new vscode.ThemeColor('statusBarItem.prominentForeground'),
  waiting:      new vscode.ThemeColor('statusBarItem.warningForeground'),
  disconnected: new vscode.ThemeColor('statusBarItem.errorForeground'),
};

export class BuddyStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'claudeBuddy.focusPanel';
    this.item.tooltip = 'Claude Buddy — click to open panel';
    this.update('stopped', null);
    this.item.show();
  }

  update(status: BridgeStatus, health: BridgeHealth | null): void {
    let label = LABELS[status];
    if (status === 'waiting' && health && health.waiting > 1) {
      label = `⬡ Buddy: ${health.waiting} waiting…`;
    }
    this.item.text = label;
    this.item.color = COLORS[status];
  }

  dispose(): void {
    this.item.dispose();
  }
}
