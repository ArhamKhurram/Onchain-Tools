import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isHostedMode } from '../storage/index.js';
import { soundExtension, soundFileName, channelSoundFileName } from './soundNames.js';

// Stateless helpers, multer instances, and paths shared across the API
// sub-routers. Kept in `api/` (not `api/routes/`) so SOUNDS_DIR resolves relative
// to this directory exactly as it did when everything lived in routes.ts.

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SOUNDS_DIR = join(__dirname, '../../data/sounds');
if (!existsSync(SOUNDS_DIR)) mkdirSync(SOUNDS_DIR, { recursive: true });

export function safeError(err: any, fallback: string): string {
  if (!isHostedMode()) return err?.message ?? fallback;
  console.error(`[API] ${fallback}:`, err?.message ?? err);
  return fallback;
}

export function getUserId(req: any): string {
  return req.userId ?? 'local';
}

export const soundFileFilter = (_req: Express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  cb(null, soundExtension(file.originalname) !== null);
};

// The filename callbacks below are the last line of defence, not the first: the
// routes reject a bad `:soundType`/`:channelId` before multer ever runs. They
// still refuse to build a name from an unvalidated param, so that reordering the
// middleware chain later cannot silently reopen a path traversal.
export const upload = multer({
  storage: multer.diskStorage({
    destination: SOUNDS_DIR,
    filename: (req, file, cb) => {
      const name = soundFileName(req.params.soundType, file.originalname);
      if (!name) return cb(new Error('Invalid sound type'), '');
      cb(null, name);
    },
  }),
  fileFilter: soundFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

export const channelSoundUpload = multer({
  storage: multer.diskStorage({
    destination: SOUNDS_DIR,
    filename: (req, file, cb) => {
      const name = channelSoundFileName(req.params.channelId, file.originalname);
      if (!name) return cb(new Error('Invalid channel ID'), '');
      cb(null, name);
    },
  }),
  fileFilter: soundFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: soundFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

export const messageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

// Canonical home is `soundNames.ts`; re-exported here so the long-standing
// `shared.js` import surface keeps working for any caller that still uses it.
export { validSoundTypes } from './soundNames.js';
