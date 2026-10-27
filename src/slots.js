// Task 4.6: pickup slots. Pure function. Outlets run on Asia/Kolkata (UTC+05:30, no daylight saving).
// Rules (contract 3.2): inside outlet hours, not before now + minPrepMinutes, on a fixed step, max 8 shown, none when closed.
// Same-day only. Half-hour windows (owner, 27 Oct): step 30 min, last window ends at closing, prep 30 min (rounded up to the next window).
// Each slot: { id (start, the contract v1.1 slotId), endsAt (end of the window), label }. slotMinutes stays configurable per outlet.
const IST_MIN = 330;

function hm(s) {
  const [h, m] = String(s).split(':').map(Number);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) throw new RangeError('bad time ' + s);
  return h * 60 + m;
}
function label(t) {
  const h = Math.floor(t / 60), m = t % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'pm' : 'am'}`;
}

export function makeSlots({ now = new Date(), open = '11:00', close = '23:30', minPrepMinutes = 30, slotMinutes = 30, lastSlotBufferMinutes = slotMinutes, max = 48 } = {}) {
  const ist = new Date(now.getTime() + IST_MIN * 60000);
  const dayStartUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - IST_MIN * 60000;
  const nowMin = ist.getUTCHours() * 60 + ist.getUTCMinutes() + ist.getUTCSeconds() / 60;
  const openMin = hm(open), lastMin = hm(close) - lastSlotBufferMinutes;
  let t = Math.max(openMin, Math.ceil((nowMin + minPrepMinutes) / slotMinutes) * slotMinutes);
  const slots = [];
  for (; t <= lastMin && slots.length < max; t += slotMinutes) {
    slots.push({ id: new Date(dayStartUtc + t * 60000).toISOString(), endsAt: new Date(dayStartUtc + (t + slotMinutes) * 60000).toISOString(), label: label(t) });
  }
  return { slots, outletClosed: slots.length === 0 };
}

// Server re-check at checkout/start: the slot id must be one of today's valid slots.
export function validateSlot(slotId, opts = {}) {
  return makeSlots({ ...opts, max: 500 }).slots.some((s) => s.id === slotId);
}
