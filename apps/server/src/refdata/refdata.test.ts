import { describe, expect, it } from 'vitest';
import { toProbeInfo } from './probes.ts';
import { AsnCountryIndex, parseDelegated } from './rir.ts';

// Lines in the format of the real files, including the header and summary lines.
const DELEGATED = `2.3|apnic|20261113|191375||20261112|+1000
apnic|*|asn|*|14867|summary
apnic|*|ipv4|*|61835|summary
apnic|JP|asn|173|1|20020801|allocated|A91A4B1A
apnic|NZ|asn|681|1|20020801|allocated|A91127C1
arin|US|asn|32768|1024|20020101|assigned|abc
ripencc|NL|asn|1136|1|19930901|allocated|def
apnic|AU|asn|9000|1|20050101|reserved|
apnic||asn|9001|5|20050101|available|
apnic|JP|ipv4|1.0.16.0|4096|20110412|allocated|A92E1062
`;

describe('parseDelegated', () => {
  it('keeps only ASN blocks that are in use', () => {
    expect(parseDelegated(DELEGATED)).toEqual([
      { start: 173, count: 1, cc: 'JP' },
      { start: 681, count: 1, cc: 'NZ' },
      { start: 32768, count: 1024, cc: 'US' },
      { start: 1136, count: 1, cc: 'NL' },
    ]);
  });
});

describe('AsnCountryIndex', () => {
  const index = new AsnCountryIndex(parseDelegated(DELEGATED));

  it('finds single ASNs and ASNs inside a block', () => {
    expect(index.lookup(173)).toBe('JP');
    expect(index.lookup(1136)).toBe('NL');
    expect(index.lookup(32768)).toBe('US');
    expect(index.lookup(33000)).toBe('US');
    expect(index.lookup(33791)).toBe('US'); // last ASN of the block
  });

  it('returns undefined outside every block', () => {
    expect(index.lookup(0)).toBeUndefined();
    expect(index.lookup(174)).toBeUndefined();
    expect(index.lookup(33792)).toBeUndefined();
    expect(index.lookup(9000)).toBeUndefined(); // reserved
    expect(new AsnCountryIndex([]).lookup(1)).toBeUndefined();
  });
});

describe('toProbeInfo', () => {
  it('reads a real probe record', () => {
    const raw = {
      asn_v4: 206238,
      asn_v6: 206238,
      country_code: 'NL',
      geometry: { type: 'Point', coordinates: [4.9275, 52.3475] },
      id: 1,
      status: { id: 1, name: 'Connected', since: '2026-11-08T08:18:07Z' },
      type: 'Probe',
    };
    expect(toProbeInfo(raw)).toEqual({
      id: 1,
      cc: 'NL',
      asn: 206238,
      lat: 52.3475,
      lon: 4.9275,
      status: 'Connected',
    });
  });

  it('copes with missing fields and rejects garbage', () => {
    const bare = {
      id: 7,
      country_code: null,
      asn_v4: null,
      asn_v6: 3320,
      geometry: null,
      status: { name: 'Disconnected' },
    };
    expect(toProbeInfo(bare)).toEqual({ id: 7, asn: 3320, status: 'Disconnected' });
    expect(toProbeInfo({ id: 'x' })).toBeNull();
  });
});
