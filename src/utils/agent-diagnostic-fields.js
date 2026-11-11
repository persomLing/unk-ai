// Names only. Values, DOM labels, filenames and input text never enter diagnostics.
const FIELDS = new Set('tag role name text type autocomplete domId fieldName disabled contentEditable inputMode href targetOrigin targetBlank download formRole formAction formOrigin formIsSearch readable readOnly scrollOnly regionKind fileInput uploadOnly'.split(' '));
export const AGENT_EXECUTION_STATES = new Set(['not-started', 'started', 'verified', 'uncertain']);
export const AGENT_STRATEGIES = new Set(['continue', 'reobserve', 'replan', 'visual', 'extend', 'stop', 'handoff']);

export function diagnosticChangedFields(value) {
  return Array.isArray(value) ? [...new Set(value.filter(item => FIELDS.has(item)))].slice(0, FIELDS.size) : undefined;
}

/** Per-task opaque correlation; never send plaintext arguments to an injected logger. */
export async function agentDiagnosticFingerprint(taskId, value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (!serialized || serialized.length > 1000000) return undefined;
    const bytes = new TextEncoder().encode(`${taskId}\u0000${serialized}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return `fp_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  } catch { return undefined; }
}
