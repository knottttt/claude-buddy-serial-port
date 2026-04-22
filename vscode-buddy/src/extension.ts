import * as vscode from 'vscode';
import * as path from 'path';
import { BridgeManager } from './bridgeManager';
import { BuddyStatusBar } from './statusBar';
import { BuddyPanelProvider } from './panel';

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('claudeBuddy');
  const scriptPath = cfg.get<string>('bridgePath', '').trim() ||
    path.join(ctx.extensionPath, '..', 'tools', 'serial_gateway.py');
  const bridge = new BridgeManager(scriptPath);
  const statusBar = new BuddyStatusBar();
  const panel = new BuddyPanelProvider(bridge);

  // Keep status bar in sync.
  bridge.onStatusChange(s => {
    statusBar.update(s, bridge.health);
    panel.refresh();
  });

  // Register sidebar.
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BuddyPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Commands.
  ctx.subscriptions.push(
    vscode.commands.registerCommand('claudeBuddy.start',   () => bridge.start()),
    vscode.commands.registerCommand('claudeBuddy.stop',    () => bridge.stop()),
    vscode.commands.registerCommand('claudeBuddy.restart', () => bridge.restart()),
    vscode.commands.registerCommand('claudeBuddy.focusPanel', () =>
      vscode.commands.executeCommand('claudeBuddy.panel.focus')
    ),
  );

  ctx.subscriptions.push(bridge, statusBar);

  // Auto-start: attach if bridge already running, otherwise spawn.
  bridge.startIfHealthy();
}

export function deactivate(): void {
  // Subscriptions disposed automatically; bridge.dispose() kills the process.
}
