import { Router } from 'express';
import type { RouterContext } from '../context.js';
import { getUserId } from '../shared.js';

// Rooms CRUD.
export function createRoomsRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { storage } = ctx;

  router.get('/rooms', async (req, res) => {
    const userId = getUserId(req);
    res.json(await storage.getRooms(userId));
  });

  router.get('/rooms/:id', async (req, res) => {
    const userId = getUserId(req);
    const room = await storage.getRoom(userId, req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  });

  router.post('/rooms', async (req, res) => {
    const userId = getUserId(req);
    const { name, channels, highlightedUsers, filteredUsers, filterEnabled, color } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const room = await storage.createRoom(userId, {
      name,
      channels: channels ?? [],
      highlightedUsers: highlightedUsers ?? [],
      filteredUsers: filteredUsers ?? [],
      filterEnabled: filterEnabled ?? false,
      color: color ?? null,
    });
    res.status(201).json(room);
  });

  router.put('/rooms/:id', async (req, res) => {
    const userId = getUserId(req);
    const { name, channels, highlightedUsers, filteredUsers, filterEnabled, color, keywordPatterns, highlightMode, highlightedUserColors, hotkey } = req.body;
    const room = await storage.updateRoom(userId, req.params.id, {
      ...(name !== undefined && { name }),
      ...(channels !== undefined && { channels }),
      ...(highlightedUsers !== undefined && { highlightedUsers }),
      ...(filteredUsers !== undefined && { filteredUsers }),
      ...(filterEnabled !== undefined && { filterEnabled }),
      ...(color !== undefined && { color }),
      ...(keywordPatterns !== undefined && { keywordPatterns }),
      ...(highlightMode !== undefined && { highlightMode }),
      ...(highlightedUserColors !== undefined && { highlightedUserColors }),
      ...(hotkey !== undefined && { hotkey }),
    });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
  });

  router.delete('/rooms/:id', async (req, res) => {
    const userId = getUserId(req);
    const deleted = await storage.deleteRoom(userId, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Room not found' });
    res.json({ success: true });
  });

  return router;
}
