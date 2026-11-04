// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { chargeToRow, countRow, dollarsToCents } = require('../lib/classify');

const SLUG = 'powder-to-the-people-north-bend-ski-movie-night-fundraiser';
const cfg = { campaignSlug: SLUG };
const settings = { eventStartMs: Date.parse('2026-11-12T12:00:00-08:00') };
const BEFORE = Date.parse('2026-11-04T10:00:00-08:00') / 1000;
const DURING = Date.parse('2026-11-12T19:30:00-08:00') / 1000;

const charge = (o) => ({ id: 'ch_x', status: 'succeeded', paid: true, captured: true, currency: 'usd', amount_refunded: 0, metadata: {}, payment_method_details: { type: 'card' }, ...o });

test('dollarsToCents', () => {
  assert.equal(dollarsToCents('$20.60'), 2060);
  assert.equal(dollarsToCents('$1,234.50'), 123450);
  assert.equal(dollarsToCents('-15'), -1500);
  assert.equal(dollarsToCents(''), null);
});

test('Give Lively campaign gift counts Y.E.T.I. share only, any date', () => {
  const row = chargeToRow(charge({ amount: 2240, created: BEFORE, metadata: { gl_charge_id: 'g', campaign_slug: SLUG, gross_amount_to_nonprofit: '$20.60', gross_tip_to_give_lively: '$1.80' } }), cfg);
  assert.deepEqual(countRow(row, settings), { cents: 2060, reason: 'Give Lively campaign' });
});

test('Give Lively gift to another campaign or general giving is not counted', () => {
  const row = chargeToRow(charge({ amount: 14000, created: DURING, metadata: { gl_charge_id: 'g', page_type: 'Nonprofit', gross_amount_to_nonprofit: '$140.00' } }), cfg);
  assert.equal(countRow(row, settings).cents, 0);
});

test('Card reader payment counts only after event start', () => {
  const before = chargeToRow(charge({ amount: 100, created: BEFORE, payment_method_details: { type: 'card_present' } }), cfg);
  const during = chargeToRow(charge({ amount: 5000, created: DURING, payment_method_details: { type: 'card_present' } }), cfg);
  assert.equal(countRow(before, settings).cents, 0);
  assert.equal(countRow(during, settings).cents, 5000);
});

test('Refunds and failed charges', () => {
  const partial = chargeToRow(charge({ amount: 5000, amount_refunded: 2000, created: DURING }), cfg);
  assert.equal(countRow(partial, settings).cents, 3000);
  const full = chargeToRow(charge({ amount: 2240, amount_refunded: 2240, created: BEFORE, metadata: { gl_charge_id: 'g', campaign_slug: SLUG, gross_amount_to_nonprofit: '$20.60', gross_tip_to_give_lively: '$1.80' } }), cfg);
  assert.equal(countRow(full, settings).cents, 0);
  const failed = chargeToRow(charge({ amount: 5000, created: DURING, status: 'failed', paid: false }), cfg);
  assert.equal(countRow(failed, settings).cents, 0);
});

test('Stored row holds no personal fields', () => {
  const row = chargeToRow(charge({ amount: 2000, created: DURING, receipt_email: 'a@b.c', billing_details: { name: 'X' }, description: 'Raffle', metadata: { gl_charge_id: 'g', campaign_slug: SLUG, user_email: 'a@b.c', user_first_name: 'A' } }), cfg);
  assert.deepEqual(Object.keys(row).sort(), ['base_cents', 'charge_cents', 'created', 'id', 'in_campaign', 'method', 'ok', 'refunded_cents', 'source', 'tip_cents']);
  assert.ok(!JSON.stringify(row).includes('a@b.c'));
});
