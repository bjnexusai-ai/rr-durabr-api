// Outlets shown on the website. Edit this file to add or remove an outlet.
// NOT listed on purpose: HO (admin entry, not an outlet) and PA (Patamata closes end of Oct 2026).
export const OUTLETS = [
  { code: 'MR', slug: 'moghalrajpuram', name: 'Moghalrajpuram', tag: 'Head office' },
  { code: 'SN', slug: 'singhnagar',     name: 'Singhnagar' },
  { code: 'BH', slug: 'bhavanipuram',   name: 'Bhavanipuram' },
  { code: 'PO', slug: 'poranki',        name: 'Poranki' },
  { code: 'PL', slug: 'patamatalanka',  name: 'Patamatalanka' },
  { code: 'AT', slug: 'autonagar',      name: 'Autonagar' },
];

// If Rista has no lat/lng for an outlet, add  lat: 16.xxxx, lng: 80.xxxx  to its line above.

// Used ONLY if Rista gives no business hours. Source: old onboarding kit. Autonagar was blank there.
export const FALLBACK_HOURS = {
  MR: ['11:00', '23:30'], SN: ['11:00', '23:30'], BH: ['11:00', '23:30'],
  PO: ['11:00', '23:30'], PL: ['11:00', '23:30'], AT: null,
};

export const PHONE = '7702077999'; // from old onboarding kit

export const RISTA_BASE = 'https://api.ristaapps.com/v1';

// How long each answer is kept (seconds). Rista does not push changes, so we ask and keep.
export const TTL = {
  status: 45,     // outlet on/off
  soldout: 45,    // sold-out items
  menu: 180,      // dish list
  branches: 600,  // outlet list, lat/lng, hours
  photos: 1800,   // dish photos (big whole-business reply, so kept 30 min)
};
export const STALE_OK = 900; // if Rista is down, serve the last good answer up to 15 min old
export const STALE_PHOTOS = 21600; // photo list: last good answer is fine for 6 hours
export const PHOTO_RETRY = 120;    // after a failed photo call, wait 2 min before trying again
