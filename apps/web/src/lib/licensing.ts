/**
 * License classification for catalog titles.
 *
 * A title may only carry a price when its license permits commercial
 * distribution. Non-commercial asset licenses (the CC *-NC family, common in
 * open-source games) forbid a paid listing outright, so this is a correctness
 * rule about money rather than a preference.
 *
 * The database is authoritative: `public.license_permits_commercial()` in
 * supabase/migrations/0011_titles_catalog.sql enforces the same rule via a check
 * constraint. This module mirrors it so the UI can disable pricing before a
 * write is attempted. "Unit Tests/catalog-titles.test.ts" parses the migration
 * and asserts the two lists agree, so the mirror cannot drift silently.
 */

/** License identifiers under which a title may be priced. */
export const COMMERCIAL_LICENSE_IDS: readonly string[] = [
  "gpl-2.0",
  "gpl-3.0",
  "agpl-3.0",
  "lgpl-2.1",
  "lgpl-3.0",
  "mit",
  "bsd-2-clause",
  "bsd-3-clause",
  "apache-2.0",
  "zlib",
  "mpl-2.0",
  "cc0-1.0",
  "cc-by-4.0",
  "cc-by-sa-4.0",
  "proprietary-licensed",
];

/**
 * Whether a license permits commercial distribution.
 *
 * Unknown licenses return false. Defaulting to "no" means an unrecognised
 * license blocks pricing rather than silently permitting it — the safe
 * direction when the alternative is breaching someone's terms.
 */
export function licensePermitsCommercial(license: string): boolean {
  return COMMERCIAL_LICENSE_IDS.includes(license);
}

/**
 * Copyleft licenses oblige us to offer corresponding source alongside the
 * binary. The obligation exists regardless of price, but it sharpens once money
 * changes hands, so listings for these must surface a source link.
 */
const SOURCE_OFFER_LICENSE_IDS: readonly string[] = [
  "gpl-2.0",
  "gpl-3.0",
  "agpl-3.0",
  "lgpl-2.1",
  "lgpl-3.0",
  "mpl-2.0",
];

export function requiresSourceOffer(license: string): boolean {
  return SOURCE_OFFER_LICENSE_IDS.includes(license);
}
