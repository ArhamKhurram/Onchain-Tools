import { Router, static as expressStatic } from 'express';
import { existsSync, unlinkSync } from 'fs';
import { join, extname } from 'path';
import { createClient } from '@supabase/supabase-js';
import { isHostedMode } from '../../storage/index.js';
import type { SoundType } from '../../discord/types.js';
import type { RouterContext } from '../context.js';
import {
  getUserId,
  safeError,
  SOUNDS_DIR,
  upload,
  channelSoundUpload,
  memoryUpload,
  validSoundTypes,
} from '../shared.js';

// Sound file uploads/deletes (per-type and per-channel) + static serving.
export function createSoundsRoutes(_ctx: RouterContext): Router {
  const router = Router();

  function getSupabaseStorage() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error('Supabase not configured');
    return createClient(url, key, { auth: { persistSession: false } }).storage.from('sounds');
  }

  router.post('/sounds/:soundType', isHostedMode() ? memoryUpload.single('file') : upload.single('file'), async (req, res) => {
    if (!validSoundTypes.includes(req.params.soundType as SoundType)) {
      return res.status(400).json({ error: 'Invalid sound type' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided or unsupported format' });
    }

    if (isHostedMode()) {
      const userId = getUserId(req);
      const ext = extname(req.file.originalname);
      const storagePath = `${userId}/${req.params.soundType}${ext}`;
      const bucket = getSupabaseStorage();

      const { error } = await bucket.upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
      if (error) return res.status(500).json({ error: safeError(error, 'Failed to upload sound') });

      const { data: urlData } = bucket.getPublicUrl(storagePath);
      res.json({ url: urlData.publicUrl, filename: `${req.params.soundType}${ext}` });
    } else {
      const url = `/api/sounds/${req.file.filename}`;
      res.json({ url, filename: req.file.filename });
    }
  });

  router.delete('/sounds/:soundType', async (req, res) => {
    const soundType = req.params.soundType as SoundType;
    if (!validSoundTypes.includes(soundType)) {
      return res.status(400).json({ error: 'Invalid sound type' });
    }

    if (isHostedMode()) {
      const userId = getUserId(req);
      const bucket = getSupabaseStorage();
      const extensions = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
      const paths = extensions.map((ext) => `${userId}/${soundType}${ext}`);
      await bucket.remove(paths);
    } else {
      const extensions = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
      for (const ext of extensions) {
        const filePath = join(SOUNDS_DIR, `${soundType}${ext}`);
        try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    res.json({ success: true });
  });

  router.post('/channel-sounds/:channelId', isHostedMode() ? memoryUpload.single('file') : channelSoundUpload.single('file'), async (req, res) => {
    const channelId = req.params.channelId as string;
    if (!channelId || !/^\d+$/.test(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided or unsupported format' });
    }

    if (isHostedMode()) {
      const userId = getUserId(req);
      const ext = extname(req.file.originalname);
      const storagePath = `${userId}/ch_${channelId}${ext}`;
      const bucket = getSupabaseStorage();

      const { error } = await bucket.upload(storagePath, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true,
      });
      if (error) return res.status(500).json({ error: safeError(error, 'Failed to upload channel sound') });

      const { data: urlData } = bucket.getPublicUrl(storagePath);
      res.json({ url: urlData.publicUrl, filename: `ch_${channelId}${ext}` });
    } else {
      const url = `/api/sounds/${req.file.filename}`;
      res.json({ url, filename: req.file.filename });
    }
  });

  router.delete('/channel-sounds/:channelId', async (req, res) => {
    const channelId = req.params.channelId as string;
    if (!channelId || !/^\d+$/.test(channelId)) {
      return res.status(400).json({ error: 'Invalid channel ID' });
    }

    if (isHostedMode()) {
      const userId = getUserId(req);
      const bucket = getSupabaseStorage();
      const extensions = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
      const paths = extensions.map((ext) => `${userId}/ch_${channelId}${ext}`);
      await bucket.remove(paths);
    } else {
      const extensions = ['.mp3', '.wav', '.ogg', '.webm', '.m4a'];
      for (const ext of extensions) {
        const filePath = join(SOUNDS_DIR, `ch_${channelId}${ext}`);
        try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    res.json({ success: true });
  });

  router.use('/sounds', expressStatic(SOUNDS_DIR));

  return router;
}
