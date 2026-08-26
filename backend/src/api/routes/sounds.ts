import { Router, static as expressStatic } from 'express';
import type { RequestHandler } from 'express';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
import type { RouterContext } from '../context.js';
import {
  getUserId,
  safeError,
  SOUNDS_DIR,
  upload,
  channelSoundUpload,
  memoryUpload,
} from '../shared.js';
import {
  isValidChannelId,
  isValidSoundType,
  soundFileName,
  channelSoundFileName,
  soundFileCandidates,
  channelSoundFileCandidates,
} from '../soundNames.js';

// Sound file uploads/deletes (per-type and per-channel) + static serving.
export function createSoundsRoutes(_ctx: RouterContext): Router {
  const router = Router();

  function getSupabaseStorage() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Supabase not configured');
    return createClient(url, key, { auth: { persistSession: false } }).storage.from('sounds');
  }

  // These guards must stay AHEAD of the multer middleware. multer streams the
  // body to its destination as part of the middleware chain, so validating
  // inside the handler means the file is already written by the time we reject
  // it — and `multipart/form-data` is CORS-safelisted, so a cross-origin POST
  // reaches us with no preflight to stop it.
  const requireSoundType: RequestHandler = (req, res, next) => {
    if (!isValidSoundType(req.params.soundType)) {
      res.status(400).json({ error: 'Invalid sound type' });
      return;
    }
    next();
  };

  const requireChannelId: RequestHandler = (req, res, next) => {
    if (!isValidChannelId(req.params.channelId)) {
      res.status(400).json({ error: 'Invalid channel ID' });
      return;
    }
    next();
  };

  router.post(
    '/sounds/:soundType',
    requireSoundType,
    isHostedMode() ? memoryUpload.single('file') : upload.single('file'),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided or unsupported format' });
      }

      if (isHostedMode()) {
        const userId = getUserId(req);
        const filename = soundFileName(req.params.soundType, req.file.originalname);
        if (!filename) return res.status(400).json({ error: 'Invalid sound type' });
        const storagePath = `${userId}/${filename}`;
        const bucket = getSupabaseStorage();

        const { error } = await bucket.upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });
        if (error) return res.status(500).json({ error: safeError(error, 'Failed to upload sound') });

        const { data: urlData } = bucket.getPublicUrl(storagePath);
        res.json({ url: urlData.publicUrl, filename });
      } else {
        const url = `/api/sounds/${req.file.filename}`;
        res.json({ url, filename: req.file.filename });
      }
    },
  );

  router.delete('/sounds/:soundType', requireSoundType, async (req, res) => {
    const candidates = soundFileCandidates(req.params.soundType);

    if (isHostedMode()) {
      const userId = getUserId(req);
      const bucket = getSupabaseStorage();
      await bucket.remove(candidates.map((name) => `${userId}/${name}`));
    } else {
      for (const name of candidates) {
        const filePath = join(SOUNDS_DIR, name);
        try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    res.json({ success: true });
  });

  router.post(
    '/channel-sounds/:channelId',
    requireChannelId,
    isHostedMode() ? memoryUpload.single('file') : channelSoundUpload.single('file'),
    async (req, res) => {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided or unsupported format' });
      }

      if (isHostedMode()) {
        const userId = getUserId(req);
        const filename = channelSoundFileName(req.params.channelId, req.file.originalname);
        if (!filename) return res.status(400).json({ error: 'Invalid channel ID' });
        const storagePath = `${userId}/${filename}`;
        const bucket = getSupabaseStorage();

        const { error } = await bucket.upload(storagePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });
        if (error) return res.status(500).json({ error: safeError(error, 'Failed to upload channel sound') });

        const { data: urlData } = bucket.getPublicUrl(storagePath);
        res.json({ url: urlData.publicUrl, filename });
      } else {
        const url = `/api/sounds/${req.file.filename}`;
        res.json({ url, filename: req.file.filename });
      }
    },
  );

  router.delete('/channel-sounds/:channelId', requireChannelId, async (req, res) => {
    const candidates = channelSoundFileCandidates(req.params.channelId);

    if (isHostedMode()) {
      const userId = getUserId(req);
      const bucket = getSupabaseStorage();
      await bucket.remove(candidates.map((name) => `${userId}/${name}`));
    } else {
      for (const name of candidates) {
        const filePath = join(SOUNDS_DIR, name);
        try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    res.json({ success: true });
  });

  router.use('/sounds', expressStatic(SOUNDS_DIR));

  return router;
}
