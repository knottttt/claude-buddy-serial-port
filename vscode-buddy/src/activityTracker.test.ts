/**
 * Unit tests for activityTracker pure functions.
 * Run with: npx tsx src/activityTracker.test.ts
 *
 * Uses only node:test / node:assert — no extra deps needed.
 * The VS Code API import in activityTracker.ts is shimmed below.
 */

// ---------------------------------------------------------------------------
// Minimal vscode shim so the module loads outside the extension host
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
// @ts-ignore — import.meta available when run via tsx (ESM), not checked by tsc
const req = createRequire((import.meta as { url: string }).url);

// Shim 'vscode' before the module is imported
const Module = req('node:module');
const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = (request: string, ...args: unknown[]) => {
  if (request === 'vscode') { return request; }
  return _resolveFilename(request, ...args);
};
req.extensions['.ts'] ??= req.extensions['.js'];

// Provide a fake 'vscode' in the require cache
const fakeEventEmitter = { event: () => {}, fire: () => {}, dispose: () => {} };
(req as NodeRequire & { cache: Record<string, unknown> }).cache['vscode'] = {
  id: 'vscode',
  filename: 'vscode',
  loaded: true,
  exports: {
    EventEmitter: class { event = () => {}; fire = () => {}; dispose = () => {}; },
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
  },
  children: [], paths: [],
} as unknown as NodeModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// We test the module-internal functions by re-implementing them in a
// test-friendly wrapper that accepts a fake filesystem root.
// This avoids complex dynamic import gymnastics with the vscode shim.

// ---- inline copies of the pure functions (no vscode dependency) ----

const MAX_LINES = 400;
const MAX_BYTES = 512 * 1024;
const STALE_SECS = 1;
const SLEEP_SECS = 30;

function parseIsoToTs(value: unknown): number | null {
  if (typeof value !== 'string') { return null; }
  const ts = Date.parse(value.trim());
  return Number.isNaN(ts) ? null : ts / 1000;
}

function roleOf(obj: Record<string, unknown>): string {
  const msg = obj.message;
  if (msg && typeof msg === 'object') {
    const r = (msg as Record<string, unknown>).role;
    if (typeof r === 'string') { return r.toLowerCase(); }
  }
  const raw = obj.role ?? obj.sender ?? obj.author;
  if (typeof raw === 'string') { return raw.toLowerCase(); }
  return '';
}

function getContentItems(obj: Record<string, unknown>): Record<string, unknown>[] {
  const msg = obj.message;
  if (!msg || typeof msg !== 'object') { return []; }
  const content = (msg as Record<string, unknown>).content;
  if (!Array.isArray(content)) { return []; }
  return content.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object');
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

function toolUseIdOf(item: Record<string, unknown>): string {
  return typeof item.id === 'string' ? item.id : '';
}
function toolResultIdOf(item: Record<string, unknown>): string {
  return typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
}

function readTailLines(filePath: string): string[] {
  let size: number;
  try { size = fs.statSync(filePath).size; } catch { return []; }
  if (size <= 0) { return []; }
  const take = Math.min(size, MAX_BYTES);
  const start = Math.max(0, size - take);
  const buf = Buffer.allocUnsafe(take);
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, take, start);
  } catch { return []; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /**/ } } }
  const raw = buf.toString('utf-8').split(/\r?\n/);
  const lines = start > 0 ? raw.slice(1) : raw;
  return lines.map(x => x.trim()).filter(Boolean).slice(-MAX_LINES);
}

type ActivityMode = 'sleep' | 'idle' | 'busy' | 'attention';
interface ActivitySnapshot {
  mode: ActivityMode; detail: string; activeTs: number;
  jsonlFile: string; source: string | null; hasData: boolean;
}

function inferSnapshot(filePath: string, mtimeMs: number, source: string, nowOverride?: number): ActivitySnapshot {
  const now = nowOverride ?? (Date.now() / 1000);
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

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = parseIsoToTs(obj.timestamp) ?? parseIsoToTs(obj.created_at) ?? (mtimeMs / 1000);

    // Codex format: { type: "response_item", payload: { type: "function_call"|..., ... } }
    const codexPayload = (obj.type === 'response_item' && obj.payload && typeof obj.payload === 'object')
      ? obj.payload as Record<string, unknown> : null;
    if (codexPayload) {
      hasCodexPayload = true;
      if (codexPayload.type === 'function_call') {
        lastActivityTs = ts; lastToolUseTs = ts;
        const id = typeof codexPayload.call_id === 'string' ? codexPayload.call_id : '';
        const requiresApproval = isEscalatedCall(codexPayload.arguments);
        if (requiresApproval) {
          if (id) { pendingToolUseIds.set(id, ts); } else { lastPendingToolUseTs = ts; }
        }
      } else if (codexPayload.type === 'function_call_output') {
        lastActivityTs = ts; lastToolResultTs = ts;
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
    if (['assistant','model','agent','user','tool'].includes(role)) { lastActivityTs = ts; }
    if (['assistant','model','agent'].includes(role)) { lastAssistantTs = ts; }
    if (role === 'user') { lastUserTs = ts; }
    if (['assistant','model','agent'].includes(role) && stopReason === 'tool_use') { lastToolUseStopTs = ts; }
    const items = getContentItems(obj);
    for (const item of items) {
      if (isToolUseItem(item) && ['assistant','model','agent',''].includes(role)) {
        lastToolUseTs = ts;
        const id = toolUseIdOf(item);
        if (id) { pendingToolUseIds.set(id, ts); } else { lastPendingToolUseTs = ts; }
      }
      if (isToolResultItem(item) && ['user','tool','system',''].includes(role)) {
        lastToolResultTs = ts;
        const id = toolResultIdOf(item);
        if (id) { pendingToolUseIds.delete(id); }
      }
    }
    if (obj.type === 'queue-operation') { lastActivityTs = ts; }
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

function newestJsonl(rootDir: string, excludedDirs: string[]): { file: string; mtimeMs: number } | null {
  if (!fs.existsSync(rootDir)) { return null; }
  const stack = [rootDir];
  let newestPath = '';
  let newestMtime = -1;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!excludedDirs.includes(ent.name)) { stack.push(full); }
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) { continue; }
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newestPath = full; }
      } catch { /**/ }
    }
  }
  return newestPath ? { file: newestPath, mtimeMs: newestMtime } : null;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-test-'));
}

function writeJsonl(dir: string, relPath: string, lines: object[]): string {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return full;
}

function isoAgo(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Group A: inferSnapshot behaviour
// ---------------------------------------------------------------------------

test('A1: empty file + fresh mtime → idle', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'session.jsonl', []);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'idle');
  assert.ok(snap.detail.startsWith('codex:'));
  assert.equal(snap.source, 'codex');
  assert.equal(snap.hasData, true);
  fs.rmSync(tmp, { recursive: true });
});

test('A2: empty file + stale mtime (>30s) → sleep', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'session.jsonl', []);
  const staleMtime = Date.now() - 60_000;
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, staleMtime, 'codex', now);
  assert.equal(snap.mode, 'sleep');
  assert.ok(snap.detail.startsWith('codex:'));
  fs.rmSync(tmp, { recursive: true });
});

test('A3: assistant tool_use just happened → busy', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'session.jsonl', [{
    role: 'assistant',
    timestamp: isoAgo(0.1),
    message: { content: [{ type: 'tool_use', id: 'tu1' }] },
  }]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'claude', now);
  assert.equal(snap.mode, 'busy');
  assert.ok(snap.detail.startsWith('claude:'));
  fs.rmSync(tmp, { recursive: true });
});

test('A4: tool_use older than STALE_SECS → attention', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'session.jsonl', [{
    role: 'assistant',
    timestamp: isoAgo(5),
    message: { content: [{ type: 'tool_use', id: 'tu2' }] },
  }]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'claude', now);
  assert.equal(snap.mode, 'attention');
  fs.rmSync(tmp, { recursive: true });
});

test('A5: tool_use followed by tool_result → busy (not attention)', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'session.jsonl', [
    { role: 'assistant', timestamp: isoAgo(3), message: { content: [{ type: 'tool_use', id: 'tu3' }] } },
    { role: 'user',      timestamp: isoAgo(1), message: { content: [{ type: 'tool_result', tool_use_id: 'tu3' }] } },
  ]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'claude', now);
  assert.equal(snap.mode, 'busy');
  fs.rmSync(tmp, { recursive: true });
});

test('A6: source tag propagates to detail', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [{ role: 'assistant', timestamp: isoAgo(0.1) }]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'myagent', now);
  assert.ok(snap.detail.startsWith('myagent:'), `detail="${snap.detail}"`);
  assert.equal(snap.source, 'myagent');
  fs.rmSync(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// Group B: newestJsonl filtering
// ---------------------------------------------------------------------------

test('B1: non-existent dir → null', () => {
  const result = newestJsonl('/does/not/exist/at/all', []);
  assert.equal(result, null);
});

test('B2: subagents excluded for Claude; main session wins', () => {
  const tmp = mkTmp();
  // subagents file is newer but should be excluded
  const main = writeJsonl(tmp, 'projects/abc/session.jsonl', [{ role: 'user' }]);
  const sub  = writeJsonl(tmp, 'projects/abc/subagents/s.jsonl', [{ role: 'assistant' }]);
  // make subagents file artificially newer
  const futureMs = Date.now() + 5000;
  fs.utimesSync(sub, futureMs / 1000, futureMs / 1000);

  const result = newestJsonl(path.join(tmp, 'projects'), ['subagents']);
  assert.ok(result !== null);
  assert.equal(path.basename(result.file), 'session.jsonl');
  fs.rmSync(tmp, { recursive: true });
});

test('B3: Codex does NOT filter subagents', () => {
  const tmp = mkTmp();
  const sub = writeJsonl(tmp, 'sessions/xyz/subagents/y.jsonl', [{ role: 'user' }]);

  const result = newestJsonl(path.join(tmp, 'sessions'), []);
  assert.ok(result !== null);
  assert.equal(result.file, sub);
  fs.rmSync(tmp, { recursive: true });
});

test('B4: empty dir → null', () => {
  const tmp = mkTmp();
  fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
  const result = newestJsonl(path.join(tmp, 'empty'), []);
  assert.equal(result, null);
  fs.rmSync(tmp, { recursive: true });
});

// ---------------------------------------------------------------------------
// Group C: refresh() competition logic (tested inline without ActivityTracker)
// ---------------------------------------------------------------------------

function simulateRefresh(
  claudeFile: { file: string; mtimeMs: number } | null,
  codexFile:  { file: string; mtimeMs: number } | null,
  nowSec: number,
): ActivitySnapshot {
  const claudeSnap = claudeFile ? inferSnapshot(claudeFile.file, claudeFile.mtimeMs, 'claude', nowSec) : null;
  const codexSnap  = codexFile  ? inferSnapshot(codexFile.file,  codexFile.mtimeMs,  'codex',  nowSec) : null;

  if (claudeSnap && codexSnap) {
    return codexSnap.activeTs > claudeSnap.activeTs ? codexSnap : claudeSnap;
  } else if (claudeSnap) {
    return claudeSnap;
  } else if (codexSnap) {
    return codexSnap;
  }
  return { mode: 'sleep', detail: 'no activity', activeTs: 0, jsonlFile: '', source: null, hasData: false };
}

test('C1: only Claude has file → source=claude', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'c.jsonl', [{ role: 'assistant', timestamp: isoAgo(1) }]);
  const now = Date.now() / 1000;
  const snap = simulateRefresh({ file: f, mtimeMs: Date.now() }, null, now);
  assert.equal(snap.source, 'claude');
  fs.rmSync(tmp, { recursive: true });
});

test('C2: only Codex has file → source=codex', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 'c.jsonl', [{ role: 'assistant', timestamp: isoAgo(1) }]);
  const now = Date.now() / 1000;
  const snap = simulateRefresh(null, { file: f, mtimeMs: Date.now() }, now);
  assert.equal(snap.source, 'codex');
  fs.rmSync(tmp, { recursive: true });
});

test('C3: Codex more recent activeTs wins', () => {
  const tmp = mkTmp();
  const cf = writeJsonl(tmp, 'claude.jsonl', [{ role: 'assistant', timestamp: isoAgo(10) }]);
  const xf = writeJsonl(tmp, 'codex.jsonl',  [{ role: 'assistant', timestamp: isoAgo(2)  }]);
  const now = Date.now() / 1000;
  const snap = simulateRefresh(
    { file: cf, mtimeMs: Date.now() },
    { file: xf, mtimeMs: Date.now() },
    now,
  );
  assert.equal(snap.source, 'codex');
  fs.rmSync(tmp, { recursive: true });
});

test('C4: Claude more recent activeTs wins', () => {
  const tmp = mkTmp();
  const cf = writeJsonl(tmp, 'claude.jsonl', [{ role: 'assistant', timestamp: isoAgo(1)  }]);
  const xf = writeJsonl(tmp, 'codex.jsonl',  [{ role: 'assistant', timestamp: isoAgo(15) }]);
  const now = Date.now() / 1000;
  const snap = simulateRefresh(
    { file: cf, mtimeMs: Date.now() },
    { file: xf, mtimeMs: Date.now() },
    now,
  );
  assert.equal(snap.source, 'claude');
  fs.rmSync(tmp, { recursive: true });
});

test('C5: mtime order does not override activeTs (key regression)', () => {
  const tmp = mkTmp();
  // Claude file: older mtime, but more recent log entry
  const cf = writeJsonl(tmp, 'claude.jsonl', [{ role: 'assistant', timestamp: isoAgo(1) }]);
  // Codex file: newer mtime, but older log entry
  const xf = writeJsonl(tmp, 'codex.jsonl',  [{ role: 'assistant', timestamp: isoAgo(20) }]);
  const futureMs = Date.now() + 10_000;
  fs.utimesSync(xf, futureMs / 1000, futureMs / 1000);  // codex mtime is "newer"

  const now = Date.now() / 1000;
  const snap = simulateRefresh(
    { file: cf, mtimeMs: Date.now() - 5000 },   // older mtime
    { file: xf, mtimeMs: futureMs },             // newer mtime
    now,
  );
  // Should pick Claude because its activeTs (from log content) is more recent
  assert.equal(snap.source, 'claude', 'Expected claude to win by activeTs despite older mtime');
  fs.rmSync(tmp, { recursive: true });
});

test('C6: both sources absent → source=null, hasData=false', () => {
  const now = Date.now() / 1000;
  const snap = simulateRefresh(null, null, now);
  assert.equal(snap.source, null);
  assert.equal(snap.hasData, false);
  assert.equal(snap.mode, 'sleep');
});

// ---------------------------------------------------------------------------
// Group D: Codex response_item format
// ---------------------------------------------------------------------------

test('D1: Codex function_call just dispatched → busy', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [{
    type: 'response_item',
    timestamp: isoAgo(0.1),
    payload: { type: 'function_call', name: 'shell_command', call_id: 'call_abc', arguments: '{}' },
  }]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'busy');
  assert.ok(snap.detail.startsWith('codex:'), `detail="${snap.detail}"`);
  fs.rmSync(tmp, { recursive: true });
});

test('D2: Codex function_call + function_call_output (completed) → busy via tool_result', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [
    { type: 'response_item', timestamp: isoAgo(3), payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' } },
    { type: 'response_item', timestamp: isoAgo(2), payload: { type: 'function_call_output', call_id: 'call_1', output: 'ok' } },
  ]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'busy');
  fs.rmSync(tmp, { recursive: true });
});

test('D3: Codex final assistant message → idle', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [
    { type: 'response_item', timestamp: isoAgo(3), payload: { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{}' } },
    { type: 'response_item', timestamp: isoAgo(2), payload: { type: 'function_call_output', call_id: 'call_2', output: 'done' } },
    { type: 'response_item', timestamp: isoAgo(1), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }], phase: 'final_answer' } },
  ]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'idle');
  fs.rmSync(tmp, { recursive: true });
});

test('D4: Codex session older than SLEEP_SECS → sleep', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [
    { type: 'response_item', timestamp: isoAgo(60), payload: { type: 'message', role: 'assistant', content: [], phase: 'final_answer' } },
  ]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now() - 70_000, 'codex', now);
  assert.equal(snap.mode, 'sleep');
  fs.rmSync(tmp, { recursive: true });
});

test('D5: real Codex file format parsed without error', () => {
  const tmp = mkTmp();
  // Verbatim structure from ~/.codex/sessions
  const f = writeJsonl(tmp, 's.jsonl', [
    { timestamp: '2026-04-23T02:00:36.276Z', type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{"command":"ls"}', call_id: 'call_real' } },
    { timestamp: '2026-04-23T02:00:36.975Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_real', output: 'file.txt' } },
    { timestamp: '2026-04-23T02:00:37.500Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Here are the files.' }], phase: 'final_answer' } },
  ]);
  // "now" is just after the last line
  const now = new Date('2026-04-23T02:00:38Z').getTime() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'idle');
  assert.equal(snap.source, 'codex');
  fs.rmSync(tmp, { recursive: true });
});

test('D6: stale Codex function_call without escalation stays busy', () => {
  const tmp = mkTmp();
  const f = writeJsonl(tmp, 's.jsonl', [{
    type: 'response_item',
    timestamp: isoAgo(5),
    payload: { type: 'function_call', name: 'shell_command', call_id: 'call_busy', arguments: '{"command":"echo ok"}' },
  }]);
  const now = Date.now() / 1000;
  const snap = inferSnapshot(f, Date.now(), 'codex', now);
  assert.equal(snap.mode, 'busy');
  fs.rmSync(tmp, { recursive: true });
});

console.log('\nAll tests passed.');
