// REFERENCE ONLY. Not wired into the HTML. Shows how the Pickup page will call the API.
// Put your Worker address here after deploy (SETUP.md step 6).
const API = 'https://rr-durbar-api.YOURNAME.workers.dev';

// 1) Outlet cards: status + lat/lng
async function loadOutlets() {
  const r = await fetch(`${API}/api/outlets`);
  const { outlets } = await r.json();
  // outlet.hours = { open, close, slots:[{open,close}], source } for TODAY. Show all slots if there are two.
  // outlet.address, outlet.lat, outlet.lng come from Rista.
  // outlet.status: "open" | "closed" | "call" | "unknown"
  //   open    -> show "Open", enable "View menu"
  //   closed  -> show "Closed"
  //   call    -> this outlet has no pickup channel in Rista yet: show "Call to order" (phone is in outlet.phone)
  //   unknown -> Rista not reachable: show "Call to order" (safe default)
  return outlets;
}

// 2) Distance (only after the customer taps "Nearest"): haversine in km
function km(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// 3) Menu for the outlet the customer chose
async function loadMenu(code) {
  const r = await fetch(`${API}/api/menu?branch=${encodeURIComponent(code)}`);
  if (!r.ok) throw new Error('menu unavailable');
  return r.json();
  // { categories:[{ name, image, items:[{ id, name, key, description, subCategory, veg, image, spice, serves, prepMins,
  //                                        variants:[{ id, label, soldOut }], soldOut }] }], soldOutKnown, soldOutSource, stale }
  // Categories come already sorted by Rista display order.
  // variants: Half / Full etc. soldOut on a dish is true only if ALL its variants are sold out. Show each variant's own mark.
  // PHOTO RULE for each dish card:
  //   1) your own client photo, matched by item.key  (always first)
  //   2) item.image when item.imageSource === 'rista'  (real dish photo from Rista)
  //   3) item.image when item.imageSource === 'category'  (same photo for the whole category: use small, or skip)
  //   4) a plain placeholder when item.imageSource === 'none'
  // Small client images: show as card thumbnails only, do not stretch.
  // Also in the reply: photosKnown (false = Rista photo call failed), photoCount.
  // item.veg is true / false / null (null = Rista has no veg tag for it).
  // NEVER write innerHTML with item.name / item.description. Use textContent.
}
