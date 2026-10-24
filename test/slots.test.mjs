import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSlots, validateSlot } from '../src/slots.js';

const at = (iso) => new Date(iso);
test('10:50 IST with 30 min prep: first slot 11:30 on the 15 min grid', () => {
  const r = makeSlots({ now: at('2026-10-24T05:20:00Z') });
  assert.equal(r.slots[0].label, '11:30 am');
  assert.equal(r.slots[0].id, '2026-10-24T06:00:00.000Z');
  assert.equal(r.slots.length, 8);
  assert.equal(r.slots[1].label, '11:45 am');
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
test('last slot is closing time minus 15 min', () => {
  const r = makeSlots({ now: at('2026-10-24T15:00:00Z'), max: 50 }); // 20:30 IST
  assert.equal(r.slots.at(-1).label, '11:15 pm');
});
test('IST date can differ from UTC date: 00:30 IST on the 25th gives slots on the 25th', () => {
  const r = makeSlots({ now: at('2026-10-24T19:00:00Z') });
  assert.equal(r.slots[0].id, '2026-10-25T05:30:00.000Z');
});
test('afternoon label 1:45 pm', () => {
  const r = makeSlots({ now: at('2026-10-24T08:00:00Z'), max: 20 }); // 13:30 IST, +30 = 14:00
  assert.equal(r.slots[0].label, '2:00 pm');
  assert.ok(r.slots.some((s) => s.label === '2:15 pm'));
});
test('validateSlot accepts a real slot, rejects invented ones', () => {
  const now = at('2026-10-24T05:20:00Z');
  assert.equal(validateSlot('2026-10-24T06:00:00.000Z', { now }), true);
  assert.equal(validateSlot('2026-10-24T05:00:00.000Z', { now }), false); // too soon
  assert.equal(validateSlot('2026-10-24T06:07:00.000Z', { now }), false); // off grid
  assert.equal(validateSlot('nonsense', { now }), false);
});
