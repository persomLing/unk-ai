import { DIAGNOSTIC_FORMAT, DIAGNOSTIC_VERSION, UUID, beijingDate, diagnosticError, sanitizeDiagnosticError, validateStoredDiagnostic } from './diagnostic-schema.js';

const NAME = /^unk-ai-diagnostic-v1-(\d{4}-\d{2}-\d{2})-([a-f0-9-]{36})\.json$/;
export const MAX_SHARD_BYTES = 256 * 1024;

export function diagnosticFilename(batch) {
  if (!UUID.test(batch.id) || !/^\d{4}-\d{2}-\d{2}$/.test(batch.date)) throw diagnosticError('ERR_DIAGNOSTIC_INPUT', 'invalid-data');
  return `unk-ai-diagnostic-v1-${batch.date}-${batch.id}.json`;
}

export function parseManagedShard(name, content, ownerId) {
  const match = NAME.exec(name);
  if (!match || !UUID.test(match[2])) return null;
  try {
    const shard = JSON.parse(content);
    if (shard?.format !== DIAGNOSTIC_FORMAT || shard.version !== DIAGNOSTIC_VERSION
      || shard.ownerId !== ownerId || shard.batchId !== match[2] || shard.date !== match[1]
      || !Array.isArray(shard.events) || shard.events.length > 100
      || shard.eventCount !== shard.events.length) return null;
    const events = shard.events.map(validateStoredDiagnostic);
    if (events.some(event => !event || beijingDate(Date.parse(event.at)) !== shard.date)) return null;
    return { date: shard.date, events };
  } catch { return null; }
}

export async function diagnosticDirectory(root, create = false, checkpoint = () => {}) {
  checkpoint();
  if (!root) throw diagnosticError('ERR_DIAGNOSTIC_DIRECTORY', 'no-directory');
  const permission = await root.queryPermission({ mode: 'readwrite' });
  checkpoint();
  if (permission !== 'granted') throw diagnosticError('ERR_DIAGNOSTIC_PERMISSION', permission === 'prompt' ? 'permission-prompt' : 'permission-denied', 'NotAllowedError');
  return root.getDirectoryHandle('diagnostics', { create });
}

/** Immutable files make retry safe even when a prior close completed after its caller timed out. */
export async function writeDiagnosticBatch(batch, checkpoint) {
  checkpoint();
  const directory = await diagnosticDirectory(batch.directoryHandle, true, checkpoint);
  checkpoint();
  const filename = diagnosticFilename(batch);
  let file;
  try {
    file = await directory.getFileHandle(filename);
    checkpoint();
    const existing = await file.getFile();
    checkpoint();
    if (existing.size > MAX_SHARD_BYTES) throw diagnosticError('ERR_DIAGNOSTIC_FILE_CONFLICT', 'file-conflict');
    const content = await existing.text();
    checkpoint();
    if (content === batch.content) return;
    // An empty file can be left by this batch before createWritable/close.
    if (content !== '') throw diagnosticError('ERR_DIAGNOSTIC_FILE_CONFLICT', 'file-conflict');
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
    checkpoint();
    file = await directory.getFileHandle(filename, { create: true });
  }
  checkpoint();
  let writer;
  try {
    writer = await file.createWritable();
    checkpoint();
    await writer.write(batch.content);
    checkpoint();
    // Once close starts its outcome is authoritative, even after the caller's timeout.
    await writer.close();
  } catch (error) {
    try { await writer?.abort?.(); } catch { /* The outer deadline still bounds the caller. */ }
    throw error;
  }
}

export async function cleanDiagnosticDirectory(root, { ownerId, oldestDate, checkpoint, maxFiles = 600 } = {}) {
  let directory;
  try { checkpoint(); directory = await diagnosticDirectory(root, false, checkpoint); }
  catch (error) { if (error?.name === 'NotFoundError') return { removed: 0 }; throw error; }
  let scanned = 0;
  let removed = 0;
  let limited = false;
  for await (const [name, handle] of directory.entries()) {
    checkpoint();
    const match = NAME.exec(name);
    if (handle.kind !== 'file' || !match || match[1] >= oldestDate) continue;
    if (++scanned > maxFiles) { limited = true; break; }
    const file = await handle.getFile();
    checkpoint();
    if (file.size > MAX_SHARD_BYTES) continue;
    const content = await file.text();
    checkpoint();
    if (!parseManagedShard(name, content, ownerId)) continue;
    // Only a file whose marker, owner, batch ID, date and event schema match is managed.
    await directory.removeEntry(name);
    removed += 1;
  }
  return { removed, limited };
}

export async function readDiagnosticDirectory(root, { ownerId, date, wait, maxFiles = 600, maxBytes = 8 * 1024 * 1024, maxEvents = 5000 } = {}) {
  const result = { events: [], filesRead: 0, bytesRead: 0, partial: false, reasons: [] };
  try {
    let directory;
    try { directory = await wait(diagnosticDirectory(root)); }
    catch (error) { if (error?.name === 'NotFoundError') return result; throw error; }
    const iterator = directory.entries()[Symbol.asyncIterator]();
    let scanned = 0;
    while (true) {
      const next = await wait(iterator.next());
      if (next.done) break;
      const [name, handle] = next.value;
      const match = NAME.exec(name);
      if (handle.kind !== 'file' || !match || match[1] !== date) continue;
      if (++scanned > maxFiles) { result.partial = true; result.reasons.push('export-limit'); break; }
      const file = await wait(handle.getFile());
      if (file.size > MAX_SHARD_BYTES || result.bytesRead + file.size > maxBytes) { result.partial = true; result.reasons.push('export-limit'); continue; }
      const content = await wait(file.text());
      result.bytesRead += file.size;
      const shard = parseManagedShard(name, content, ownerId);
      if (!shard) { result.partial = true; result.reasons.push('invalid-data'); continue; }
      result.filesRead += 1;
      const remaining = maxEvents - result.events.length;
      result.events.push(...shard.events.slice(0, remaining));
      if (shard.events.length > remaining || result.events.length >= maxEvents) { result.partial = true; result.reasons.push('export-limit'); break; }
    }
  } catch (error) {
    result.partial = true;
    result.reasons.push(sanitizeDiagnosticError(error)?.reason || 'directory-unavailable');
  }
  result.reasons = [...new Set(result.reasons)];
  return result;
}
