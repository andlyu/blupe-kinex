import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';import worker from '../worker/index.js';
function environment(){const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../drizzle/0000_kinex.sql',import.meta.url),'utf8'));return {RUNNER_TOKEN:'offline-fixture-only',DB:{prepare(sql){let args=[];const stmt=db.prepare(sql);return{bind(...values){args=values;return this},async first(){return stmt.get(...args)||null},async all(){return{results:stmt.all(...args)}},async run(){return stmt.run(...args)}}}}}}
const url='https://kinex.example.test';
function req(path,data,headers={}){return new Request(url+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(data?{body:JSON.stringify(data)}:{})})}
async function send(env,path,data,headers){const response=await worker.fetch(req(path,data,headers),env);return{status:response.status,data:await response.json(),headers:response.headers}}
test('origin/CSRF, one active run, claim once, owner Stop, and public email redaction',async()=>{
 const env=environment(),auth={Authorization:'Bearer '+env.RUNNER_TOKEN};
 assert.equal((await send(env,'/api/runner/claim',{})).status,401);
 const browser=await send(env,'/api/browser');const token=browser.data.csrf;const h={Origin:url,Cookie:'kinex-owner='+token,'X-Kinex-CSRF':token};
 const task={name:'Offline fixture',email:'fixture@example.test',prompt:'Offline protocol check; no robot worker',duration_s:60};
 assert.equal((await send(env,'/api/runs',task)).status,403);
 assert.equal((await send(env,'/api/runs',task,h)).status,503);
 assert.equal((await send(env,'/api/runner/heartbeat',{ready:true,message:'Synthetic offline fixture'},auth)).status,200);
 assert.equal((await send(env,'/api/runs',{...task,name:'Anonymous'},h)).status,400);
 const requestId='12345678-1234-4234-8234-123456789abc';const first=await send(env,'/api/runs',{...task,request_id:requestId},h);assert.equal(first.status,201);const id=first.data.id;assert.equal(id,requestId);
 assert.equal((await send(env,'/api/runs',task,h)).status,409);
 const publicState=await send(env,'/api/state');assert(!JSON.stringify(publicState.data).includes(task.email));assert(!JSON.stringify(publicState.data).includes(token));assert.equal(publicState.data.runs[0].owned,false);assert.equal((await send(env,'/api/state',undefined,h)).data.runs[0].owned,true);
 const claim=await send(env,'/api/runner/claim',{},auth);assert.equal(claim.data.run.id,id);assert.equal(claim.data.run.email,task.email);
 assert.equal((await send(env,'/api/runner/claim',{},auth)).data.run,null);
 assert.equal((await send(env,'/api/runs/'+id+'/stop',{}, {...h,Cookie:'kinex-owner='+'b'.repeat(64),'X-Kinex-CSRF':'b'.repeat(64)})).status,403);
 assert.equal((await send(env,'/api/runs/'+id+'/stop',{},h)).status,200);
 const update=await send(env,'/api/runner/update',{id,status:'running',stage:'Offline fixture'},auth);assert.equal(update.data.stop,true);
 assert.equal((await send(env,'/api/runner/update',{id,status:'stopped'},auth)).status,200);
 assert.equal((await send(env,'/api/runs',task,h)).status,201);
});
test('queued cancellation cannot be claimed or revived',async()=>{
 const env=environment(),auth={Authorization:'Bearer '+env.RUNNER_TOKEN};await send(env,'/api/runner/heartbeat',{ready:true},auth);
 const {data:{csrf}}=await send(env,'/api/browser');const h={Origin:url,Cookie:'kinex-owner='+csrf,'X-Kinex-CSRF':csrf};
 const {data:{id}}=await send(env,'/api/runs',{name:'Offline fixture',email:'fixture@example.test',prompt:'Protocol only',duration_s:60},h);
 await send(env,'/api/runs/'+id+'/stop',{},h);assert.equal((await send(env,'/api/runner/claim',{},auth)).data.run,null);
 await send(env,'/api/runner/update',{id,status:'running'},auth);assert.equal((await send(env,'/api/state')).data.runs[0].status,'cancelled');
});
