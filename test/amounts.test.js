import { test } from 'node:test';
import assert from 'node:assert/strict';
import { equalShareCents, majorityAmount, resolveAmounts, progress } from '../src/domain/amounts.js';

const p = (id, mode, extra = {}) => ({ id, mode, fixedCents: null, capCents: null, ...extra });

test('equal share is ceil(goal / participants) and updates as people join', () => {
  assert.equal(equalShareCents(100000, 0), 100000);
  assert.equal(equalShareCents(100000, 3), 33334);
  assert.equal(equalShareCents(100000, 4), 25000);
  const two = resolveAmounts(100000, [p('a', 'equal'), p('b', 'equal')]);
  assert.equal(two.byParticipant.get('a').resolvedCents, 50000);
  const four = resolveAmounts(100000, [p('a', 'equal'), p('b', 'equal'), p('c', 'equal'), p('d', 'equal')]);
  assert.equal(four.byParticipant.get('a').resolvedCents, 25000);
});

test('majority amount is the mode of public amounts; ties go to the higher amount', () => {
  assert.equal(majorityAmount([200, 200, 500], 999), 200);
  assert.equal(majorityAmount([200, 500], 999), 500);
  assert.equal(majorityAmount([], 999), 999);
});

test('majority-cap participant pays min(majority, cap) and the cap stays private', () => {
  const participants = [p('a', 'fixed', { fixedCents: 30000 }), p('b', 'fixed', { fixedCents: 30000 }), p('c', 'fixed', { fixedCents: 50000 }), p('d', 'majority_cap', { capCents: 20000 }), p('e', 'majority_cap', { capCents: 90000 })];
  const r = resolveAmounts(100000, participants);
  assert.equal(r.majority, 30000);
  assert.equal(r.byParticipant.get('d').resolvedCents, 20000);
  assert.equal(r.byParticipant.get('e').resolvedCents, 30000);
  assert.equal(r.byParticipant.get('d').publicCents, null);
  assert.equal(r.byParticipant.get('e').publicCents, null);
});

test('running total counts majority-cap pledges at their provisional value', () => {
  const r = resolveAmounts(100000, [p('a', 'equal'), p('b', 'equal'), p('c', 'majority_cap', { capCents: 10000 })]);
  // share = ceil(100000/3) = 33334; majority among [33334, 33334] = 33334; c pays min(33334, 10000)
  assert.equal(r.totalCents, 33334 + 33334 + 10000);
  assert.deepEqual(progress(100000, r.totalCents), { remainingCents: 100000 - 76668, percent: 76, reached: false });
});

test('equal shares count in the majority and fall back when everyone is majority-cap', () => {
  const mixed = resolveAmounts(90000, [p('a', 'equal'), p('b', 'equal'), p('c', 'fixed', { fixedCents: 10000 }), p('d', 'majority_cap', { capCents: 100000 })]);
  assert.equal(mixed.share, 22500);
  assert.equal(mixed.byParticipant.get('d').resolvedCents, 22500);
  const allCap = resolveAmounts(90000, [p('a', 'majority_cap', { capCents: 100000 }), p('b', 'majority_cap', { capCents: 1000 })]);
  assert.equal(allCap.byParticipant.get('a').resolvedCents, 45000);
  assert.equal(allCap.byParticipant.get('b').resolvedCents, 1000);
});
