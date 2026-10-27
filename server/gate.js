'use strict';
const { sha } = require('./audit');
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])])) : value;
const bindingHash = (tool, params, userId = 'u1') => sha(tool + JSON.stringify(normalize(params)) + userId);
function createGate({ state, clock, audit }) {
  let failures = 0, injections = 0, lockedUntil = 0;
  const revoked = new Set();
  function event(event, fields = {}) { audit.append({ event, paramsDigest: '', result: 'ok', ...fields }); }
  function level(tool, p) {
    if (['transfer','schedule_transfer'].includes(tool)) { const total = state.snapshot().transactions.filter(t => t.direction === 'out' && t.ts.slice(0,10) === clock.now().slice(0,10)).reduce((n,t) => n+t.amountCents,0); return total + p.amountCents <= 100000 ? 'yellow' : 'red'; }
    if (['buy_product','redeem_product','create_plan'].includes(tool) || tool === 'set_card_status' && p.status !== undefined) return 'red';
    if (['cancel_subscription','apply_virtual_card','cancel_plan','set_card_status'].includes(tool)) return 'yellow';
    return 'green';
  }
  function check(tool, params, ctx = {}) {
    const l = level(tool, params), s = state.snapshot(); let decision;
    if (lockedUntil && Date.parse(clock.now()) >= lockedUntil) { lockedUntil = 0; failures = 0; injections = 0; event('breaker_off'); }
    const deny = reason => ({ decision:'deny', level:l, reason });
    if (ctx.userId && ctx.userId !== 'u1') decision = deny('GATE_DENY');
    else if (l !== 'green' && lockedUntil) decision = deny('BREAKER_LOCKED');
    else if (ctx.execution && (revoked.has(ctx.authId) || !ctx.authorization || (l === 'red' && ctx.authorization.level !== 'red'))) decision = deny('GATE_DENY');
    else if (ctx.planId && s.plans.find(p => p.id === ctx.planId)?.status !== 'active') decision = deny('GATE_DENY');
    else if (['transfer','schedule_transfer','buy_product'].includes(tool)) {
      const a = s.accounts.find(a => a.id === params.fromId && a.userId === 'u1');
      if (!a) decision = deny('NOT_FOUND');
      else if (a.balanceCents < params.amountCents) decision = deny('INSUFFICIENT_FUNDS');
      else if (tool !== 'buy_product' && ![...s.accounts,...s.contacts].some(a => a.id === params.toRef)) decision = deny('NOT_FOUND');
    }
    if (!decision && tool === 'redeem_product') { const h = s.holdings.find(h => h.id === params.holdingId && h.userId === 'u1'); if (!h || !s.accounts.some(a => a.id === params.toId && a.userId === 'u1')) decision = deny('NOT_FOUND'); else if (h.sharesCents < params.amountCents) decision = deny('INSUFFICIENT_FUNDS'); }
    if (!decision) decision = { decision: ctx.authorized || ctx.execution || l === 'green' ? 'allow' : l === 'yellow' ? 'need_confirm' : 'need_verify', level:l };
    event('gate_decision', { tool, paramsDigest:bindingHash(tool,params), result:decision.decision, reason:decision.reason }); return decision;
  }
  function fail(injection = false) { event(injection ? 'injection_blocked' : 'auth_failed'); if (injection) injections++; else failures++; if ((injection ? injections : failures) >= 3 && !lockedUntil) { lockedUntil = Date.parse(clock.now()) + 1800000; event('breaker_on'); } }
  return Object.freeze({ check, level, bindingHash, recordAuthFailure: () => fail(), recordInjection: () => fail(true), authSucceeded() { failures = 0; }, revoke(id) { revoked.add(id); }, isRevoked: id => revoked.has(id) });
}
module.exports = { createGate, bindingHash };
