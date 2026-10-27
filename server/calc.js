'use strict';
// Pure engine: policy is supplied by the caller, never imported or modified here.
const invalid = () => { throw new Error('INVALID_PARAMS'); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
const safe = n => { if (!Number.isSafeInteger(n)) invalid(); return n; };
const number = n => safe(Number(n));
function calcExercise(input, policy) {
  if (!input || !policy) invalid();
  const {shares, exercisePriceCents, priceScenariosCents, sellPriceCents,
    priorYearIncentiveIncomeCents = 0, batches = [{shares, yearOffset:0}]} = input;
  if (!integer(shares) || !shares || !integer(exercisePriceCents) ||
      !integer(sellPriceCents) || !integer(priorYearIncentiveIncomeCents) ||
      !Array.isArray(priceScenariosCents) || !priceScenariosCents.length || !priceScenariosCents.every(integer) ||
      !Array.isArray(batches) || !batches.length || batches.some(b => !b || !integer(b.shares) || !b.shares || !integer(b.yearOffset)) ||
      number(batches.reduce((s,b) => s + BigInt(b.shares), 0n)) !== shares) invalid();
  const brackets = policy.brackets;
  if (policy.mergeSameYear?.value !== true || !Array.isArray(brackets) || !brackets.length ||
      !Array.isArray(policy.sources) || !policy.sources.length ||
      brackets.some((b,i) => !integer(b.rateBps) || b.rateBps > 10000 || !integer(b.quickDeductionCents) ||
        (i === brackets.length-1 ? b.upperBoundCents !== null : !integer(b.upperBoundCents) || b.upperBoundCents <= (brackets[i-1]?.upperBoundCents ?? -1)))) invalid();
  function tax(income) {
    const b = brackets.find(b => b.upperBoundCents === null || income <= b.upperBoundCents);
    // Integer cents × integer basis points. Round half up to one cent once per
    // annual total (add 5000 before dividing by 10000); subtract rounded annual
    // prior-income tax to obtain incremental tax. No binary floating arithmetic.
    const due = (BigInt(income)*BigInt(b.rateBps)+5000n)/10000n-BigInt(b.quickDeductionCents);
    return {incomeCents:income,taxCents:number(due < 0n ? 0n : due),...b};
  }
  const cost = number(BigInt(shares)*BigInt(exercisePriceCents));
  const assumptions = price => [
    `行权价格情景：${price}分/股；卖价假设：${sellPriceCents}分/股`,
    `政策版本：${policy.version?.value}；有效期：${policy.effectivePeriod?.value}`,
    ...policy.sources.map(s => `政策出处：${s}`),
    policy.verified ? '税务参数已核验（核查报告 docs/policy-research.md），按现行政策测算' : '税务参数未核验（verified:false / unverified:true），仅作假设测算',
    '同一纳税年度激励收入合并计税；priorYearIncentiveIncomeCents 视为 yearOffset=0 当年已有收入',
    '跨年价格保持情景价不变；不计交易费用及持有后卖出环节税费'
  ];
  const deferralNote = policy.deferral?.verified
    ? `延期缴税：经备案可自行权之日起不超过${policy.deferral.monthsMax}个月内缴纳（${policy.deferral.source}）；本提示不改变测算税额。`
    : '延期缴税资格、期限及政策待核验；本提示不改变测算税额。';
  const results = [], baselines = [];
  for (const price of priceScenariosCents) {
    const spread = Math.max(0, price-exercisePriceCents);
    const income = number(BigInt(spread)*BigInt(shares));
    const notes = assumptions(price);
    if (price < exercisePriceCents) notes.push('价格低于行权价，激励收入按0计算；不行权基线占优（立即卖出假设）');
    baselines.push({priceScenarioCents:price,arrangement:'no_exercise',exitMethod:'no_exercise',exerciseCostCents:0,incentiveIncomeCents:0,taxCents:0,netProceedsCents:0,opportunityCostCents:income,taxBreakdown:{years:[]},assumptions:[...notes],deferralNote});
    for (const [arrangement, schedule] of [['once',[{shares,yearOffset:0}]],['batches',batches]]) {
      const years = new Map();
      for (const b of schedule) years.set(b.yearOffset, safe((years.get(b.yearOffset)||0)+number(BigInt(b.shares)*BigInt(spread))));
      const breakdown = [...years].sort((a,b)=>a[0]-b[0]).map(([yearOffset,incentiveIncomeCents]) => {
        const priorIncomeCents = yearOffset === 0 ? priorYearIncentiveIncomeCents : 0;
        const before = tax(priorIncomeCents), after = tax(safe(priorIncomeCents+incentiveIncomeCents));
        return {yearOffset,priorIncomeCents,incentiveIncomeCents,combinedIncomeCents:after.incomeCents,priorTaxCents:before.taxCents,combinedTaxCents:after.taxCents,taxCents:after.taxCents-before.taxCents,rateBps:after.rateBps,quickDeductionCents:after.quickDeductionCents};
      });
      const taxCents = breakdown.reduce((s,b)=>safe(s+b.taxCents),0);
      for (const exitMethod of ['immediate','hold']) {
        const salePrice = exitMethod === 'immediate' ? price : sellPriceCents;
        results.push({priceScenarioCents:price,arrangement,exitMethod,sellPriceCents:salePrice,batches:schedule.map(b=>({...b})),exerciseCostCents:cost,incentiveIncomeCents:income,taxCents,netProceedsCents:number(BigInt(salePrice)*BigInt(shares)-BigInt(cost)-BigInt(taxCents)),taxBreakdown:{years:structuredClone(breakdown)},assumptions:[...notes],deferralNote});
      }
    }
  }
  return {results,baselines};
}
module.exports = {calcExercise};
