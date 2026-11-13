import { watchlistSchema, type MeResponse } from '@ins/shared';
import { Router } from 'express';
import { principalOf, requireAdmin, requireUser } from '../auth/middleware.ts';
import type { AuthStore } from '../auth/store.ts';

export interface MeDeps {
  secret: string;
  store: AuthStore;
  /** Pipeline and delivery numbers for admins. */
  adminStats: () => Record<string, unknown>;
}

/** What a signed-in user can do: see themselves, and edit what they watch. Plus an admin-only view. */
export function meRouter({ secret, store, adminStats }: MeDeps): Router {
  const router = Router();
  const signedIn = requireUser(secret);

  router.get('/api/me', signedIn, async (_req, res) => {
    const id = principalOf(res).id;
    const user = await store.getUser(id);
    if (!user) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Account not found' } });
      return;
    }
    const body: MeResponse = { user, watchlist: await store.getWatchlist(id) };
    res.json(body);
  });

  router.put('/api/me/watchlist', signedIn, async (req, res) => {
    const parsed = watchlistSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'bad_request',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      });
      return;
    }
    const watchlist = {
      ...parsed.data,
      countries: [...new Set(parsed.data.countries)],
      asns: [...new Set(parsed.data.asns)],
    };
    await store.saveWatchlist(principalOf(res).id, watchlist);
    res.json(watchlist);
  });

  router.get('/api/admin/stats', signedIn, requireAdmin, (_req, res) => {
    res.json(adminStats());
  });

  return router;
}
