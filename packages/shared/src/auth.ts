import { z } from 'zod';
import { SEVERITIES } from './constants.ts';
import { asnSchema, countryCodeSchema } from './primitives.ts';

/** Who someone is to the app. Visitors (not signed in) have no account at all. */
export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/** Body of POST /api/auth/google: the ID token Google's sign-in button gave the browser. */
export const googleLoginSchema = z.object({
  credential: z.string().min(20).max(4096),
});

/** The signed-in person, as the API returns them. */
export interface PublicUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  role: Role;
}

/** Reply of POST /api/auth/google and POST /api/auth/refresh. */
export interface SessionResponse {
  /** Short-lived (15 min) token for the Authorization header and socket handshakes. Keep it in memory only. */
  accessToken: string;
  expiresAt: number;
  user: PublicUser;
}

/** Reply of GET /api/auth/config. Sign-in is hidden when no Google client is configured. */
export interface AuthConfig {
  googleClientId: string | null;
}

/** Only Discord's own webhook addresses are accepted, so the server cannot be pointed elsewhere. */
const discordWebhook = z
  .string()
  .max(200)
  .regex(
    /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w-]+$/,
    'must be a Discord webhook URL',
  );

/** What a signed-in user watches. Body of PUT /api/me/watchlist. */
export const watchlistSchema = z.object({
  countries: z.array(countryCodeSchema).max(30),
  asns: z.array(asnSchema).max(30),
  minSeverity: z.enum(SEVERITIES),
  discordWebhook: discordWebhook.nullable(),
});
export type Watchlist = z.infer<typeof watchlistSchema>;

export const EMPTY_WATCHLIST: Watchlist = {
  countries: [],
  asns: [],
  minSeverity: 'warning',
  discordWebhook: null,
};

/** Reply of GET /api/me. */
export interface MeResponse {
  user: PublicUser;
  watchlist: Watchlist;
}
