import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The local session store is a module singleton that reads OCT_DATA_DIR at import
// time, so the temp dir must be set BEFORE the dynamic import below. This exercises
// the real local persistence path (plaintext JSON in the data dir) end to end.
let dataDir: string;
let JsonStorageProvider: typeof import('../src/storage/json').JsonStorageProvider;

const TOKEN = 'header.payloadWithSecret.signature';
const SESSION_FILE = () => join(dataDir, 'pump-session.json');

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'oct-pump-session-'));
  process.env.OCT_DATA_DIR = dataDir;
  ({ JsonStorageProvider } = await import('../src/storage/json'));
});

afterAll(() => {
  delete process.env.OCT_DATA_DIR;
  if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

describe('JsonStorageProvider pump session (local, plaintext)', () => {
  it('returns null before anything is connected (→ not-connected status)', async () => {
    const storage = new JsonStorageProvider();
    expect(await storage.getPumpSession('local')).toBeNull();
  });

  it('stores a token, stamps updatedAt, and reads it back', async () => {
    const storage = new JsonStorageProvider();
    await storage.setPumpSession('local', TOKEN);
    const session = await storage.getPumpSession('local');
    expect(session).not.toBeNull();
    expect(session!.token).toBe(TOKEN);
    expect(typeof session!.updatedAt).toBe('string');
    expect(Number.isNaN(Date.parse(session!.updatedAt))).toBe(false);
  });

  it('clears the token on null and removes the on-disk file', async () => {
    const storage = new JsonStorageProvider();
    await storage.setPumpSession('local', TOKEN);
    expect(existsSync(SESSION_FILE())).toBe(true);

    await storage.setPumpSession('local', null);
    expect(await storage.getPumpSession('local')).toBeNull();
    // Cleared sessions leave nothing on disk, not a `{}` husk.
    expect(existsSync(SESSION_FILE())).toBe(false);
  });

  it('the persisted file contains only token + updatedAt (no extra credential surface)', async () => {
    const storage = new JsonStorageProvider();
    await storage.setPumpSession('local', TOKEN);
    const onDisk: unknown = JSON.parse(readFileSync(SESSION_FILE(), 'utf-8'));
    expect(Object.keys(onDisk as object).sort()).toEqual(['token', 'updatedAt']);
  });
});
