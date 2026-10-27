'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {calcExercise} = require('../server/calc');
const policy = require('../data/tax-policy.json');
const {createTools} = require('../server/tools');
const {createAudit} = require('../server/audit');
const {createClock} = require('../server/clock');
const base = {shares:10000,exercisePriceCents:1200,priceScenariosCents:[2800],sellPriceCents:2800,priorYearIncentiveIncomeCents:0,batches:[{shares:10000,yearOffset:0}]};
const run = (patch={}) => calcExercise({...base,...patch},policy);
const result = (output,arrangement='once',exitMethod='immediate') => output.results.find(r=>r.arrangement===arrangement && r.exitMethod===exitMethod);
test('验收1：一次行权税额15080元、净到手144920元，假设含情景与出处',()=>{
  const r=result(run()); assert.equal(r.exerciseCostCents,12000000); assert.equal(r.incentiveIncomeCents,16000000);
  assert.equal(r.taxCents,1508000); assert.equal(r.netProceedsCents,14492000);
  assert.ok(r.assumptions.some(s=>s.includes('2800'))); assert.ok(r.assumptions.some(s=>s.includes('公告2023年第25号')));
  assert.ok(!r.assumptions.some(s=>s.includes('未核验'))); assert.ok(r.deferralNote);
});
test('验收2：跨年各5000股合计10960元',()=>{
  const r=result(run({batches:[{shares:5000,yearOffset:0},{shares:5000,yearOffset:1}]}),'batches');
  assert.equal(r.taxCents,1096000); assert.deepEqual(r.taxBreakdown.years.map(y=>y.taxCents),[548000,548000]);
  assert.equal(result(run()).taxCents-r.taxCents,412000);
});
test('验收3：已有10万元激励收入，本次增量27600元',()=>{
  const r=result(run({priorYearIncentiveIncomeCents:10000000})); assert.equal(r.taxCents,2760000);
  assert.equal(r.taxBreakdown.years[0].combinedTaxCents,3508000); assert.equal(r.taxBreakdown.years[0].priorTaxCents,748000);
});
test('验收4：22.4元税额7880元，低于行权价收入和税为零',()=>{
  assert.equal(result(run({priceScenariosCents:[2240]})).taxCents,788000);
  const r=result(run({priceScenariosCents:[1000]})); assert.equal(r.incentiveIncomeCents,0); assert.equal(r.taxCents,0);
  assert.equal(r.netProceedsCents,-2000000); assert.ok(r.assumptions.some(s=>s.includes('不行权基线占优')));
});
test('验收5：各情景不行权基线为0，机会成本为非负内在价值，字段齐全',()=>{
  const rows=run({priceScenariosCents:[2800,2240,1000]}).baselines;
  assert.deepEqual(rows.map(r=>r.netProceedsCents),[0,0,0]); assert.deepEqual(rows.map(r=>r.opportunityCostCents),[16000000,10400000,0]);
  for(const r of rows) for(const key of ['exerciseCostCents','incentiveIncomeCents','taxCents','taxBreakdown','assumptions','deferralNote']) assert.ok(key in r);
});
test('税率边界恰好36000/144000元与上下1分，半分四舍五入',()=>{
  for(const [income,tax] of [[3599999,108000],[3600000,108000],[3600001,108000],[14399999,1188000],[14400000,1188000],[14400001,1188000],[16,0],[17,1],[50,2]]) {
    assert.equal(result(run({shares:1,exercisePriceCents:0,priceScenariosCents:[income],sellPriceCents:income,batches:[{shares:1,yearOffset:0}]})).taxCents,tax);
  }
});
test('同年多批先合并；已有收入仅作用于当年，批次顺序不影响结果',()=>{
  const batches=[{shares:2500,yearOffset:0},{shares:2500,yearOffset:0},{shares:5000,yearOffset:1}];
  const r=result(run({batches,priorYearIncentiveIncomeCents:10000000}),'batches');
  assert.equal(r.taxCents,1708000); assert.deepEqual(r.taxBreakdown.years.map(y=>y.taxCents),[1160000,548000]);
  assert.deepEqual(result(run({batches:[...batches].reverse(),priorYearIncentiveIncomeCents:10000000}),'batches').taxBreakdown,r.taxBreakdown);
});
test('情景×安排×退出笛卡尔积，持有卖价与行权价格独立',()=>{
  const o=run({priceScenariosCents:[2800,2240],sellPriceCents:3360});assert.equal(o.results.length,8);
  const immediate=result(o),hold=result(o,'once','hold'); assert.equal(hold.taxCents,immediate.taxCents);
  assert.equal(hold.netProceedsCents,20092000); assert.equal(hold.sellPriceCents,3360); assert.equal(immediate.sellPriceCents,2800);
});
function freeze(x){if(x && typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
test('只读输入和policy；入参伪造税率无效；修改返回值不污染后续测算',()=>{
  const p=freeze(structuredClone(policy)), input=freeze({...structuredClone(base),taxCents:0,rateBps:0,policy:{brackets:[]}});
  const before=JSON.stringify(p),o=calcExercise(input,p); assert.equal(result(o).taxCents,1508000);assert.equal(JSON.stringify(p),before);
  result(o).taxBreakdown.years[0].taxCents=0; result(o).assumptions.length=0;
  assert.equal(result(calcExercise(input,p)).taxCents,1508000);
  // Only the explicit policy argument supplies rates; no hidden hardcoded table.
  const alternate=structuredClone(policy);alternate.brackets.forEach(b=>{b.rateBps=0;b.quickDeductionCents=0;});
  assert.equal(result(calcExercise(base,alternate)).taxCents,0);
});
test('非法金额、批次、卖价和溢出被拒绝',()=>{
  for(const patch of [{shares:0},{sellPriceCents:undefined},{exercisePriceCents:1.1},{batches:[{shares:9999,yearOffset:0}]},{batches:[{shares:10000,yearOffset:-1}]},{priceScenariosCents:[]},{exercisePriceCents:Number.MAX_SAFE_INTEGER}]) assert.throws(()=>run(patch),/INVALID_PARAMS/);
  assert.throws(()=>calcExercise(base,{...policy,mergeSameYear:{value:false}}),/INVALID_PARAMS/);
});
test('工具绿级、熔断仍可调用、状态无变化、写calc_run且幂等不重复运行',()=>{
  const clock=createClock('2026-10-27'),audit=createAudit({clock,filePath:null}),t=createTools({clock,audit});
  for(let i=0;i<3;i++)t.gate.recordInjection();const before=t.state.snapshot();
  const p={...base,idempotencyKey:'calc-1',policy:{brackets:[]}};
  assert.equal(t.gate.check('calc_exercise',p).level,'green'); const r=t.calc_exercise(p);
  assert.equal(r.ok,true);assert.equal(result(r.data).taxCents,1508000);assert.deepEqual(t.state.snapshot(),before);
  assert.equal(t.calc_exercise(p).replay,'IDEMPOTENT_REPLAY');assert.equal(audit.list().filter(e=>e.event==='calc_run').length,1);assert.equal(audit.verify(),true);
  assert.equal(t.calc_exercise({...p,shares:-1,idempotencyKey:'invalid'}).error.code,'INVALID_PARAMS');
});
