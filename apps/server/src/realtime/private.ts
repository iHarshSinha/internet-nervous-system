import { NAMESPACES, rooms } from '@ins/shared';
import { verifyAccessToken } from '../auth/tokens.ts';
import type { Logger } from '../logger.ts';
import type { IoServer, LiveNamespace } from './live.ts';

/**
 * The two private namespaces. Both check the access token sent in the
 * handshake (`io('/user', { auth: { token } })`) before the connection is
 * accepted, so nothing in them is ever sent to a visitor.
 *
 *  - `/user`: any signed-in user. Each socket joins `user:<id>` and receives
 *    only that user's alerts (from Phase 2).
 *  - `/admin`: admins only. Sockets join `ops`, the live pipeline metrics.
 */
export function attachPrivate(
  io: IoServer,
  secret: string,
  log: Logger,
): { user: LiveNamespace; admin: LiveNamespace } {
  const user: LiveNamespace = io.of(NAMESPACES.user);
  const admin: LiveNamespace = io.of(NAMESPACES.admin);

  const authenticate =
    (needAdmin: boolean) =>
    (socket: Parameters<Parameters<LiveNamespace['use']>[0]>[0], next: (err?: Error) => void) => {
      const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
      const principal = typeof token === 'string' ? verifyAccessToken(token, secret) : null;
      if (!principal) return next(new Error('unauthorized'));
      if (needAdmin && principal.role !== 'admin') return next(new Error('forbidden'));
      socket.data.principal = principal;
      next();
    };

  user.use(authenticate(false));
  admin.use(authenticate(true));

  user.on('connection', (socket) => {
    const id = (socket.data.principal as { id: string }).id;
    void socket.join(rooms.user(id));
    log.debug({ userId: id }, 'user socket connected');
  });
  admin.on('connection', (socket) => {
    void socket.join(rooms.ops);
    log.debug({ userId: (socket.data.principal as { id: string }).id }, 'admin socket connected');
  });

  return { user, admin };
}
