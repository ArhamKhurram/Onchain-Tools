// Narrowing primitives for untrusted third-party JSON.
//
// Several keyless upstreams (985monitor, robinhoodtrenches) publish documents
// we neither control nor version. Their payloads reach the console's DOM and
// this process's logs, so every field is narrowed through these before use:
// nothing is trusted to be present, to be the right type, to be finite, or to
// be a bounded length.
//
// All pure, all unit-tested — the parsers built on top of them are the only
// place these upstreams' shapes are interpreted.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A finite number, or null. Rejects NaN and Infinity — both of which survive
 * JSON round-trips through numeric strings and would otherwise reach
 * `toFixed()` in the UI.
 */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * A non-empty trimmed string, truncated to `maxLength`, or null. The cap is
 * the point: an upstream that starts emitting megabyte strings must not
 * propagate into React state or a log line.
 */
export function str(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * Only http(s) URLs survive. These end up in `<img src>` and `<a href>`, so
 * this is what stops a `javascript:` or `data:` value from a third-party file
 * becoming a click target in the console.
 */
export function httpUrl(value: unknown): string | null {
  const raw = str(value, 2048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? raw : null;
  } catch {
    return null;
  }
}

/** A boolean from a JSON boolean or the 0/1 integers these APIs use instead. */
export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 0) return value === 1;
  return null;
}
