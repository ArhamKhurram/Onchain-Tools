import { Router } from 'express';
import { tryParseTokenEnrichment, buildRickReplyContext } from '../../utils/rickEmbedParser.js';
import { needsMetadataFallback, metadataOnlyEnrichmentPatch } from '../../utils/enrichmentMerge.js';
import { enrichToken, getTokenSnapshot, persistEnrichment } from '../../utils/tokenSnapshot.js';
import type { RouterContext } from '../context.js';
import { getUserId, safeError } from '../shared.js';

// Contract logging + enrichment (token snapshot, Rick embeds, DexScreener fallback).
export function createContractsRoutes(ctx: RouterContext): Router {
  const router = Router();
  const { wsServer, storage } = ctx;

  router.get('/tokens/:chain/:address/snapshot', async (req, res) => {
    try {
      const { chain, address } = req.params;
      if (!chain || !address) {
        return res.status(400).json({ error: 'chain and address are required.' });
      }
      const snapshot = await getTokenSnapshot(chain, address);
      if (!snapshot) return res.json({ found: false });

      if (req.userId && (snapshot.symbol || snapshot.name)) {
        try {
          const updated = await storage.enrichContract(req.userId, address, {
            tokenSymbol: snapshot.symbol,
            tokenName: snapshot.name,
            tokenPair: snapshot.pair,
            enrichmentSource: snapshot.source,
            enrichedAt: snapshot.enrichedAt,
            evmChain: snapshot.evmChain,
          });
          if (updated) wsServer.broadcastContractEnrichment(updated, req.userId);
        } catch (err) {
          console.error('[API] snapshot contract patch failed:', (err as Error).message);
        }
      }

      res.json({ found: true, ...snapshot });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch token snapshot') });
    }
  });

  router.get('/contracts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const limit = parseInt(req.query.limit as string) || 100;
      const since = req.query.since as string | undefined;
      res.json(await storage.getContracts(userId, limit, since));
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to fetch contracts') });
    }
  });

  router.post('/contracts', async (req, res) => {
    try {
      const userId = getUserId(req);
      const entry = req.body;
      if (!entry?.address || !entry?.messageId || !entry?.channelId || !entry?.timestamp) {
        return res.status(400).json({ error: 'Invalid contract entry.' });
      }
      const logged = await storage.logContract(userId, entry);
      wsServer.broadcastContract(logged, userId);

      const address: string = entry.address;
      const channelId: string = entry.channelId;
      const evmChain: string | undefined = entry.evmChain;
      setTimeout(async () => {
        try {
          const recent = await storage.getContracts(userId, 20);
          const hit = recent.find(
            (c) =>
              c.messageId === entry.messageId
              && c.address.toLowerCase() === address.toLowerCase()
              && needsMetadataFallback(c),
          );
          if (!hit) return;
          const enrichment = await enrichToken(address, hit.evmChain ?? evmChain);
          if (!enrichment) return;
          const updated = await storage.enrichContract(userId, enrichment.address, metadataOnlyEnrichmentPatch({
            tokenName: enrichment.tokenName,
            tokenSymbol: enrichment.tokenSymbol,
            tokenPair: enrichment.tokenPair,
            description: enrichment.description,
            liquidityUsd: enrichment.liquidityUsd,
            liquidityDisplay: enrichment.liquidityDisplay,
            volumeUsd: enrichment.volumeUsd,
            volumeDisplay: enrichment.volumeDisplay,
            priceUsd: enrichment.priceUsd,
            tokenAge: enrichment.tokenAge,
            evmChain: enrichment.evmChain,
            enrichmentSource: enrichment.enrichmentSource,
            enrichedAt: new Date().toISOString(),
          }), { channelId, messageId: entry.messageId });
          if (updated) {
            wsServer.broadcastContractEnrichment(updated, userId);
            void persistEnrichment(enrichment, enrichment.evmChain ?? hit.evmChain ?? evmChain);
            if (enrichment.evmChain) {
              const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
              if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
            }
          }
        } catch (err) {
          console.error('[API] Dex fallback failed:', (err as Error).message);
        }
      }, 8_000);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to log contract') });
    }
  });

  router.post('/contracts/rick-enrich', async (req, res) => {
    try {
      const userId = getUserId(req);
      const { channelId, embeds, content, authorUsername, referencedMessage } = req.body ?? {};
      if (!channelId) {
        return res.status(400).json({ error: 'channelId is required.' });
      }

      const rickReply = buildRickReplyContext(referencedMessage, req.body?.messageReference);
      const enrichment = tryParseTokenEnrichment({
        embeds,
        content,
        authorUsername,
        addressOverride: rickReply.addressOverride,
        callerName: rickReply.callerName,
      });
      if (!enrichment?.address) {
        return res.json({ applied: false });
      }

      const updated = await storage.enrichContract(userId, enrichment.address, {
        tokenName: enrichment.tokenName,
        tokenSymbol: enrichment.tokenSymbol,
        tokenPair: enrichment.tokenPair,
        description: enrichment.description,
        fdvAtCall: enrichment.fdvAtCall,
        fdvAtCallDisplay: enrichment.fdvAtCallDisplay,
        liquidityUsd: enrichment.liquidityUsd,
        liquidityDisplay: enrichment.liquidityDisplay,
        volumeUsd: enrichment.volumeUsd,
        volumeDisplay: enrichment.volumeDisplay,
        priceUsd: enrichment.priceUsd,
        tokenAge: enrichment.tokenAge,
        evmChain: enrichment.evmChain,
        enrichmentSource: enrichment.enrichmentSource,
        enrichedAt: new Date().toISOString(),
      }, { channelId, messageId: rickReply.messageId });

      if (updated) {
        wsServer.broadcastContractEnrichment(updated, userId);
        void persistEnrichment(enrichment, enrichment.evmChain);
        if (enrichment.evmChain) {
          const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
          if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
        }
        return res.json({ applied: true, entry: updated });
      }

      res.json({
        applied: true,
        enrichment: {
          address: enrichment.address,
          tokenName: enrichment.tokenName,
          tokenSymbol: enrichment.tokenSymbol,
          tokenPair: enrichment.tokenPair,
          description: enrichment.description,
          fdvAtCall: enrichment.fdvAtCall,
          fdvAtCallDisplay: enrichment.fdvAtCallDisplay,
          liquidityUsd: enrichment.liquidityUsd,
          liquidityDisplay: enrichment.liquidityDisplay,
          volumeUsd: enrichment.volumeUsd,
          volumeDisplay: enrichment.volumeDisplay,
          priceUsd: enrichment.priceUsd,
          tokenAge: enrichment.tokenAge,
          evmChain: enrichment.evmChain,
          enrichmentSource: enrichment.enrichmentSource,
          enrichedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to apply Rick enrichment') });
    }
  });

  router.post('/contracts/dex-enrich', async (req, res) => {
    try {
      const userId = getUserId(req);
      const { address, channelId, messageId } = req.body ?? {};
      if (!address || !channelId) {
        return res.status(400).json({ error: 'address and channelId are required.' });
      }

      const recent = await storage.getContracts(userId, 20);
      const hit = recent.find((c) => {
        if (c.address.toLowerCase() !== String(address).toLowerCase()) return false;
        if (messageId) return c.messageId === messageId;
        return c.channelId === channelId;
      });
      const enrichment = await enrichToken(address, hit?.evmChain);
      if (!enrichment) {
        return res.json({ applied: false });
      }

      const updated = await storage.enrichContract(userId, enrichment.address, metadataOnlyEnrichmentPatch({
        tokenName: enrichment.tokenName,
        tokenSymbol: enrichment.tokenSymbol,
        tokenPair: enrichment.tokenPair,
        description: enrichment.description,
        liquidityUsd: enrichment.liquidityUsd,
        liquidityDisplay: enrichment.liquidityDisplay,
        volumeUsd: enrichment.volumeUsd,
        volumeDisplay: enrichment.volumeDisplay,
        priceUsd: enrichment.priceUsd,
        tokenAge: enrichment.tokenAge,
        evmChain: enrichment.evmChain,
        enrichmentSource: enrichment.enrichmentSource,
        enrichedAt: new Date().toISOString(),
      }), { channelId, messageId });

      if (updated) {
        wsServer.broadcastContractEnrichment(updated, userId);
        void persistEnrichment(enrichment, enrichment.evmChain);
        if (enrichment.evmChain) {
          const chained = await storage.updateEvmChain(userId, enrichment.address, enrichment.evmChain);
          if (chained) wsServer.broadcastChainUpdate(enrichment.address, enrichment.evmChain, userId);
        }
        return res.json({ applied: true, entry: updated });
      }

      res.json({
        applied: true,
        enrichment: {
          address: enrichment.address,
          ...metadataOnlyEnrichmentPatch({
            tokenName: enrichment.tokenName,
            tokenSymbol: enrichment.tokenSymbol,
            tokenPair: enrichment.tokenPair,
            description: enrichment.description,
            liquidityUsd: enrichment.liquidityUsd,
            liquidityDisplay: enrichment.liquidityDisplay,
            volumeUsd: enrichment.volumeUsd,
            volumeDisplay: enrichment.volumeDisplay,
            priceUsd: enrichment.priceUsd,
            tokenAge: enrichment.tokenAge,
            evmChain: enrichment.evmChain,
            enrichmentSource: enrichment.enrichmentSource,
            enrichedAt: new Date().toISOString(),
          }),
        },
      });
    } catch (err) {
      res.status(500).json({ error: safeError(err, 'Failed to enrich contract from DexScreener') });
    }
  });

  router.delete('/contracts', async (req, res) => {
    const userId = getUserId(req);
    await storage.deleteAllContracts(userId);
    res.json({ success: true });
  });

  router.delete('/contracts/:messageId/:address', async (req, res) => {
    const userId = getUserId(req);
    const deleted = await storage.deleteContract(userId, req.params.messageId, req.params.address);
    if (!deleted) return res.status(404).json({ error: 'Contract not found' });
    res.json({ success: true });
  });

  return router;
}
