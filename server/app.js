'use strict';
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createClock}=require('./clock');
const {createTools}=require('./tools');
const {createAgent}=require('./agent');
function createApp({clock=createClock('2026-10-27T08:00:00Z'),tools=createTools({clock}),agent=createAgent({tools,clock}),webRoot=path.resolve(__dirname,'../web')}={}) {
  const panel=()=>{const s=tools.state.snapshot();const audit=tools.audit.list();return {now:clock.now(),stateVersion:agent.stateVersion(),accounts:s.accounts,holdings:s.holdings,products:s.products,cards:s.cards,subscriptions:s.subscriptions,plans:s.plans,steps:s.steps,notifications:s.notifications,transactions:s.transactions.slice(-30),audit:audit.slice(-30),auditSummary:{count:audit.length,lastHash:audit.at(-1)?.hash||'',valid:tools.audit.verify()}};};
  const server=http.createServer(async(req,res)=>{
    const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try {
      const url=new URL(req.url,'http://localhost');
      if(req.method==='GET'&&url.pathname==='/api/state')return json(200,panel());
      if(req.method==='POST'&&['/api/chat','/api/authorize','/api/clock/advance'].includes(url.pathname)){
        let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>65536)return json(413,{error:'请求过大'});}
        let data;try{data=JSON.parse(body);}catch{return json(400,{error:'INVALID_JSON'});}
        if(!data||typeof data!=='object'||Array.isArray(data))return json(400,{error:'INVALID_PARAMS'});
        if(url.pathname==='/api/chat'){if(typeof data.message!=='string')return json(400,{error:'INVALID_PARAMS'});return json(200,await agent.chat(data.message));}
        if(url.pathname==='/api/authorize')return json(200,await agent.authorize(data));
        if(!Number.isInteger(data.days)||data.days<0||data.days>366)return json(400,{error:'INVALID_PARAMS'});
        clock.advance(data.days*86400000);return json(200,{...tools.runDueSteps(),stateVersion:agent.stateVersion(),now:clock.now()});
      }
      if(url.pathname.startsWith('/api/'))return json(404,{error:'NOT_FOUND'});
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'METHOD_NOT_ALLOWED'});
      const relative=decodeURIComponent(url.pathname)==='/'?'index.html':decodeURIComponent(url.pathname).slice(1);
      const file=path.resolve(webRoot,relative);
      if(!file.startsWith(webRoot+path.sep))return json(403,{error:'FORBIDDEN'});
      const real=await fs.realpath(file);if(!real.startsWith(await fs.realpath(webRoot)+path.sep))return json(403,{error:'FORBIDDEN'});
      const content=await fs.readFile(real);res.writeHead(200,{'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:content);
    }catch(e){json(e.code==='ENOENT'?404:500,{error:e.code==='ENOENT'?'NOT_FOUND':'INTERNAL_ERROR'});}
  });
  return {server,tools,agent,clock,panel};
}
if(require.main===module){const port=Number(process.env.PORT)||4173;const host=process.env.PORT?'0.0.0.0':'127.0.0.1';createApp().server.listen(port,host,()=>console.log(`权衡：http://${host}:${port}`));}
module.exports={createApp};
