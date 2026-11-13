import { EMPTY_WATCHLIST, type PublicUser, type Role, type Watchlist } from '@ins/shared';
import { ObjectId, type Db } from 'mongodb';
import type { GoogleIdentity } from './google.ts';

/**
 * Users, sessions and watchlists. One interface, two implementations: MongoDB
 * for the app, and memory for fast tests of the routes.
 */
export interface AuthStore {
  ensureIndexes(): Promise<void>;
  /** Create the user on first sign-in; refresh name, picture and role after that. */
  upsertGoogleUser(identity: GoogleIdentity, role: Role): Promise<PublicUser>;
  getUser(id: string): Promise<PublicUser | null>;
  saveRefreshToken(hash: string, userId: string, expiresAt: Date): Promise<void>;
  /** Remove a refresh token and return whose it was; null if unknown or expired. Used once. */
  takeRefreshToken(hash: string): Promise<string | null>;
  deleteRefreshToken(hash: string): Promise<void>;
  getWatchlist(userId: string): Promise<Watchlist>;
  saveWatchlist(userId: string, watchlist: Watchlist): Promise<void>;
  /** Users watching a country or a network, with the lowest severity they want to hear about. */
  watchersOf(
    cc: string | null,
    asn: number | null,
  ): Promise<{ userId: string; minSeverity: Watchlist['minSeverity'] }[]>;
}

interface UserDoc {
  _id: ObjectId;
  googleSub: string;
  email: string;
  name: string;
  picture: string | null;
  role: Role;
  createdAt: Date;
  lastLoginAt: Date;
}

const toPublic = (u: UserDoc): PublicUser => ({
  id: u._id.toHexString(),
  email: u.email,
  name: u.name,
  picture: u.picture,
  role: u.role,
});

export function createMongoAuthStore(db: Db): AuthStore {
  const users = db.collection<UserDoc>('users');
  const tokens = db.collection<{ _id: string; userId: string; expiresAt: Date }>('refresh_tokens');
  const watchlists = db.collection<Watchlist & { _id: string; updatedAt: Date }>('watchlists');

  return {
    async ensureIndexes() {
      await users.createIndex({ googleSub: 1 }, { unique: true });
      await users.createIndex({ email: 1 }, { unique: true });
      // MongoDB deletes expired refresh tokens by itself.
      await tokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      await tokens.createIndex({ userId: 1 });
    },

    async upsertGoogleUser(identity, role) {
      const now = new Date();
      const doc = await users.findOneAndUpdate(
        { googleSub: identity.sub },
        {
          $set: {
            email: identity.email,
            name: identity.name,
            picture: identity.picture,
            role,
            lastLoginAt: now,
          },
          $setOnInsert: { _id: new ObjectId(), googleSub: identity.sub, createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );
      if (!doc) throw new Error('user upsert returned nothing');
      return toPublic(doc);
    },

    async getUser(id) {
      if (!ObjectId.isValid(id)) return null;
      const doc = await users.findOne({ _id: new ObjectId(id) });
      return doc ? toPublic(doc) : null;
    },

    async saveRefreshToken(hash, userId, expiresAt) {
      await tokens.insertOne({ _id: hash, userId, expiresAt });
    },

    async takeRefreshToken(hash) {
      const doc = await tokens.findOneAndDelete({ _id: hash });
      if (!doc || doc.expiresAt.getTime() < Date.now()) return null;
      return doc.userId;
    },

    async deleteRefreshToken(hash) {
      await tokens.deleteOne({ _id: hash });
    },

    async getWatchlist(userId) {
      const doc = await watchlists.findOne({ _id: userId });
      if (!doc) return EMPTY_WATCHLIST;
      const { _id: _ignored, updatedAt: _u, ...watchlist } = doc;
      return watchlist;
    },

    async watchersOf(cc, asn) {
      const or: Record<string, unknown>[] = [];
      if (cc) or.push({ countries: cc });
      if (asn !== null) or.push({ asns: asn });
      if (or.length === 0) return [];
      const docs = await watchlists
        .find({ $or: or }, { projection: { _id: 1, minSeverity: 1 } })
        .toArray();
      return docs.map((d) => ({ userId: d._id, minSeverity: d.minSeverity }));
    },
    async saveWatchlist(userId, watchlist) {
      await watchlists.replaceOne(
        { _id: userId },
        { ...watchlist, updatedAt: new Date() },
        { upsert: true },
      );
    },
  };
}

/** The same behaviour in memory, for tests. */
export function createMemoryAuthStore(): AuthStore {
  const users = new Map<string, UserDoc>();
  const tokens = new Map<string, { userId: string; expiresAt: Date }>();
  const watchlists = new Map<string, Watchlist>();

  return {
    ensureIndexes: async () => {},
    async upsertGoogleUser(identity, role) {
      const existing = [...users.values()].find((u) => u.googleSub === identity.sub);
      const now = new Date();
      const doc: UserDoc = existing
        ? { ...existing, ...identity, role, lastLoginAt: now }
        : {
            _id: new ObjectId(),
            googleSub: identity.sub,
            ...identity,
            role,
            createdAt: now,
            lastLoginAt: now,
          };
      users.set(doc._id.toHexString(), doc);
      return toPublic(doc);
    },
    getUser: async (id) => {
      const u = users.get(id);
      return u ? toPublic(u) : null;
    },
    saveRefreshToken: async (hash, userId, expiresAt) =>
      void tokens.set(hash, { userId, expiresAt }),
    async takeRefreshToken(hash) {
      const t = tokens.get(hash);
      tokens.delete(hash);
      return t && t.expiresAt.getTime() >= Date.now() ? t.userId : null;
    },
    deleteRefreshToken: async (hash) => void tokens.delete(hash),
    getWatchlist: async (userId) => watchlists.get(userId) ?? EMPTY_WATCHLIST,
    saveWatchlist: async (userId, w) => void watchlists.set(userId, w),
    watchersOf: async (cc, asn) =>
      [...watchlists]
        .filter(
          ([, w]) => (cc && w.countries.includes(cc)) || (asn !== null && w.asns.includes(asn)),
        )
        .map(([userId, w]) => ({ userId, minSeverity: w.minSeverity })),
  };
}
