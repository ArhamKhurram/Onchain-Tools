import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { isHostedMode } from '../storage/index.js';
import type { SoundType } from '../discord/types.js';

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
  const allowed = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
  cb(null, allowed.includes(extname(file.originalname).toLowerCase()));
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: SOUNDS_DIR,
    filename: (_req, file, cb) => {
      const soundType = _req.params.soundType as string;
      cb(null, `${soundType}${extname(file.originalname)}`);
    },
  }),
  fileFilter: soundFileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

export const channelSoundUpload = multer({
  storage: multer.diskStorage({
    destination: SOUNDS_DIR,
    filename: (_req, file, cb) => {
      const channelId = _req.params.channelId as string;
      cb(null, `ch_${channelId}${extname(file.originalname)}`);
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

export const validSoundTypes: SoundType[] = ['highlight', 'contractAlert', 'keywordAlert', 'fomoTrade', 'pumpCallout', 'revival', 'breakout'];
