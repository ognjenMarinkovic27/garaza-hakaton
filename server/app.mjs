import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDatabase, USERS } from './db.mjs';
import { evaluateSubmission, evaluationConfig } from './evaluate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = resolve(root, 'public');
const mime = { '.json':'application/json; charset=utf-8', '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf' };
class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
function json(res,status,value) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
async function body(req) {
  let size=0; const chunks=[];
  for await(const chunk of req) { size+=chunk.length; if(size>100000) throw new HttpError(413,'Submission is too large. Keep it below 100 KB.'); chunks.push(chunk); }
  try { const result=JSON.parse(Buffer.concat(chunks).toString()); if(!result || typeof result!=='object' || Array.isArray(result)) throw new Error(); return result; }
  catch { throw new HttpError(400,'Send a valid JSON object.'); }
}
function field(value,name,min,max) { if(typeof value!=='string'||value.trim().length<min||value.trim().length>max) throw new HttpError(400,`${name} must contain ${min}–${max} characters.`); return value.trim(); }
function numeric(value,name,min,max,integer=false) { const n=Number(value); if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n))) throw new HttpError(400,`${name} must be ${integer?'a whole number ':''}between ${min} and ${max}.`); return n; }
function roleFor(req) { return /(?:^|;\s*)proof_role=buyer(?:;|$)/.test(req.headers.cookie||'')?'buyer':'expert'; }
function requireRole(role,expected) { if(role!==expected) throw new HttpError(403,`Switch to the ${expected} account to do this.`); }
function contractInput(input) {
  const requirements=Array.isArray(input.requirements)?input.requirements:typeof input.requirements==='string'?input.requirements.split('\n'):[];
  if(!requirements.length||requirements.length>20) throw new HttpError(400,'Add between 1 and 20 requirements.');
  const deadline=field(input.deadline,'Deadline',10,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(deadline)||!Number.isFinite(Date.parse(deadline))||deadline<new Date().toISOString().slice(0,10)) throw new HttpError(400,'Choose a deadline today or later.');
  const reward=numeric(input.reward,'Reward',1,100000); const budget=numeric(input.budget,'Budget',reward,10000000);
  return {title:field(input.title,'Title',5,150),domain:field(input.domain,'Domain',2,60),difficulty:field(input.difficulty,'Difficulty',2,60),description:field(input.description,'Description',20,5000),requirements:requirements.map(r=>field(r,'Requirement',5,1000)),reward,budget,target:numeric(input.target,'Target',1,100000,true),deadline};
}

export function createApp({dataDir=process.env.DATA_DIR||resolve(root,'data'),evaluator=evaluateSubmission}={}) {
  const db=openDatabase(dataDir);
  // Serial evaluation preserves budget invariants across simultaneous requests.
  let queue=Promise.resolve();
  function evaluate(record) {
    const task=queue.then(async()=> {
      const contract=db.contract(record.contractId);
      try {
        const result=await evaluator({problem:record.problem,answer:record.answer,solution:record.solution,contract,onProgress: evaluation => db.saveSubmission({...record,evaluation})});
        if(!result||!['accepted','rejected','needs_revision'].includes(result.status)) throw new Error('Evaluator returned an invalid result.');
        const accepted=db.submissions().filter(s=>s.contractId===contract.id&&s.id!==record.id&&s.status==='accepted');
        const spent=accepted.reduce((sum,s)=>sum+s.payout,0);
        const requested=Number(contract.reward);
        let status=result.status;
        let payout=status==='accepted'?requested:0;
        if(status==='accepted'&&(accepted.length>=contract.target||payout>contract.budget-spent+0.001)) {status='needs_revision';payout=0;result.allocationReason='This contract has reached its target or available budget. No payout was assigned.';}
        const saved={...record,status,payout,evaluation:{...result,status,payout},error:null};
        db.saveSubmission(saved); return saved;
      } catch(error) { return db.saveSubmission({...record,status:'error',payout:0,evaluation:db.submission(record.id)?.evaluation || null,error:error.message||'Evaluation failed. Please retry.'}); }
    });
    queue=task.catch(()=>{}); return task;
  }
  const server=http.createServer(async(req,res)=> {
    try {
      const url=new URL(req.url,'http://localhost'); const role=roleFor(req);
      if(req.method==='GET'&&url.pathname==='/api/state') return json(res,200,{role,user:USERS[role],contracts:db.contracts(),submissions:db.submissions(),evaluator:evaluationConfig()});
      if(req.method==='POST') {
        // The app uses deliberately mocked identities, but avoid accidental cross-origin writes.
        if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host) throw new HttpError(403,'Cross-origin writes are not allowed.');
        const input=await body(req);
        if(url.pathname==='/api/session') {
          if(!['expert','buyer'].includes(input.role)) throw new HttpError(400,'Choose expert or buyer.');
          res.setHeader('Set-Cookie',`proof_role=${input.role}; Path=/; HttpOnly; SameSite=Lax`);
          return json(res,200,{role:input.role,user:USERS[input.role]});
        }
        if(url.pathname==='/api/contracts') {
          requireRole(role,'buyer');
          const contract={...contractInput(input),id:randomUUID(),buyer:USERS.buyer.organization,status:'open',createdAt:new Date().toISOString()};
          return json(res,201,db.saveContract(contract));
        }
        if(url.pathname==='/api/submissions') {
          requireRole(role,'expert'); const contract=db.contract(input.contractId);
          if(!contract) throw new HttpError(404,'Contract not found.');
          const accepted=db.submissions().filter(s=>s.contractId===contract.id&&s.status==='accepted');
          if(contract.deadline<new Date().toISOString().slice(0,10)||accepted.length>=contract.target||accepted.reduce((sum,s)=>sum+s.payout,0)>=contract.budget) throw new HttpError(409,'This contract is no longer accepting submissions.');
          const record={id:randomUUID(),contractId:contract.id,title:field(input.title,'Title',5,150),problem:field(input.problem,'Problem',20,12000),answer:field(input.answer,'Answer',1,3000),solution:field(input.solution,'Solution',30,20000),expert:USERS.expert.name,status:'evaluating',createdAt:new Date().toISOString(),evaluation:null,payout:0};
          db.saveSubmission(record);
          const task=evaluate(record);
          return json(res,url.searchParams.has('background')?202:201,url.searchParams.has('background')?record:await task);
        }
        const retry=url.pathname.match(/^\/api\/submissions\/([^/]+)\/retry$/);
        if(retry) {
          requireRole(role,'expert'); const record=db.submission(retry[1]);
          if(!record) throw new HttpError(404,'Submission not found.');
          if(record.expert!==USERS.expert.name) throw new HttpError(403,'You can only retry your own submissions.');
          if(record.status!=='error') throw new HttpError(409,'Only failed evaluations can be retried.');
          if(db.contract(record.contractId).deadline<new Date().toISOString().slice(0,10)) throw new HttpError(409,'The contract deadline has passed.');
          const pending={...record,status:'evaluating',error:null}; db.saveSubmission(pending);
          const task=evaluate(pending);
          return json(res,url.searchParams.has('background')?202:200,url.searchParams.has('background')?pending:await task);
        }
      }
      if(url.pathname.startsWith('/api/')) throw new HttpError(404,'API route not found.');
      if(!['GET','HEAD'].includes(req.method)) throw new HttpError(405,'Method not allowed.');
      let decoded; try { decoded=decodeURIComponent(url.pathname); } catch { throw new HttpError(400,'Invalid URL.'); }
      const file=resolve(publicRoot,decoded==='/'?'index.html':`.${decoded}`);
      if(!file.startsWith(publicRoot+sep)) throw new HttpError(403,'Invalid asset path.');
      let content; try { content=await readFile(file); } catch { throw new HttpError(404,'Page not found.'); }
      res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'}); res.end(req.method==='HEAD'?undefined:content);
    } catch(error) { if(!res.headersSent) json(res,error.status||500,{error:error.status?error.message:'Something went wrong. Please try again.'}); else res.end(); }
  });
  server.on('close',()=>db.close());
  return server;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||3000); const host=process.env.HOST||'127.0.0.1';
  const server=createApp(); server.listen(port,host,()=>console.log(`Ivogma running at http://${host}:${port}`));
}
