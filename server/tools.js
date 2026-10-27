'use strict';
const { createState, claimToolState } = require('./state');
const { createAudit } = require('./audit');
const { createGate, bindingHash } = require('./gate');
const defaultClock = require('./clock');
const { calcExercise } = require('./calc');
const taxPolicy = require('../data/tax-policy.json');
const names = ['calc_exercise','get_accounts','get_transactions','analyze_bills','transfer','schedule_transfer','get_products','assess_risk','buy_product','redeem_product','apply_virtual_card','set_card_status','list_subscriptions','cancel_subscription','create_plan','cancel_plan','get_audit_log'];
const money = n => Number.isSafeInteger(n) && n > 0;
const err = code => ({ ok:false, error:{code,message:code} });
function createTools({ state = createState(), clock = defaultClock, audit = createAudit({clock}) } = {}) {
  const d = claimToolState(state), gate = createGate({state,clock,audit}), cache = new Map(); let serial = 0;
  const id = prefix => `${prefix}_${++serial}`;
  const log = (event,tool,p,result,reason) => audit.append({event,tool,paramsDigest:bindingHash(tool,p),result, ...(reason ? {reason} : {})});
  const account = aid => d.accounts.find(a => a.id === aid && a.userId === 'u1');
  const requireItem = x => { if (!x) throw new Error('NOT_FOUND'); return x; };
  function move(p, callId, planId) {
    const from = requireItem(account(p.fromId)); if (from.balanceCents < p.amountCents) throw new Error('INSUFFICIENT_FUNDS');
    from.balanceCents -= p.amountCents;
    const base = { ts:clock.now(), amountCents:p.amountCents, category:'transfer', memo:p.memo || '', toolCallId:callId, ...(planId ? {planId} : {}) };
    d.transactions.push({ ...base,id:id('tx'),accountId:from.id,direction:'out',counterparty:p.toRef });
    const to = account(p.toRef); if (to) { to.balanceCents += p.amountCents; d.transactions.push({...base,id:id('tx'),accountId:to.id,direction:'in',counterparty:from.id}); }
    return {amountCents:p.amountCents};
  }
  function validate(tool,p) {
    if (['transfer','schedule_transfer','buy_product','redeem_product'].includes(tool) && !money(p.amountCents)) throw new Error('INVALID_PARAMS');
    if (['transfer','schedule_transfer'].includes(tool) && (!p.fromId || !p.toRef || p.fromId === p.toRef)) throw new Error('INVALID_PARAMS');
    if (tool === 'schedule_transfer' && !(Date.parse(p.executeAt) > Date.parse(clock.now()))) throw new Error('INVALID_PARAMS');
    if (tool === 'set_card_status' && !(p.status === 'lost' || p.status === 'unlost' || p.status === 'frozen' || p.status === 'active' || p.status === undefined && Number.isSafeInteger(p.limitCents) && p.limitCents >= 0)) throw new Error('INVALID_PARAMS');
    if (tool === 'assess_risk' && (!Array.isArray(p.answers) || !p.answers.length || !p.answers.every(n => Number.isInteger(n) && n >= 0 && n <= 4))) throw new Error('INVALID_PARAMS');
    if (tool === 'create_plan' && (!money(p.monthlyLockCents) || !account(p.destAccountId) || !(Date.parse(p.targetDate)>Date.parse(clock.now())) || !Array.isArray(p.redeemSchedule) || p.redeemSchedule.some(r=> !money(r.amountCents) || !d.holdings.some(h=>h.id===r.holdingId) || !(Date.parse(r.executeAt)>Date.parse(clock.now())) || Date.parse(r.executeAt)>Date.parse(p.targetDate)))) throw new Error('INVALID_PARAMS');
  }
  function execute(tool,p,grant,callId) {
    switch(tool) {
      case 'calc_exercise': { const result = calcExercise(p, taxPolicy); result.fundingProposal = { monthlyLockCents:800000, redeemSchedule:[{holdingId:'holding_money_market',amountCents:4500000,executeAt:new Date(Date.parse(clock.now())+86400000).toISOString()},{holdingId:'holding_money_market',amountCents:4500000,executeAt:new Date(Date.parse(clock.now())+32*86400000).toISOString()}],targetDate: new Date(Date.UTC(new Date(clock.now()).getUTCFullYear()+1,2,31,8)).toISOString(),destAccountId:'acc_exercise' }; log('calc_run',tool,p,'ok'); return result; }
      case 'get_accounts': return d.accounts;
      case 'get_transactions': return d.transactions.filter(t => (!p.accountId || t.accountId === p.accountId) && (!p.month || t.ts.startsWith(p.month)));
      case 'get_products': return d.products;
      case 'list_subscriptions': return d.subscriptions.map(s=>({...s,recognizedFromTransactions:d.transactions.some(t=>t.category==='subscription' && t.counterparty===s.name)}));
      case 'get_audit_log': return audit.list(p.sinceSeq);
      case 'analyze_bills': { const tx = d.transactions.filter(t=>t.direction==='out' && t.ts.startsWith(p.month)); const categories = {}; for (const t of tx) categories[t.category]=(categories[t.category]||0)+t.amountCents; const anomalies=tx.filter(t=> {const peers=d.transactions.filter(x=>x.direction==='out'&&x.category===t.category&&x.id!==t.id); const months=new Set(peers.map(x=>x.ts.slice(0,7))).size; const average=peers.reduce((n,x)=>n+x.amountCents,0)/(months||1); return t.amountCents>=average*3 || t.amountCents>=100000 && !d.transactions.some(x=>x.id!==t.id&&x.counterparty===t.counterparty); }); return {month:p.month,categories,totalOutCents:tx.reduce((n,t)=>n+t.amountCents,0),anomalies}; }
      case 'assess_risk': {const score=p.answers.reduce((a,b)=>a+b,0); return d.riskAssessment={score,riskLevel:score<=p.answers.length?'R1':score<=p.answers.length*2.5?'R2':'R3'};}
      case 'transfer': return move(p,callId);
      case 'schedule_transfer': { const step={id:id('step'),tool:'transfer',params:{fromId:p.fromId,toRef:p.toRef,amountCents:p.amountCents,...(p.memo===undefined?{}:{memo:p.memo})},executeAt:p.executeAt,status:'pending',authId:grant.id,authorization:{level:grant.level}}; d.steps.push(step); return step; }
      case 'buy_product': { const product=requireItem(d.products.find(x=>x.id===p.productId)); if(p.amountCents<product.minAmountCents) throw new Error('INVALID_PARAMS'); const a=requireItem(account(p.fromId)); if(a.balanceCents<p.amountCents) throw new Error('INSUFFICIENT_FUNDS'); a.balanceCents-=p.amountCents; let h=d.holdings.find(h=>h.productId===p.productId); if(!h) {h={id:id('holding'),userId:'u1',productId:p.productId,sharesCents:0};d.holdings.push(h);} h.sharesCents+=p.amountCents; d.transactions.push({id:id('tx'),accountId:a.id,ts:clock.now(),direction:'out',amountCents:p.amountCents,category:'investment',counterparty:product.name,memo:'申购',toolCallId:callId});return h; }
      case 'redeem_product': {const h=requireItem(d.holdings.find(h=>h.id===p.holdingId));const a=requireItem(account(p.toId));if(h.sharesCents<p.amountCents) throw new Error('INSUFFICIENT_FUNDS');h.sharesCents-=p.amountCents;a.balanceCents+=p.amountCents;d.transactions.push({id:id('tx'),accountId:a.id,ts:clock.now(),direction:'in',amountCents:p.amountCents,category:'redemption',counterparty:h.productId,memo:'赎回',toolCallId:callId});return h;}
      case 'apply_virtual_card': {const c={id:id('card'),userId:'u1',kind:'virtual',status:'active',limitCents:100000};d.cards.push(c);return c;}
      case 'set_card_status': {const c=requireItem(d.cards.find(c=>c.id===p.cardId));if(p.status!==undefined)c.status=p.status==='unlost'?'active':p.status;else c.limitCents=p.limitCents;return c;}
      case 'cancel_subscription': {const s=requireItem(d.subscriptions.find(s=>s.id===p.subscriptionId));s.status='cancelled';return s;}
      case 'create_plan': {const plan={id:id('plan'),userId:'u1',type:'exercise_saving',status:'active',monthlyLockCents:p.monthlyLockCents,redeemSchedule:structuredClone(p.redeemSchedule),targetDate:p.targetDate,destAccountId:p.destAccountId,createdWithAuthId:grant.id};d.plans.push(plan);const add=(tool,params,executeAt)=>d.steps.push({id:id('step'),planId:plan.id,tool,params,executeAt,status:'pending',authId:grant.id,authorization:{level:grant.level}});for(const r of p.redeemSchedule)add('redeem_product',{holdingId:r.holdingId,amountCents:r.amountCents,toId:'acc_demand'},r.executeAt);let at=new Date(clock.now());at.setUTCMonth(at.getUTCMonth()+1);while(at.getTime()<Date.parse(p.targetDate)){add('transfer',{fromId:'acc_demand',toRef:'acc_exercise',amountCents:p.monthlyLockCents},at.toISOString());at.setUTCMonth(at.getUTCMonth()+1);}add('plan_finalize',{},p.targetDate);return plan;}
      case 'cancel_plan': {const plan=requireItem(d.plans.find(x=>x.id===p.planId));plan.status='cancelled';for(const s of d.steps.filter(s=>s.planId===plan.id&&s.status!=='done')) { s.status='cancelled'; log('plan_step_blocked',s.tool,s.params,'blocked','PLAN_CANCELLED'); d.notifications.push({stepId:s.id,reason:'PLAN_CANCELLED',ts:clock.now()}); } return plan;}
      default: throw new Error('NOT_FOUND');
    }
  }
  function call(tool, input = {}, ctx = {}) {
    const {idempotencyKey, ...p}=input; const key=typeof idempotencyKey==='string'&&idempotencyKey ? `${ctx.userId||'u1'}:${idempotencyKey}`:null;
    if(key&&cache.has(key)) {const result=structuredClone(cache.get(key));result.replay='IDEMPOTENT_REPLAY';log('tool_call',tool,p,'IDEMPOTENT_REPLAY');return result;}
    let result;
    try { if(!key || !names.includes(tool))throw new Error('INVALID_PARAMS');validate(tool,p);let decision=gate.check(tool,p,ctx);if(decision.decision==='deny')throw new Error(decision.reason);
      let grant;
      if(decision.level!=='green') {
        grant=d.authGrants.find(g=>g.id===ctx.authId);
        if(!grant) {result={...err(decision.level==='yellow'?'NEED_CONFIRM':'NEED_VERIFY'),data:{tool,params:structuredClone(p),paramsDigest:bindingHash(tool,p)}};}
        else {if(grant.used||gate.isRevoked(grant.id))throw new Error('GATE_DENY');if(Date.parse(clock.now())>=Date.parse(grant.expiresAt))throw new Error('AUTH_EXPIRED');if(grant.bindingHash!==bindingHash(tool,p,ctx.userId||'u1'))throw new Error('AUTH_BINDING_MISMATCH');if(decision.level==='red'&&grant.level!=='red')throw new Error('NEED_VERIFY');decision=gate.check(tool,p,{...ctx,authorized:true});if(decision.decision!=='allow')throw new Error(decision.reason);grant.used=true;}
      }
      if(!result)result={ok:true,data:structuredClone(execute(tool,p,grant,id('call')))};
    } catch(e) {result=err(e.message);}
    log('tool_call',tool,p,result.ok?'ok':'error',result.error?.code);
    if(key)cache.set(key,structuredClone(result));return result;
  }
  function authorize(tool,input={}, proof={},ctx={}) {
    const {idempotencyKey,...p}=input;
    try {validate(tool,p);const check=gate.check(tool,p,ctx);if(check.decision==='deny')return err(check.reason);if(check.level==='green')return err('INVALID_PARAMS');if(check.level==='yellow'?proof.confirmed!==true:proof.code!=='246810'&&proof.faceConfirmed!==true){gate.recordAuthFailure();return err('GATE_DENY');}gate.authSucceeded();const grant={id:id('auth'),userId:ctx.userId||'u1',level:check.level,bindingHash:bindingHash(tool,p,ctx.userId||'u1'),expiresAt:new Date(Date.parse(clock.now())+300000).toISOString(),used:false};d.authGrants.push(grant);log('auth_granted',tool,p,'ok');return {ok:true,data:structuredClone(grant)};}catch(e){return err(e.message);}
  }
  function runDueSteps() {
    const results=[];
    for(const s of d.steps.filter(s=>s.status==='pending'&&Date.parse(s.executeAt)<=Date.parse(clock.now())).sort((a,b)=>Date.parse(a.executeAt)-Date.parse(b.executeAt))) {
      let tool=s.tool,p=s.params; if(tool==='plan_finalize'){const plan=d.plans.find(x=>x.id===s.planId);tool='transfer';p={fromId:'acc_exercise',toRef:plan.destAccountId,amountCents:account('acc_exercise').balanceCents};}
      const check=gate.check(tool,p,{execution:true,authId:s.authId,authorization:s.authorization,planId:s.planId});
      try {if(check.decision!=='allow')throw new Error(check.reason);if(tool==='transfer'&&p.amountCents===0){}else execute(tool,p,null,id('scheduled'));s.status='done';log('plan_step_executed',tool,p,'ok');if(s.tool==='plan_finalize')d.plans.find(x=>x.id===s.planId).status='done';}
      catch(e){s.status='paused';d.notifications.push({stepId:s.id,reason:e.message,ts:clock.now()});log('plan_step_blocked',tool,p,'blocked',e.message);}results.push(structuredClone(s));
    }
    for(const sub of d.subscriptions.filter(s=>s.status==='active'))while(Date.parse(sub.nextChargeAt)<=Date.parse(clock.now())){const a=account('acc_demand');if(a.balanceCents<sub.amountCents)break;a.balanceCents-=sub.amountCents;d.transactions.push({id:id('tx'),accountId:a.id,ts:clock.now(),direction:'out',amountCents:sub.amountCents,category:'subscription',counterparty:sub.name,memo:'周期扣费',toolCallId:id('subscription')});const date=new Date(sub.nextChargeAt);date.setUTCMonth(date.getUTCMonth()+1);sub.nextChargeAt=date.toISOString();log('tool_call','subscription_charge',{subscriptionId:sub.id},'ok');}
    return {ok:true,data:results};
  }
  // Simulation ingress for physical/virtual card purchases, governed by card state.
  function cardTransaction({cardId,amountCents,counterparty,idempotencyKey}) {return auxiliary('card_transaction',idempotencyKey,()=>{if(!money(amountCents))throw new Error('INVALID_PARAMS');const c=requireItem(d.cards.find(c=>c.id===cardId));if(c.status!=='active'||amountCents>c.limitCents)throw new Error('GATE_DENY');const check=gate.check('transfer',{fromId:'acc_demand',toRef:'contact_family',amountCents},{authorized:true});if(check.decision!=='allow')throw new Error(check.reason);const a=account('acc_demand');a.balanceCents-=amountCents;const t={id:id('tx'),accountId:a.id,ts:clock.now(),direction:'out',amountCents,category:'card',counterparty,memo:'卡消费',toolCallId:id('card_call')};d.transactions.push(t);return t;});}
  function auxiliary(tool,key,fn){if(typeof key!=='string'||!key)return err('INVALID_PARAMS');if(cache.has(`u1:${key}`))return {...structuredClone(cache.get(`u1:${key}`)),replay:'IDEMPOTENT_REPLAY'};let r;try{r={ok:true,data:structuredClone(fn())};}catch(e){r=err(e.message);}cache.set(`u1:${key}`,structuredClone(r));log('tool_call',tool,{},r.ok?'ok':'error',r.error?.code);return r;}
  return Object.freeze({call,authorize,runDueSteps,cardTransaction,state,gate,audit,...Object.fromEntries(names.map(name=>[name,(p,ctx)=>call(name,p,ctx)]))});
}
module.exports={createTools};
