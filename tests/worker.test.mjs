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
 assert.equal((await send(env,'/api/runs',{...task,duration_s:30},h)).status,400);
 assert.equal((await send(env,'/api/runs',{...task,name:'a'.repeat(33)},h)).status,400);
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

// These are synthetic recording-index rows. No model, robot or media request occurs.
async function completedRun(env,episode='ep_offline_recording'){
 const auth={Authorization:'Bearer '+env.RUNNER_TOKEN};await send(env,'/api/runner/heartbeat',{ready:true},auth);
 const {data:{csrf}}=await send(env,'/api/browser');const h={Origin:url,Cookie:'kinex-owner='+csrf,'X-Kinex-CSRF':csrf};
 const {data:{id}}=await send(env,'/api/runs',{name:'Offline fixture',email:'fixture@example.test',prompt:'Synthetic recording fixture; no robot',duration_s:60},h);
 await send(env,'/api/runner/claim',{},auth);
 await send(env,'/api/runner/update',{id,status:'completed',episode_id:episode,configuration:{model:'Kinex'},metrics:{motion_started_at:123}},auth);
 return {id,auth,episode};
}
function ageLookup(env,id){return env.DB.prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.recording.checked_at',0) WHERE id=?").bind(id).run()}
test('recording lookup matches exact episode, approach and station; pending becomes ready without dispatch',async()=>{
 const env=environment(),{id,episode,auth}=await completedRun(env);const original=globalThis.fetch;let requests=[];
 const video='https://playground.blupe.io/api/quick-replays/'+episode+'/'+'a'.repeat(64)+'.mp4';
 try{
  globalThis.fetch=async(input)=>{requests.push(String(input));return Response.json({runs:[{episode_id:'ep_some_other_run',robot_id:'robot-ba8413962083809c',model:'Kinex',video_url:video}]})};
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'processing');
  assert.equal(requests.length,1);await ageLookup(env,id);
  globalThis.fetch=async(input)=>{requests.push(String(input));return Response.json({runs:[{episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Other approach',video_url:video}]})};
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'waiting_for_attribution');await ageLookup(env,id);
  globalThis.fetch=async(input)=>{requests.push(String(input));return Response.json({runs:[{episode_id:episode,robot_id:'other',model:'Kinex',video_url:video}]})};
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'waiting_for_attribution');await ageLookup(env,id);
  globalThis.fetch=async(input)=>{requests.push(String(input));return Response.json({runs:[{episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Kinex',video_url:video,preview_speed:10,video_duration_s:6}]})};
  const replay=await send(env,'/api/runs/'+id+'/replay');assert.equal(replay.data.state,'ready');assert.equal(replay.data.url,video);assert.equal(replay.data.preview_speed,10);
  assert(requests.every(r=>r==='https://playground.blupe.io/api/past-runs?robot_id=robot-ba8413962083809c&episode_id='+episode));
  const count=requests.length;await send(env,'/api/runs/'+id+'/replay');assert.equal(requests.length,count);
  await send(env,'/api/runner/update',{id,status:'failed',error:'Synthetic cleanup error'},auth);
  const row=(await send(env,'/api/state')).data.runs[0];assert.equal(row.episode_id,episode);assert.equal(row.replay,video);assert.equal(row.configuration.model,'Kinex');assert.equal(row.metrics.motion_started_at,123);
  assert.equal((await send(env,'/api/runner/update',{id,status:'failed',episode_id:'ep_changed'},auth)).status,409);
 }finally{globalThis.fetch=original}
});
test('recordings reject untrusted URLs and recover honestly from index failure',async()=>{
 const env=environment(),{id,episode}=await completedRun(env);const original=globalThis.fetch;
 try{
  for(const video_url of ['https://unrelated.example.test/movie.mp4','https://playground.blupe.io/api/quick-replays/ep_wrong/'+'b'.repeat(64)+'.mp4','javascript:alert(1)','https://user:pass@huggingface.co/datasets/andlyu/Public-YAM-runs/resolve/main/other.mp4']){
   globalThis.fetch=async()=>Response.json({runs:[{episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Kinex',video_url}]});
   assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'processing');await ageLookup(env,id);
  }
  globalThis.fetch=async()=>{throw new Error('Synthetic index outage')};
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'temporarily_unavailable');
  assert.equal((await send(env,'/api/state')).data.runs[0].replay,null);
  const empty=await completedRun(env,'');let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Must not fetch')};
  assert.equal((await send(env,'/api/runs/'+empty.id+'/replay')).data.state,'unavailable');assert.equal(calls,0);
 }finally{globalThis.fetch=original}
});

test('unavailable results persist check time and cached/raw replay cannot bypass attribution or URL checks',async()=>{
 const env=environment(),{id,episode,auth}=await completedRun(env);const original=globalThis.fetch;let calls=0;
 try{
  const bad='https://untrusted.example.test/movie.mp4';
  assert.equal((await send(env,'/api/runner/update',{id,status:'completed',replay:bad},auth)).status,400);
  await env.DB.prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.replay',?,'$.recording',json(?),'$.configuration.model','Other') WHERE id=?").bind(bad,JSON.stringify({state:'ready',url:bad,episode_id:episode,model:'Kinex',robot_id:'robot-ba8413962083809c'}),id).run();
  assert.equal((await send(env,'/api/state')).data.runs[0].replay,null);
  globalThis.fetch=async()=>{calls++;throw new Error('Must not request unattributed episode')};
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'unavailable');
  const row=(await send(env,'/api/state')).data.runs[0];assert(row.recording.checked_at>0);assert.equal(row.replay,null);assert.equal(calls,0);
  await send(env,'/api/runs/'+id+'/replay');assert.equal(calls,0);
  const invalid=await completedRun(env,'not-an-episode');assert.equal((await send(env,'/api/runs/'+invalid.id+'/replay')).data.state,'unavailable');
  assert((await send(env,'/api/state')).data.runs.find(r=>r.id===invalid.id).recording.checked_at>0);
 }finally{globalThis.fetch=original}
});
test('overlapping recording lookups cannot replace ready footage with an older pending result',async()=>{
 const env=environment(),{id,episode}=await completedRun(env);const original=globalThis.fetch;let release,entered;
 const started=new Promise(r=>entered=r),pending=new Promise(r=>release=r);let count=0;
 const video='https://huggingface.co/datasets/andlyu/Public-YAM-runs/resolve/main/viewing/'+episode+'.mp4';
 try{
  globalThis.fetch=async()=>{if(count++===0){entered();await pending;return Response.json({runs:[]})}return Response.json({runs:[{episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Kinex',video_url:video}]})};
  const older=send(env,'/api/runs/'+id+'/replay');await started;
  assert.equal((await send(env,'/api/runs/'+id+'/replay')).data.state,'ready');release();
  assert.equal((await older).data.state,'ready');assert.equal((await send(env,'/api/state')).data.runs[0].replay,video);
 }finally{release?.();globalThis.fetch=original}
});
test('a recording resolved after runner snapshot read survives the atomic partial update',async()=>{
 const env=environment(),{id,episode,auth}=await completedRun(env);const originalFetch=globalThis.fetch,prepare=env.DB.prepare;let intercept=true;
 const video='https://playground.blupe.io/api/quick-replays/'+episode+'/'+'c'.repeat(64)+'.mp4';
 try{
  globalThis.fetch=async()=>Response.json({runs:[{episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Kinex',video_url:video}]});
  env.DB.prepare=function(sql){const statement=prepare.call(this,sql);if(sql==='SELECT snapshot FROM runs WHERE id=?'&&intercept){const first=statement.first;statement.first=async function(){const value=await first.call(this);intercept=false;await send(env,'/api/runs/'+id+'/replay');return value}}return statement};
  assert.equal((await send(env,'/api/runner/update',{id,status:'failed',error:'Synthetic cleanup failure',episode_id:null},auth)).status,200);
  const row=(await send(env,'/api/state')).data.runs[0];assert.equal(row.replay,video);assert.equal(row.episode_id,episode);assert.equal(row.error,'Synthetic cleanup failure');
 }finally{env.DB.prepare=prepare;globalThis.fetch=originalFetch}
});
