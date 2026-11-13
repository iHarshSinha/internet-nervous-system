import { z } from 'zod';

/**
 * Milliseconds since the Unix epoch.
 *
 * The lower bound (9 Sep 2001 in milliseconds) exists to catch a classic bug:
 * RIS Live and Atlas send timestamps in *seconds*. A seconds value passed
 * through by mistake is about a thousand times too small and fails here.
 */
export const epochMsSchema = z.number().int().min(1_000_000_000_000).max(9_999_999_999_999);

/** ISO 3166-1 alpha-2 country code, upper case. */
export const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'expected a 2-letter country code');

/** Autonomous system number (32-bit). */
export const asnSchema = z.number().int().min(0).max(4_294_967_295);

/** Per-room frame sequence number. 0 means "no frame sent yet". */
export const seqSchema = z.number().int().min(0);
