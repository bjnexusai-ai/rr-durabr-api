import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSlots, validateSlot } from '../src/slots.js';

const at = (iso) => new Date(iso);
test('10:50 IST with 30 min prep: first window 11:30 to 12:00 on the half-hour grid, then every window to closing', () => {
  const r = makeSlots({ now: at('2026-10-24T05:20:00Z') });
  assert.equal(r.slots[0].label, '11:30 am');
  assert.equal(r.slots[0].id, '2026-10-24T06:00:00.000Z');
  assert.equal(r.slots[0].endsAt, '2026-10-24T06:30:00.000Z');
  assert.equal(r.slots.length, 24);   // 11:30 am ... 11:00 pm
  assert.equal(r.slots[1].label, '12:00 pm');
  assert.equal(r.outletClosed, false);
});
test('before opening: first slot is opening time', () => {
  const r = makeSlots({ now: at('2026-10-24T02:00:00Z') }); // 07:30 IST
  assert.equal(r.slots[0].label, '11:00 am');
  assert.equal(r.slots[0].id, '2026-10-24T05:30:00.000Z');
});
test('exactly 11:00 IST - 30 min = first slot 11:00 (not before now + prep)', () => {
  const r = makeSlots({ now: at('2026-10-24T05:00:00Z') }); // 10:30 IST
  assert.equal(r.slots[0].label, '11:00 am');
});
test('late evening: closed, no slots', () => {
  const r = makeSlots({ now: at('2026-10-24T17:55:00Z') }); // 23:25 IST
  assert.deepEqual(r, { slots: [], outletClosed: true });
});
test('last window ends at closing: 11:00 to 11:30 pm', () => {
  const r = makeSlots({ now: at('2026-10-24T15:00:00Z'), max: 50 }); // 20:30 IST
  assert.equal(r.slots.at(-1).label, '11:00 pm');
  assert.equal(r.slots.at(-1).endsAt, '2026-10-24T18:00:00.000Z');   // 23:30 IST
});
test('IST date can differ from UTC date: 00:30 IST on the 25th gives slots on the 25th', () => {
  const r = makeSlots({ now: at('2026-10-24T19:00:00Z') });
  assert.equal(r.slots[0].id, '2026-10-25T05:30:00.000Z');
});
test('prep time rounds UP to the next half hour: 13:41 IST + 30 = 14:11 -> first window 2:30 pm', () => {
  const r = makeSlots({ now: at('2026-10-24T08:11:00Z'), max: 20 }); // 13:41 IST
  assert.equal(r.slots[0].label, '2:30 pm');
  assert.ok(!r.slots.some((s) => s.label === '2:15 pm' || s.label === '2:45 pm'));
});
test('validateSlot accepts a real slot, rejects invented ones', () => {
  const now = at('2026-10-24T05:20:00Z');
  assert.equal(validateSlot('2026-10-24T06:00:00.000Z', { now }), true);
  assert.equal(validateSlot('2026-10-24T05:00:00.000Z', { now }), false); // too soon
  assert.equal(validateSlot('2026-10-24T06:07:00.000Z', { now }), false); // off grid
  assert.equal(validateSlot('nonsense', { now }), false);
});
test('still configurable: slotMinutes 15 gives 15-minute windows (owner can go back)', () => {
  const r = makeSlots({ now: at('2026-10-24T05:20:00Z'), slotMinutes: 15 });
  assert.equal(r.slots[1].label, '11:45 am');
  assert.equal((Date.parse(r.slots[0].endsAt) - Date.parse(r.slots[0].id)) / 60000, 15);
  assert.equal(r.slots.at(-1).label, '11:15 pm');   // last 15-minute window ends at 23:30
});

