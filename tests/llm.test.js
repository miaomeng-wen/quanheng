'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const {createClock}=require('../server/clock');const {createAudit}=require('../server/audit');const {createTools}=require('../server/tools');const {createAgent}=require('../server/agent');const {createLLM}=require('../server/llm');

function mockLLM(handler){return new Promise(resolve=>{const srv=http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{const payload=handler(JSON.parse(b));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(payload)}}]}));});});srv.listen(0,'127.0.0.1',()=>resolve(srv));});}
function setup(llm){const clock=createClock('2026-10-27T08:00:00Z');const tools=createTools({clock,audit:createAudit({clock,filePath:null})});return {agent:createAgent({clock,tools,llm}),tools};}

test('未配置端点时 LLM 层返回 null 并降级',async()=>{
  const parse=createLLM({});
  assert.equal(await parse('工资发了没'),null);
  const {agent}=setup(async()=>null);
  assert.match((await agent.chat('工资发了没')).reply,/抱歉/);
});

test('LLM 兜底理解规则外说法，且只产出校验后的意图',async()=>{
  const srv=await mockLLM(()=>({intent:'balance'}));
  try{
    const env={QH_LLM_BASE_URL:`http://127.0.0.1:${srv.address().port}`,QH_LLM_API_KEY:'test',QH_LLM_MODEL:'mock'};
    const {agent}=setup(createLLM(env));
    assert.match((await agent.chat('工资发了没')).reply,/20000元/);
  }finally{srv.close();}
});

test('LLM 返回越界意图/槽位被拒绝或清洗',async()=>{
  const srv=await mockLLM(()=>({intent:'exec',amount:-1,recipient:'hacker'}));
  try{
    const env={QH_LLM_BASE_URL:`http://127.0.0.1:${srv.address().port}`,QH_LLM_API_KEY:'test',QH_LLM_MODEL:'mock'};
    assert.equal(await createLLM(env)('任意'),null);
  }finally{srv.close();}
  const srv2=await mockLLM(()=>({intent:'transfer',amount:100,recipient:'hacker'}));
  try{
    const env={QH_LLM_BASE_URL:`http://127.0.0.1:${srv2.address().port}`,QH_LLM_API_KEY:'test',QH_LLM_MODEL:'mock'};
    const r=await createLLM(env)('转钱');
    assert.equal(r.intent,'transfer');assert.equal(r.recipient,undefined);
  }finally{srv2.close();}
});

test('端点不可达时降级不抛错',async()=>{
  const env={QH_LLM_BASE_URL:'http://127.0.0.1:1',QH_LLM_API_KEY:'test',QH_LLM_MODEL:'mock'};
  assert.equal(await createLLM(env)('工资发了没'),null);
});
