'use strict';
const {randomUUID}=require('node:crypto');
const {screen}=require('./guard');
const {createLLM}=require('./llm');
const NUM='[0-9零〇一二两三四五六七八九十百千万点.]+';
function number(text) {
  if(/^\d+(\.\d+)?$/.test(text))return Number(text);
  const digits='零一二三四五六七八九'; let total=0,section=0,n=0;
  const [whole,decimal]=text.replaceAll('两','二').replaceAll('〇','零').split('点');
  for(const c of whole){if(digits.includes(c))n=digits.indexOf(c);else{const unit={十:10,百:100,千:1000,万:10000}[c];if(!unit)return NaN;if(unit===10000){total+=(section+n)*unit;section=0;n=0;}else{section+=(n||1)*unit;n=0;}}}
  return total+section+n+(decimal?Number('0.'+[...decimal].map(c=>digits.indexOf(c)).join('')):0);
}
const extract=(text,pattern)=>{const m=text.match(new RegExp(pattern));return m?number(m[1]):undefined;};
const cents=n=>Math.round(n*100);
// Formatting only: no derived financial values are calculated by the Agent.
const yuan=n=>`${(n/100).toFixed(2).replace(/\.00$/,'')}元`;
function parseIntent(m) {
  if(/改成|改为|金额改|收款人改/.test(m))return {intent:'modify'};
  if(/先停|暂停|转人工|手动模式/.test(m))return {intent:'stop'};
  if(/取消.*计划/.test(m))return {intent:'cancel_plan'};
  if(/每月|备资|资金计划|锁定|发薪.*锁/.test(m))return {intent:'plan',monthly:extract(m,`(?:锁定?|每月)\\s*(${NUM})`)};
  if(/期权|行权价|测算|分两年/.test(m))return {intent:'calc',shares:extract(m,`(${NUM})\\s*股`),exercise:extract(m,`行权价\\s*(${NUM})`),price:extract(m,`(?:现价|股价)\\s*(${NUM})`)};
  if(/转.*给|给.*转|转账/.test(m))return {intent:'transfer',amount:extract(m,`(?:转账?|给[^\\d零一二两三四五六七八九十百千万]+转)\\s*(${NUM})`),recipient:m.includes('张三')?'contact_zhangsan':m.includes('李四')?'contact_lisi':m.includes('专户')?'acc_exercise':m.includes('家人')?'contact_family':undefined};
  if(/余额|零钱|剩多少|还有多少钱|多少钱了/.test(m))return {intent:'balance'};
  if(/账单|花了多少|支出|异常/.test(m))return {intent:'bills',month:m.match(/\d{4}-\d{2}/)?.[0]};
  if(/取消.*(订阅|会员|云存储)|退订/.test(m))return {intent:'cancel_subscription'};
  if(/订阅|代扣|会员/.test(m))return {intent:'subscriptions'};
  if(/虚拟卡.*(申请|开)|申请.*虚拟卡/.test(m))return {intent:'apply_virtual_card'};
  if(/挂失|解挂|卡.*限额/.test(m))return {intent:'card_change'};
  if(/卡片|银行卡/.test(m))return {intent:'cards'};
  if(/计划/.test(m))return {intent:'plans'};
  if(/^(好|好的|同意|可以|就这样|按这个|确认)/.test(m))return {intent:'agree'};
  return {intent:'unknown'};
}
function createAgent({tools,clock,llm=createLLM()}={}) {
  const pending=new Map();let latest,proposal;
  const version=()=>tools.audit.list().at(-1)?.seq||0;
  const response=(reply,cards=[],extra={})=>({reply,cards,stateVersion:version(),...extra});
  const call=(tool,p={})=>tools.call(tool,{...p,idempotencyKey:randomUUID()});
  function invalidate(){for(const p of pending.values()){p.invalid=true;if(p.authId)tools.gate.revoke(p.authId);}latest=undefined;}
  function finish(tool,p,r) {
    if(!r.ok&&['NEED_CONFIRM','NEED_VERIFY'].includes(r.error.code)){
      const ref=randomUUID();pending.set(ref,{tool,params:structuredClone(p),expires:Date.parse(clock.now())+300000});latest=ref;
      const data=r.data;const summary=tool==='transfer'?`转账至 ${data.params.toRef}，金额 ${yuan(data.params.amountCents)}`:tool==='create_plan'?`创建备资计划，每月锁定 ${yuan(data.params.monthlyLockCents)}，到期 ${data.params.targetDate}`:`${tool}：${JSON.stringify(data.params)}`;
      return response('请核对详情并完成授权。',[{type:r.error.code==='NEED_CONFIRM'?'confirm':'verify',toolCallRef:ref,summary,paramsDigest:data.paramsDigest,params:data.params}]);
    }
    return response(r.ok?`办理成功：${tool}${r.data?.amountCents!==undefined?'，'+yuan(r.data.amountCents):''}。`:`未执行：${r.error.code}。`,[],{result:r});
  }
  async function authorize({toolCallRef,proof}={}) {
    const p=pending.get(toolCallRef);
    if(!p||p.invalid)return response('授权已失效，请重新发起。',[],{result:{ok:false,error:{code:'AUTH_BINDING_MISMATCH'}}});
    if(p.done)return response('该请求已执行，请勿重复授权。');
    if(Date.parse(clock.now())>=p.expires)return response('授权已过期，请重新发起。',[],{result:{ok:false,error:{code:'AUTH_EXPIRED'}}});
    const grant=tools.authorize(p.tool,p.params,proof||{});
    if(!grant.ok)return response(`授权失败：${grant.error.code}，可重试。`,[],{result:grant});
    p.authId=grant.data.id;
    const result=tools.call(p.tool,{...p.params,idempotencyKey:randomUUID()},{authId:p.authId});p.done=result.ok;
    return finish(p.tool,p.params,result);
  }
  async function chat(message) {
    if(typeof message!=='string'||!message.trim()||message.length>8000)return response('请输入有效消息。');
    const guard=screen(message);if(guard.blocked){tools.gate.recordInjection();return response(`已拦截：${guard.reason}`);}
    let i=parseIntent(message);if(i.intent==='unknown')i=await llm(message)||i;
    const snapshot=()=>tools.state.snapshot();
    const run=(name,p={})=>finish(name,p,call(name,p));
    switch(i.intent){
      case 'stop':invalidate();return response('已停止待授权操作。已执行业务不能撤回；可说“取消计划”取消未执行步骤，或切换手动模式。');
      case 'balance':{const r=call('get_accounts');return response(r.data.map(a=>`${a.name}余额 ${yuan(a.balanceCents)}`).join('；'));}
      case 'bills':{const r=call('analyze_bills',{month:i.month||clock.now().slice(0,7)});const d=r.data;return response(`${d.month} 分类合计：${Object.entries(d.categories).map(([k,v])=>`${k} ${yuan(v)}`).join('；')||'暂无流水'}。总支出 ${yuan(d.totalOutCents)}。异常 ${d.anomalies.map(t=>`${t.counterparty} ${yuan(t.amountCents)}`).join('；')||'无'}。`);}
      case 'transfer':{const p={fromId:'acc_demand',toRef:i.recipient,amountCents:i.amount===undefined?undefined:cents(i.amount)};if(!p.toRef||!p.amountCents)return response('请提供转账金额和收款人（张三、李四、家人或专户）。');invalidate();return run('transfer',p);}
      case 'modify':{const old=pending.get(latest);if(!old)return response('请先发起要修改的业务。');const p=structuredClone(old.params);const amount=extract(message,`(?:改成|改为|金额改成?)\\s*(${NUM})`);if(amount!==undefined){if(old.tool==='transfer')p.amountCents=cents(amount);else if(old.tool==='create_plan')p.monthlyLockCents=cents(amount);else return response('请重新描述完整业务参数。');}else if(old.tool==='transfer'&&/张三|李四/.test(message))p.toRef=message.includes('张三')?'contact_zhangsan':'contact_lisi';else return response('请说明新金额或收款人。');const tool=old.tool;invalidate();return run(tool,p);}
      case 'calc':{if(!i.shares||i.exercise===undefined||i.price===undefined)return response('请提供期权股数、行权价和现价。');const half=Math.floor(i.shares/2);const r=call('calc_exercise',{shares:i.shares,exercisePriceCents:cents(i.exercise),priceScenariosCents:[cents(i.price)],sellPriceCents:cents(i.price),batches:half?[{shares:half,yearOffset:0},{shares:i.shares-half,yearOffset:1}]:[{shares:i.shares,yearOffset:0}]});if(!r.ok)return finish('calc_exercise',{},r);proposal=r.data.fundingProposal;const bills=call('analyze_bills',{month:clock.now().slice(0,7)});const accounts=call('get_accounts');return response(r.data.results.map(x=>`${x.arrangement==='once'?'一次行权':'分批跨年'} × ${x.exitMethod==='immediate'?'立即卖出':'持有再卖'}：行权款 ${yuan(x.exerciseCostCents)}，税额 ${yuan(x.taxCents)}，税后净收益 ${yuan(x.netProceedsCents)}`).join('；')+`。当前活期 ${yuan(accounts.data.find(a=>a.id==='acc_demand').balanceCents)}，本月支出 ${yuan(bills.data.totalOutCents)}。假设：${r.data.results[0].assumptions.join('；')}。${r.data.results[0].deferralNote} 仅供参考，不构成税务建议。建议提前备资，是否按建议创建资金计划？仅办理银行侧备资，实际行权由雇主/券商执行。`,[{type:'comparison',data:r.data}]);}
      case 'agree':if(proposal){invalidate();return run('create_plan',proposal);}return response('请使用授权卡确认，或先说明要办理的业务。');
      case 'plan':{if(i.monthly===undefined)return response('请说明每月锁定金额和目标日期，或先进行行权测算。');const year=new Date(clock.now()).getUTCFullYear()+1;proposal={monthlyLockCents:cents(i.monthly),redeemSchedule:[],targetDate:`${year}-03-31T08:00:00.000Z`,destAccountId:'acc_exercise'};invalidate();return run('create_plan',proposal);}
      case 'plans':return response('资金计划与步骤见面板。',[{type:'plans',plans:snapshot().plans,steps:snapshot().steps}]);
      case 'cancel_plan':{const plans=snapshot().plans.filter(p=>p.status==='active');const p=plans.find(p=>message.includes(p.id))||(plans.length===1?plans[0]:null);return p?run('cancel_plan',{planId:p.id}):response('请指定要取消的计划编号。');}
      case 'subscriptions':{const r=call('list_subscriptions');return response(r.data.map(s=>`${s.name} ${yuan(s.amountCents)}，${s.status}`).join('；'));}
      case 'cancel_subscription':{const r=call('list_subscriptions');const s=r.data.find(s=>message.includes(s.name));return s?run('cancel_subscription',{subscriptionId:s.id}):response('请指定订阅名称。');}
      case 'cards':return response('卡片状态见面板。',[{type:'cards',data:snapshot().cards}]);
      case 'apply_virtual_card':return run('apply_virtual_card');
      case 'card_change':{const cards=snapshot().cards;const c=cards.find(c=>message.includes(c.id))||(cards.length===1?cards[0]:null);if(!c)return response('请指定卡片编号。');const limit=extract(message,`限额\\s*(?:改成|改为)?\\s*(${NUM})`);return run('set_card_status',limit!==undefined?{cardId:c.id,limitCents:cents(limit)}:{cardId:c.id,status:/解挂/.test(message)?'unlost':'lost'});}
      default:return response('抱歉，目前仅支持模拟银行的余额、账单、转账、卡片、订阅、行权测算和资金计划，无法办理该请求。');
    }
  }
  return {chat,authorize,stateVersion:version};
}
module.exports={createAgent,parseIntent,number};
