import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const POLL_MS = 800;
const STALE_SECS = 1;
const SLEEP_SECS = 30;
const MAX_LINES = 400;
const MAX_BYTES = 512 * 1024;

export type ActivityMode = 'sleep' | 'idle' | 'busy' | 'attention';

export interface ActivitySnapshot {
  mode: ActivityMode;
  detail: string;
  activeTs: number;
  jsonlFile: string;
  source: string | null;
  hasData: boolean;
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function parseIsoToTs(value: unknown): number | null {
  if (typeof value !== 'string') { return null; }
  const text = value.trim();
  if (!text) { return null; }
  const ts = Date.parse(text);
  if (Number.isNaN(ts)) { return null; }
  return ts / 1000;
}

function roleOf(obj: Record<string, unknown>): string {
  const msg = obj.message;
  if (msg && typeof msg === 'object') {
    const nestedMsgRole = (msg as Record<string, unknown>).role;
    if (typeof nestedMsgRole === 'string') {
      return nestedMsgRole.toLowerCase();
    }
  }
  const raw = obj.role ?? obj.sender ?? obj.author;
  if (typeof raw === 'string') { return raw.toLowerCase(); }
  if (raw && typeof raw === 'object' && 'role' in raw) {
    const nested = (raw as Record<string, unknown>).role;
    if (typeof nested === 'string') { return nested.toLowerCase(); }
  }
  return '';
}

function getContentItems(obj: Record<string, unknown>): Record<string, unknown>[] {
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') { return []; }
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) { return []; }
  return content.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
}

function toolUseIdOf(item: Record<string, unknown>): string {
  const raw = item.id;
  return typeof raw === 'string' ? raw : '';
}

function toolResultIdOf(item: Record<string, unknown>): string {
  const raw = item.tool_use_id;
  return typeof raw === 'string' ? raw : '';
}

function isToolUseItem(item: Record<string, unknown>): boolean {
  const t = item.type;
  return t === 'tool_use' || t === 'tool-call' || t === 'tool_call' || t === 'function_call';
}

function isToolResultItem(item: Record<string, unknown>): boolean {
  const t = item.type;
  return t === 'tool_result' || t === 'tool-output' || t === 'tool_output' || t === 'function_result';
}

function isEscalatedCall(argsRaw: unknown): boolean {
  if (typeof argsRaw !== 'string' || !argsRaw.trim()) { return false; }
  try {
    const parsed = JSON.parse(argsRaw) as Record<string, unknown>;
    return parsed.sandbox_permissions === 'require_escalated';
  } catch {
    return false;
  }
}

function newestJsonl(rootDir: string, excludedDirs: string[]): { file: string; mtimeMs: number } | null {
  if (!fs.existsSync(rootDir)) { return null; }
  const stack = [rootDir];
  let newestPath = '';
  let newestMtime = -1;
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) { continue; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (excludedDirs.includes(ent.name)) {
          continue;
        }
        stack.push(full);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) {
        continue;
      }
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newestMtime) {
          newestMtime = st.mtimeMs;
          newestPath = full;
        }
      } catch {
        // Ignore race/deleted files.
      }
    }
  }
  return newestPath ? { file: newestPath, mtimeMs: newestMtime } : null;
}

function readTailLines(filePath: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): string[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return [];
  }
  const size = st.size;
  if (size <= 0) { return []; }

  const take = Math.min(size, maxBytes);
  const start = Math.max(0, size - take);
  const buf = Buffer.allocUnsafe(take);

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, take, start);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  const text = buf.toString('utf-8');
  const raw = text.split(/\r?\n/);
  const lines = start > 0 ? raw.slice(1) : raw;
  return lines.map(x => x.trim()).filter(Boolean).slice(-maxLines);
}

function inferSnapshot(filePath: string, mtimeMs: number, source: string): ActivitySnapshot {
  const now = Date.now() / 1000;
  const shortPath = filePath.split(/[\\/]/).slice(-2).join('/');
  const lines = readTailLines(filePath);
  if (lines.length === 0) {
    const activeTs = mtimeMs / 1000;
    if (now - activeTs > SLEEP_SECS) {
      return { mode: 'sleep', detail: `${source}: sleep`, activeTs, jsonlFile: shortPath, source, hasData: true };
    }
    return { mode: 'idle', detail: `${source}: file-active`, activeTs, jsonlFile: shortPath, source, hasData: true };
  }

  let lastActivityTs: number | null = null;
  let lastAssistantTs: number | null = null;
  let lastToolUseTs: number | null = null;
  let lastToolResultTs: number | null = null;
  let lastPendingToolUseTs: number | null = null;
  let lastToolUseStopTs: number | null = null;
  let lastUserTs: number | null = null;
  let hasCodexPayload = false;
  const pendingToolUseIds = new Map<string, number>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const ts = parseIsoToTs(obj.timestamp) ?? parseIsoToTs(obj.created_at) ?? (mtimeMs / 1000);

    // Codex format: { type: "response_item", payload: { type: "function_call"|"function_call_output"|"message", ... } }
    const codexPayload = (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object')
      ? obj.payload as Record<string, unknown>
      : null;
    if (codexPayload) {
      hasCodexPayload = true;
      if (codexPayload.type === 'function_call') {
        lastActivityTs = ts;
        lastToolUseTs = ts;
        const id = typeof codexPayload.call_id === 'string' ? codexPayload.call_id : '';
        const requiresApproval = isEscalatedCall(codexPayload.arguments);
        if (requiresApproval) {
          if (id) { pendingToolUseIds.set(id, ts); } else { lastPendingToolUseTs = ts; }
        }
      } else if (codexPayload.type === 'function_call_output') {
        lastActivityTs = ts;
        lastToolResultTs = ts;
        const id = typeof codexPayload.call_id === 'string' ? codexPayload.call_id : '';
        if (id) { pendingToolUseIds.delete(id); }
      } else if (codexPayload.type === 'message') {
        const r = typeof codexPayload.role === 'string' ? codexPayload.role.toLowerCase() : '';
        if (r === 'assistant' || r === 'user') { lastActivityTs = ts; }
        if (r === 'assistant') { lastAssistantTs = ts; }
        if (r === 'user') { lastUserTs = ts; }
      }
      continue;
    }

    const role = roleOf(obj);
    const stopReason = (() => {
      const msg = obj.message;
      if (!msg || typeof msg !== 'object') { return ''; }
      const raw = (msg as Record<string, unknown>).stop_reason;
      return typeof raw === 'string' ? raw : '';
    })();

    if (role === 'assistant' || role === 'model' || role === 'agent' || role === 'user' || role === 'tool') {
      lastActivityTs = ts;
    }
    if (role === 'assistant' || role === 'model' || role === 'agent') {
      lastAssistantTs = ts;
    }
    if (role === 'user') {
      lastUserTs = ts;
    }
    if ((role === 'assistant' || role === 'model' || role === 'agent') && stopReason === 'tool_use') {
      lastToolUseStopTs = ts;
    }

    const items = getContentItems(obj);
    for (const item of items) {
      if (isToolUseItem(item) && (role === 'assistant' || role === 'model' || role === 'agent' || role === '')) {
        lastToolUseTs = ts;
        const id = toolUseIdOf(item);
        if (id) {
          pendingToolUseIds.set(id, ts);
        } else {
          lastPendingToolUseTs = ts;
        }
      }
      if (isToolResultItem(item) && (role === 'user' || role === 'tool' || role === 'system' || role === '')) {
        lastToolResultTs = ts;
        const id = toolResultIdOf(item);
        if (id) {
          pendingToolUseIds.delete(id);
        }
      }
    }

    if (obj.type === 'queue-operation') {
      lastActivityTs = ts;
    }
  }

  if (lastToolUseStopTs !== null && (lastUserTs === null || lastToolUseStopTs > lastUserTs)) {
    if (lastPendingToolUseTs === null || lastToolUseStopTs > lastPendingToolUseTs) {
      lastPendingToolUseTs = lastToolUseStopTs;
    }
  }

  for (const pendingTs of pendingToolUseIds.values()) {
    if (lastPendingToolUseTs === null || pendingTs > lastPendingToolUseTs) {
      lastPendingToolUseTs = pendingTs;
    }
  }

  const activeTs = lastActivityTs ?? (mtimeMs / 1000);

  if (lastPendingToolUseTs !== null) {
    const pendingAge = Math.max(0, now - lastPendingToolUseTs);
    const debug = `pendingAge=${pendingAge.toFixed(1)}s pendingTs=${lastPendingToolUseTs.toFixed(1)} userTs=${lastUserTs ?? 0} stopTs=${lastToolUseStopTs ?? 0}`;
    if ((now - lastPendingToolUseTs) > STALE_SECS) {
      return { mode: 'attention', detail: `${source}: pending-approval ${debug}`, activeTs, jsonlFile: shortPath, source, hasData: true };
    }
    return { mode: 'busy', detail: `${source}: tool_use ${debug}`, activeTs, jsonlFile: shortPath, source, hasData: true };
  }

  if ((now - activeTs) > SLEEP_SECS) {
    return { mode: 'sleep', detail: `${source}: sleep`, activeTs, jsonlFile: shortPath, source, hasData: true };
  }

  if (lastToolResultTs !== null && (lastToolUseTs === null || lastToolResultTs >= lastToolUseTs)) {
    // Skip if the agent already wrote a final response after the tool result
    if (lastAssistantTs === null || lastAssistantTs <= lastToolResultTs) {
      return { mode: 'busy', detail: `${source}: tool_result`, activeTs, jsonlFile: shortPath, source, hasData: true };
    }
  }

  if (lastToolUseTs !== null && (lastAssistantTs === null || lastAssistantTs <= lastToolUseTs)) {
    if ((now - lastToolUseTs) > STALE_SECS && !hasCodexPayload) {
      return { mode: 'attention', detail: `${source}: pending-approval`, activeTs, jsonlFile: shortPath, source, hasData: true };
    }
    return { mode: 'busy', detail: `${source}: tool_use`, activeTs, jsonlFile: shortPath, source, hasData: true };
  }

  return { mode: 'idle', detail: `${source}: active`, activeTs, jsonlFile: shortPath, source, hasData: true };
}

export class ActivityTracker implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly claudeRoot = expandHome('~/.claude/projects');
  private readonly codexRoot = expandHome('~/.codex/sessions');
  private _snapshot: ActivitySnapshot = {
    mode: 'sleep',
    detail: 'no activity',
    activeTs: 0,
    jsonlFile: '',
    source: null,
    hasData: false,
  };
  private readonly _onSnapshotChange = new vscode.EventEmitter<ActivitySnapshot>();
  readonly onSnapshotChange = this._onSnapshotChange.event;

  get snapshot(): ActivitySnapshot { return this._snapshot; }

  start(): void {
    if (this.timer) { return; }
    this.refresh();
    this.timer = setInterval(() => this.refresh(), POLL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  refresh(): void {
    const claudeFile = newestJsonl(this.claudeRoot, ['subagents']);
    const codexFile = newestJsonl(this.codexRoot, []);
    const claudeSnapshot = claudeFile ? inferSnapshot(claudeFile.file, claudeFile.mtimeMs, 'claude') : null;
    const codexSnapshot = codexFile ? inferSnapshot(codexFile.file, codexFile.mtimeMs, 'codex') : null;

    let next: ActivitySnapshot;
    if (claudeSnapshot && codexSnapshot) {
      next = codexSnapshot.activeTs > claudeSnapshot.activeTs ? codexSnapshot : claudeSnapshot;
    } else if (claudeSnapshot) {
      next = claudeSnapshot;
    } else if (codexSnapshot) {
      next = codexSnapshot;
    } else {
      next = { mode: 'sleep', detail: 'no activity', activeTs: 0, jsonlFile: '', source: null, hasData: false };
    }

    if (
      next.mode !== this._snapshot.mode ||
      next.detail !== this._snapshot.detail ||
      next.source !== this._snapshot.source ||
      next.hasData !== this._snapshot.hasData
    ) {
      this._snapshot = next;
      this._onSnapshotChange.fire(next);
    } else {
      this._snapshot = next;
    }
  }

  dispose(): void {
    this.stop();
    this._onSnapshotChange.dispose();
  }
}
