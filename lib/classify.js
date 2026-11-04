// Turns a Stripe charge into the few fields the thermometer needs.
// Nothing personal is kept: no names, emails, addresses, card details or descriptions.

function dollarsToCents(value) {
  if (value == null || value === '') return null;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Returns the row stored in the `charges` table.
function chargeToRow(ch, cfg) {
  const md = ch.metadata || {};
  const isGiveLively = Boolean(md.gl_charge_id);
  const tip = isGiveLively ? dollarsToCents(md.gross_tip_to_give_lively) || 0 : 0;
  const toNonprofit = isGiveLively ? dollarsToCents(md.gross_amount_to_nonprofit) : null;

  return {
    id: ch.id,
    created: ch.created,
    source: isGiveLively ? 'givelively' : 'stripe',
    in_campaign: isGiveLively && md.campaign_slug === cfg.campaignSlug ? 1 : 0,
    ok: ch.status === 'succeeded' && ch.paid !== false && ch.captured !== false && ch.currency === 'usd' ? 1 : 0,
    method: (ch.payment_method_details && ch.payment_method_details.type) || null,
    charge_cents: ch.amount,
    tip_cents: tip,
    // Y.E.T.I.'s share: for Give Lively, the amount minus Give Lively's optional tip.
    base_cents: toNonprofit != null ? toNonprofit : ch.amount - tip,
    refunded_cents: ch.amount_refunded || 0,
  };
}

// How much of a stored charge goes on the thermometer, and why.
function countRow(row, settings) {
  if (!row.ok) return { cents: 0, reason: 'Not a successful USD payment' };
  if (row.source === 'givelively') {
    if (!row.in_campaign) return { cents: 0, reason: 'Give Lively, other campaign' };
  } else if (row.created * 1000 < settings.eventStartMs) {
    return { cents: 0, reason: 'Before event start' };
  }
  const cents = Math.max(0, row.base_cents - row.refunded_cents);
  const label = row.source === 'givelively' ? 'Give Lively campaign' : 'Stripe after event start';
  if (row.refunded_cents > 0) return { cents, reason: cents ? `${label}, partly refunded` : 'Refunded' };
  return { cents, reason: label };
}

module.exports = { dollarsToCents, chargeToRow, countRow };
