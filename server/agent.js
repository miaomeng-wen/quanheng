'use strict';
const {randomUUID}=require('node:crypto');
const {screen}=require('./guard');
const {createLLM}=require('./llm');
const NUM='[0-9零〇一二两三四五六七八九十百千万点.]+';
function number(text) {
  if(/^\d+(\.\d+)?$/.test(text))return Number(text);
  const mixed=/^(\d+(?:\.\d+)?)(万|千|百)?$/.exec(text);if(mixed)return Number(mixed[1])*({万:10000,千:1000,百:100}[mixed[2]]||1);
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
  if(/限额/.test(m))return {intent:'card_change'};
  if(/改成|改为|金额改|收款人改/.test(m))return {intent:'modify'};
  if(/先停|暂停|转人工|手动模式/.test(m))return {intent:'stop'};
  if(/取消.*计划/.test(m))return {intent:'cancel_plan'};
  if(/每月|备资|资金计划|锁定|发薪.*锁|赎回.*(计划|备资)/.test(m))return {intent:'plan',monthly:extract(m,`(?:锁定?|每月)\\s*(${NUM})`),redeemTotal:extract(m,`赎回.*?(${NUM})`),batches:(()=>{const b=m.match(/分(两|二|三|四|五|\\d+)批/)?.[1];return b?({'两':2,'二':2,'三':3,'四':4,'五':5}[b]||parseInt(b)):undefined;})()};
  if(/期权|行权价|测算|分两年/.test(m))return {intent:'calc',shares:extract(m,`(${NUM})\\s*股`),exercise:extract(m,`行权价\\s*(${NUM})`),price:extract(m,`(?:现价|股价)\\s*(${NUM})`)};
  if(/风险测评|风险评估/.test(m)){const digits=m.match(/[0-4]{3,}/)?.[0];return {intent:'risk',answers:digits?[...digits].map(Number):undefined};}
  const prod=m.includes('货币基金')||m.includes('货基')?'product_money_market':m.includes('固收')?'product_bond':m.includes('均衡')?'product_balanced':undefined;
  if(/赎回/.test(m))return {intent:'redeem',product:prod,amount:extract(m,`赎回.*?(${NUM})`)};
  if((/申购|买入|购买|买/.test(m))&&prod)return {intent:'buy',product:prod,amount:extract(m,`(${NUM})`)};
  if(/理财|货币基金|货基|固收|均衡/.test(m))return {intent:'products'};
  if(/AA|平摊|均摊/.test(m))return {intent:'aa',amount:extract(m,`(${NUM})`),people:['张三','李四','家人'].filter(n=>m.includes(n))};
  const phone=m.match(/1[3-9]\d{9}/)?.[0];
  if(phone||/转.*给|给.*转|转账/.test(m))return {intent:'transfer',phone,amount:extract(m,`(?:转账?|给[^\\d零一二两三四五六七八九十百千万]+转)\\s*(${NUM})`),recipient:m.includes('张三')?'contact_zhangsan':m.includes('李四')?'contact_lisi':m.includes('专户')?'acc_exercise':m.includes('家人')?'contact_family':undefined};
  if(/余额|零钱|剩多少|还有多少钱|多少钱了/.test(m))return {intent:'balance'};
  if(/账单|花了多少|支出|异常/.test(m))return {intent:'bills',month:m.match(/\d{4}-\d{2}/)?.[0],rel:/上个月|上月/.test(m)?'prev':/这个月|本月|这月/.test(m)?'current':undefined};
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
  const REF_NAMES={contact_zhangsan:'张三',contact_lisi:'李四',contact_family:'家人',acc_exercise:'行权资金专户',acc_demand:'工资卡/活期'};
  const refName=ref=>REF_NAMES[ref]||ref;
  const cardName=id=>id==='card_physical'?'实体卡':String(id).includes('virtual')?'虚拟卡':'银行卡';
  function summarize(tool,p={}) {
    switch(tool){
      case 'transfer':return `向${refName(p.toRef)}转账 ${yuan(p.amountCents)}`;
      case 'schedule_transfer':return `定时转账：${String(p.executeAt||'').slice(0,10)} 向${refName(p.toRef)}转账 ${yuan(p.amountCents)}`;
      case 'create_plan':return `创建备资计划：每月锁定 ${yuan(p.monthlyLockCents)}，目标日期 ${String(p.targetDate||'').slice(0,10)}`;
      case 'cancel_plan':return '取消备资计划（未执行步骤将不再执行）';
      case 'set_card_status':return p.limitCents!==undefined?`将${cardName(p.cardId)}单日限额调整为 ${yuan(p.limitCents)}`:`${p.status==='unlost'?'解除挂失':'挂失'}${cardName(p.cardId)}`;
      case 'apply_virtual_card':return '申请一张虚拟卡';
      case 'cancel_subscription':{const s=call('list_subscriptions').data?.find(x=>x.id===p.subscriptionId);return s?`取消订阅「${s.name}」（${yuan(s.amountCents)}/月）`:'取消订阅';}
      case 'buy_product':{const pr=call('get_products').data?.find(x=>x.id===p.productId);return `申购理财产品${pr?`「${pr.name}」`:''} ${yuan(p.amountCents)}`;}
      case 'redeem_product':{const h=tools.state.snapshot().holdings.find(x=>x.id===p.holdingId);const pr=call('get_products').data?.find(x=>x.id===(p.productId||h?.productId));return `赎回理财产品${pr?`「${pr.name}」`:''}${p.amountCents?` ${yuan(p.amountCents)}`:''}`;}
      default:return tool;
    }
  }
  function finish(tool,p,r) {
    if(!r.ok&&['NEED_CONFIRM','NEED_VERIFY'].includes(r.error.code)){
      const ref=randomUUID();pending.set(ref,{tool,params:structuredClone(p),expires:Date.parse(clock.now())+300000});latest=ref;
      const data=r.data;const summary=summarize(tool,data.params);
      return response('请核对详情并完成授权。',[{type:r.error.code==='NEED_CONFIRM'?'confirm':'verify',toolCallRef:ref,summary,paramsDigest:data.paramsDigest,params:data.params}]);
    }
    return response(r.ok?`办理成功：${summarize(tool,p)}。`:`未执行：${r.error.code}。`,[],{result:r});
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
    if(['balance','bills','subscriptions','products'].includes(i.intent)&&/(张三|李四|家人|别人|他人|他的|她的)/.test(message))return response('出于隐私与安全，我只能查询你本人名下的账户、账单与订阅，无法查询他人的信息。');
    const snapshot=()=>tools.state.snapshot();
    const shiftMonth=(ym,delta)=>{const d=new Date(Date.UTC(+ym.slice(0,4),+ym.slice(5,7)-1+delta,1));return d.toISOString().slice(0,7);};
    function latestBills(){let month=clock.now().slice(0,7);for(let k=0;k<12;k++){const r=call('analyze_bills',{month});if(Object.keys(r.data.categories).length)return r.data;month=shiftMonth(month,-1);}return call('analyze_bills',{month:clock.now().slice(0,7)}).data;}
    const run=(name,p={})=>finish(name,p,call(name,p));
    switch(i.intent){
      case 'stop':invalidate();return response('已停止待授权操作。已执行业务不能撤回；可说“取消计划”取消未执行步骤，或切换手动模式。');
      case 'balance':{const r=call('get_accounts');return response(r.data.map(a=>`${a.name}余额 ${yuan(a.balanceCents)}`).join('；'));}
      case 'bills':{const month=i.month||(i.rel==='prev'?shiftMonth(clock.now().slice(0,7),-1):i.rel==='current'?clock.now().slice(0,7):null);const d=month?call('analyze_bills',{month}).data:latestBills();return response(`${d.month} 分类合计：${Object.entries(d.categories).map(([k,v])=>`${k} ${yuan(v)}`).join('；')||'暂无流水'}。总支出 ${yuan(d.totalOutCents)}。异常 ${d.anomalies.map(t=>`${t.counterparty} ${yuan(t.amountCents)}`).join('；')||'无'}。`);}
      case 'transfer':{let toRef=i.recipient;if(!toRef&&i.phone){const c=snapshot().contacts.find(c=>c.phone===i.phone);if(c)toRef=c.id;}const p={fromId:'acc_demand',toRef,amountCents:i.amount===undefined?undefined:cents(i.amount)};if(!p.toRef||!p.amountCents)return response('请提供转账金额和收款人（张三、李四、家人、专户，或联系人手机号）。');invalidate();return run('transfer',p);}
      case 'modify':{const old=pending.get(latest);if(!old)return response('请先发起要修改的业务。');const p=structuredClone(old.params);const amount=extract(message,`(?:改成|改为|金额改成?)\\s*(${NUM})`);if(amount!==undefined){if(old.tool==='transfer')p.amountCents=cents(amount);else if(old.tool==='create_plan')p.monthlyLockCents=cents(amount);else return response('请重新描述完整业务参数。');}else if(old.tool==='transfer'&&/张三|李四/.test(message))p.toRef=message.includes('张三')?'contact_zhangsan':'contact_lisi';else return response('请说明新金额或收款人。');const tool=old.tool;invalidate();return run(tool,p);}
      case 'calc':{if(!i.shares||i.exercise===undefined||i.price===undefined)return response('请提供期权股数、行权价和现价。');const half=Math.floor(i.shares/2);const r=call('calc_exercise',{shares:i.shares,exercisePriceCents:cents(i.exercise),priceScenariosCents:[cents(i.price)],sellPriceCents:cents(i.price),batches:half?[{shares:half,yearOffset:0},{shares:i.shares-half,yearOffset:1}]:[{shares:i.shares,yearOffset:0}]});if(!r.ok)return finish('calc_exercise',{},r);proposal=r.data.fundingProposal;const bills=latestBills();const accounts=call('get_accounts');return response(r.data.results.map(x=>`${x.arrangement==='once'?'一次行权':'分批跨年'} × ${x.exitMethod==='immediate'?'立即卖出':'持有再卖'}：行权款 ${yuan(x.exerciseCostCents)}，税额 ${yuan(x.taxCents)}，税后净收益 ${yuan(x.netProceedsCents)}`).join('；')+`。当前活期 ${yuan(accounts.data.find(a=>a.id==='acc_demand').balanceCents)}，最近月份（${bills.month}）支出 ${yuan(bills.totalOutCents)}。假设：${r.data.results[0].assumptions.join('；')}。${r.data.results[0].deferralNote} 仅供参考，不构成税务建议。建议提前备资，是否按建议创建资金计划？仅办理银行侧备资，实际行权由雇主/券商执行。`,[{type:'comparison',data:r.data}]);}
      case 'agree':if(proposal){invalidate();return run('create_plan',proposal);}return response('请使用授权卡确认，或先说明要办理的业务。');
      case 'plan':{if(i.monthly===undefined)return response('请说明每月锁定金额和目标日期，或先进行行权测算。');const year=new Date(clock.now()).getUTCFullYear()+1;const sched=[];if(i.redeemTotal){const n=i.batches||1;const total=cents(i.redeemTotal);const each=Math.floor(total/n);const nowMs=Date.parse(clock.now());for(let k=0;k<n;k++)sched.push({holdingId:'holding_money_market',amountCents:k===n-1?total-each*(n-1):each,executeAt:new Date(nowMs+(1+k*31)*86400000).toISOString()});}proposal={monthlyLockCents:cents(i.monthly),redeemSchedule:sched,targetDate:`${year}-03-31T08:00:00.000Z`,destAccountId:'acc_exercise'};invalidate();return run('create_plan',proposal);}
      case 'plans':return response('资金计划与步骤见面板。',[{type:'plans',plans:snapshot().plans,steps:snapshot().steps}]);
      case 'cancel_plan':{const plans=snapshot().plans.filter(p=>p.status==='active');const p=plans.find(p=>message.includes(p.id))||(plans.length===1?plans[0]:null);return p?run('cancel_plan',{planId:p.id}):response('请指定要取消的计划编号。');}
      case 'subscriptions':{const r=call('list_subscriptions');const nowMs=Date.parse(clock.now());return response(r.data.map(s=>{if(s.status!=='active')return `${s.name} ${yuan(s.amountCents)}，${s.status}`;const days=Math.ceil((Date.parse(s.nextChargeAt)-nowMs)/86400000);return `${s.name} ${yuan(s.amountCents)}，${s.status}，下次扣费 ${s.nextChargeAt.slice(0,10)}${days<0?'（已到期）':days===0?'（今天）':`（还有 ${days} 天${days<=7?'，即将续费':''}）`}`;}).join('；'));}
      case 'products':{const r=call('get_products');const hold=snapshot().holdings;return response(r.data.map(p=>{const h=hold.find(x=>x.productId===p.id);return `「${p.name}」风险 ${p.riskLevel}，参考年化 ${(p.expectedReturnBps/100).toFixed(2)}%，起购 ${yuan(p.minAmountCents)}${h?`，当前持仓 ${yuan(h.sharesCents)}`:''}`;}).join('；')+'。可直接说“买50000元货币基金”申购，或“赎回货币基金5万元”。');}
      case 'buy':{if(!i.amount)return response('请说明申购金额，例如“买50000元货币基金”。');invalidate();return run('buy_product',{productId:i.product,fromId:'acc_demand',amountCents:cents(i.amount)});}
      case 'redeem':{const hold=snapshot().holdings;const h=i.product?hold.find(x=>x.productId===i.product):hold.find(x=>x.sharesCents>0);if(!h)return response('暂无可赎回的持仓。');if(!i.amount)return response(`当前持仓 ${yuan(h.sharesCents)}，请说明赎回金额。`);invalidate();return run('redeem_product',{holdingId:h.id,toId:'acc_demand',amountCents:cents(i.amount)});}
      case 'risk':{if(!i.answers)return response('风险测评请按“风险测评：32231”的格式回复一串数字，每题 0-4 分（0 最保守、4 最积极），我会据此评定 R1-R3 等级。');const r=call('assess_risk',{answers:i.answers});return r.ok?response(`测评完成：得分 ${r.data.score}，风险等级 ${r.data.riskLevel}。该等级会用于申购适当性提示。`):finish('assess_risk',{},r);}
      case 'aa':{if(!i.amount||!i.people.length)return response('请说明总金额和参与平摊的人，例如“晚饭300元，和张三、李四AA”。');const total=cents(i.amount);const n=i.people.length+1;const each=Math.floor(total/n);const rest=total-each*n;return response(`平摊计算：共 ${yuan(total)}，${n} 人（含你），每人 ${yuan(each)}${rest?`，零头 ${yuan(rest)} 由你承担`:''}。收款清单：${i.people.map(p=>`${p} ${yuan(each)}`).join('；')}。`);}
      case 'cancel_subscription':{const r=call('list_subscriptions');const s=r.data.find(s=>message.includes(s.name));return s?run('cancel_subscription',{subscriptionId:s.id}):response('请指定订阅名称。');}
      case 'cards':return response('卡片状态见面板。',[{type:'cards',data:snapshot().cards}]);
      case 'apply_virtual_card':return run('apply_virtual_card');
      case 'card_change':{const cards=snapshot().cards;const c=cards.find(c=>message.includes(c.id))||(cards.length===1?cards[0]:null);if(!c)return response('请指定卡片编号。');const limit=extract(message,`限额\\s*(?:改成|改为)?\\s*(${NUM})`);return run('set_card_status',limit!==undefined?{cardId:c.id,limitCents:cents(limit)}:{cardId:c.id,status:/解挂/.test(message)?'unlost':'lost'});}
      default:return response('抱歉，这个请求不在我的业务范围里，办不了。我能帮你的是模拟银行的余额查询、账单分析、转账、理财申购赎回、卡片、订阅、行权测算和资金计划——比如先帮你看看余额，或者分析一下最近的账单？');
    }
  }
  return {chat,authorize,stateVersion:version};
}
module.exports={createAgent,parseIntent,number};
