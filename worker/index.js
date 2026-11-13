const TERMINAL=new Set(['completed','failed','stopped','timed_out','cancelled']);
const json=(v,s=200,h={})=>Response.json(v,{status:s,headers:{'Cache-Control':'no-store',...h}});
const cookie=r=>(r.headers.get('Cookie')||'').match(/(?:^|; )kinex-owner=([a-f0-9]{64})(?:;|$)/)?.[1];
const random=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
const publicRun=r=>{if(!r)return null;const snapshot=JSON.parse(r.snapshot),local=localRecording(snapshot,r.id);return{id:r.id,runner:r.runner_name,prompt:r.prompt,duration_s:r.duration_s,status:r.status,created_at:r.created_at,updated_at:r.updated_at,stop_requested:!!r.stop_requested,...snapshot,...(local?{recording:localPlayback(local),recording_capture:{state:'ready',reason:'Retained camera replay is ready.'}}:{}),replay:approvedReplay(snapshot,r.id)}};
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
async function body(r){const text=await r.text();if(text.length>200000)fail('Request too large',413);try{return JSON.parse(text)}catch{fail('Invalid JSON')}}
function owner(r){if(r.headers.get('Origin')!==new URL(r.url).origin||!cookie(r)||r.headers.get('X-Kinex-CSRF')!==cookie(r))fail('Reload this page before submitting a run',403);return cookie(r)}
async function agent(r,env){if(!env.RUNNER_TOKEN)fail('Runner not configured',503);const hash=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));const a=await hash(r.headers.get('Authorization')||''),b=await hash('Bearer '+env.RUNNER_TOKEN);let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];if(d)fail('Runner authentication failed',401)}
function recordingUrl(value,episode){
 if(typeof value!=='string'||value.length>2048)return null;
 let u;try{u=new URL(value,'https://playground.blupe.io')}catch{return null}
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)return null;
 const quick=new RegExp('^/api/quick-replays/'+episode+'/[a-f0-9]{64}\\.mp4$');
 if(u.origin==='https://playground.blupe.io'&&quick.test(u.pathname))return u.href;
 if(u.origin==='https://huggingface.co'&&u.pathname.startsWith('/datasets/andlyu/Public-YAM-runs/resolve/main/')&&u.pathname.endsWith('/'+episode+'.mp4'))return u.href;
 return null;
}
function approvedReplay(saved,id){
 const local=localRecording(saved,id);if(local)return '/api/runs/'+id+'/video';
 const r=saved.recording,episode=saved.episode_id;
 return /^ep_[A-Za-z0-9_-]{1,100}$/.test(episode||'')&&saved.configuration?.model==='Kinex'&&r?.state==='ready'&&r.episode_id===episode&&r.model==='Kinex'&&r.robot_id==='robot-ba8413962083809c'&&r.url===saved.replay?recordingUrl(saved.replay,episode):null;
}
async function resolveRecording(env,id){
 const run=await env.DB.prepare('SELECT snapshot,runner_name,prompt FROM runs WHERE id=?').bind(id).first();if(!run)fail('Run not found',404);
 const saved=JSON.parse(run.snapshot),episode=saved.episode_id,ready=approvedReplay(saved,id);
 if(ready)return localRecording(saved,id)?localPlayback(localRecording(saved,id)):{...saved.recording,state:'ready',url:ready};
 if(saved.recording?.state!=='ready'&&saved.recording?.checked_at&&Date.now()-saved.recording.checked_at<3000)return saved.recording;
 let result={state:'processing',reason:'The robot recording is not yet available in the public index.',checked_at:Date.now()};
 if(!/^ep_[A-Za-z0-9_-]{1,100}$/.test(episode||''))result={...result,state:'unavailable',reason:'No robot episode has been recorded for this run.'};
 else if(saved.configuration?.model!=='Kinex')result={...result,state:'unavailable',reason:'Kinex attribution is not recorded for this episode.'};
 else try{
  const response=await fetch('https://playground.blupe.io/api/past-runs?robot_id=robot-ba8413962083809c&episode_id='+encodeURIComponent(episode),{signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('Recording index unavailable');
  const catalog=await response.json(),row=catalog.runs?.find(r=>r.episode_id===episode);
  if(row){
   let method=row.model==='Kinex',attribution_source='recording_index';
   if(row.robot_id==='robot-ba8413962083809c'&&row.model==null){
    const response=await fetch('https://yam-session-api.n5hthc3gj4cqy.us-east-1.cs.amazonlightsail.com/v1/queue?robot_id=robot-ba8413962083809c',{signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Run context temporarily unavailable');
    const actual=(await response.json()).public_run;
    method=actual?.run_id===episode&&actual.robot_id==='robot-ba8413962083809c'&&actual.model_name==='Kinex'&&actual.runner_name===run.runner_name&&actual.task===run.prompt;
    attribution_source='matched_live_queue_context';
   }
   if(row.robot_id!=='robot-ba8413962083809c'||!method)result={...result,state:'waiting_for_attribution',reason:'Waiting for matching Robo-house YAM and Kinex recording attribution.'};
   else {const video=recordingUrl(row.video_url,episode);if(video)result={state:'ready',url:video,checked_at:Date.now(),episode_id:episode,robot_id:'robot-ba8413962083809c',model:'Kinex',recording_index_model:row.model??null,attribution_source,preview_speed:Number.isFinite(row.preview_speed)?row.preview_speed:1,duration_s:Number.isFinite(row.video_duration_s)?row.video_duration_s:null};}
  }
 }catch{result={...result,state:'temporarily_unavailable',reason:'Recording lookup is unavailable. It will be checked again without rerunning the robot.'}}
 // A ready result wins. A non-ready result may only replace the version it read.
 // This prevents an overlapping old lookup from erasing a recovered recording.
 await env.DB.prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.recording',json(?),'$.replay',?) WHERE id=? AND json_extract(snapshot,'$.episode_id') IS ? AND (?='ready' OR (json_extract(snapshot,'$.recording') IS json(?) AND json_extract(snapshot,'$.replay') IS ?))").bind(JSON.stringify(result),result.state==='ready'?result.url:null,id,episode??null,result.state,saved.recording==null?null:JSON.stringify(saved.recording),saved.replay??null).run();
 const latest=JSON.parse((await env.DB.prepare('SELECT snapshot FROM runs WHERE id=?').bind(id).first()).snapshot);
 return localRecording(latest,id)?localPlayback(localRecording(latest,id)):approvedReplay(latest,id)?{...latest.recording,state:'ready',url:approvedReplay(latest,id)}:latest.recording||result;
}
function localRecording(saved,id){
 const r=saved.local_recording;
 if(!r||typeof r.session_id!=='string'||!r.session_id||saved.configuration?.model!=='Kinex'||r.run_id!==id||r.episode_id!==saved.episode_id||r.session_id!==saved.session_id||r.model!=='Kinex'||r.robot_id!=='robot-ba8413962083809c'||r.source!=='worker_top_camera'||!/^[a-f0-9]{64}$/.test(r.sha256)||!Number.isSafeInteger(r.bytes)||r.bytes<12||r.bytes>16*1024*1024||r.object_key!=='kinex/'+id+'/'+r.episode_id+'/'+r.sha256+'.mp4')return null;
 return r;
}
function localPlayback(r){return {state:'ready',url:'/api/runs/'+r.run_id+'/video',source:r.source,episode_id:r.episode_id,robot_id:r.robot_id,model:r.model,duration_s:r.duration_s,preview_speed:1,capture_fps:r.capture_fps,capture_partial:r.capture_partial,sample_count:r.sample_count,ready_at:r.ready_at}}
async function boundedVideo(request){
 const limit=16*1024*1024,length=Number(request.headers.get('Content-Length'));
 if(!Number.isSafeInteger(length)||length<12||length>limit)fail('Recording must be12 bytes to16MiB',413);
 const reader=request.body?.getReader();if(!reader)fail('Recording body missing');const parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit||size>length){await reader.cancel();fail('Recording exceeds declared limit',413)}parts.push(value)}}finally{reader.releaseLock()}
 if(size!==length)fail('Recording length mismatch');const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength}
 if(new TextDecoder().decode(bytes.subarray(4,8))!=='ftyp')fail('Recording must be an MP4');return bytes;
}
async function retainRecording(request,env,id){
 if(!env.BUCKET)fail('Retained recording storage is unavailable',503);
 if(request.headers.get('Content-Type')!=='video/mp4')fail('Recording must be video/mp4');
 const header=request.headers.get('X-Kinex-Recording')||'';if(header.length>4096)fail('Recording metadata too large');let meta;try{meta=JSON.parse(header)}catch{fail('Recording metadata invalid')}
 if(!meta||typeof meta!=='object'||Array.isArray(meta))fail('Recording metadata invalid');
 const row=await env.DB.prepare('SELECT snapshot FROM runs WHERE id=?').bind(id).first();if(!row)fail('Run not found',404);const saved=JSON.parse(row.snapshot);
 const number=(v,lo,hi)=>typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi;
 if(typeof saved.session_id!=='string'||!saved.session_id||typeof meta.session_id!=='string'||!meta.session_id||saved.configuration?.model!=='Kinex'||meta.model!=='Kinex'||meta.robot_id!=='robot-ba8413962083809c'||meta.episode_id!==saved.episode_id||meta.session_id!==saved.session_id||!/^ep_[A-Za-z0-9_-]{1,100}$/.test(meta.episode_id||'')||!/^[a-f0-9]{64}$/.test(meta.sha256||''))fail('Recording does not match the Kinex run',409);
 if(!number(meta.duration_s,.1,610)||!number(meta.first_capture_at,1,Date.now()/1000+1)||!number(meta.last_capture_at,meta.first_capture_at,Date.now()/1000+1)||!number(meta.started_at,1,meta.first_capture_at+1)||!number(meta.ended_at,meta.last_capture_at,Date.now()/1000+1)||Math.abs(meta.duration_s-(meta.last_capture_at-meta.first_capture_at+.5))>.1||!Number.isSafeInteger(meta.sample_count)||meta.sample_count<2||meta.sample_count>1220||meta.capture_fps!==2||typeof meta.capture_partial!=='boolean')fail('Recording timeline invalid');
 const bytes=await boundedVideo(request),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==meta.sha256||bytes.byteLength!==meta.bytes)fail('Recording digest or size mismatch');
 const key='kinex/'+id+'/'+meta.episode_id+'/'+digest+'.mp4';
 await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:'video/mp4'},customMetadata:{sha256:digest,episode_id:meta.episode_id,model:'Kinex'}});
 const recording={run_id:id,episode_id:meta.episode_id,session_id:meta.session_id,model:'Kinex',robot_id:meta.robot_id,source:'worker_top_camera',object_key:key,sha256:digest,bytes:bytes.byteLength,duration_s:meta.duration_s,capture_fps:2,capture_partial:meta.capture_partial,sample_count:meta.sample_count,first_capture_at:meta.first_capture_at,last_capture_at:meta.last_capture_at,started_at:meta.started_at,ended_at:meta.ended_at,ready_at:Date.now()};
 const committed=await env.DB.prepare("UPDATE runs SET snapshot=json_set(snapshot,'$.local_recording',json(?)) WHERE id=? AND json_extract(snapshot,'$.episode_id')=? AND json_extract(snapshot,'$.session_id')=? AND json_extract(snapshot,'$.configuration.model')='Kinex'").bind(JSON.stringify(recording),id,meta.episode_id,meta.session_id).run();
 if((committed.meta?.changes??committed.changes)!==1)fail('Recording attribution changed before retention completed',409);
 return json({ok:true,recording:localPlayback(recording)});
}
async function serveLocalRecording(request,env,r){
 if(!env.BUCKET)fail('Retained recording storage is unavailable',503);
 const info=await env.BUCKET.head(r.object_key);if(!info||info.size!==r.bytes||info.customMetadata?.sha256!==r.sha256)fail('Retained recording is temporarily unavailable',503);
 const etag='"'+r.sha256+'"',headers={'Content-Type':'video/mp4','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes',ETag:etag};
 if(request.headers.get('If-None-Match')===etag)return new Response(null,{status:304,headers});
 let offset=0,length=r.bytes,status=200;const range=request.headers.get('Range'),ifRange=request.headers.get('If-Range');
 if(range&&(!ifRange||ifRange===etag)){
  const match=range.length<=80&&range.match(/^bytes=(\d*)-(\d*)$/);let end;
  if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+r.bytes}});
  if(match[1]){offset=Number(match[1]);end=match[2]?Math.min(Number(match[2]),r.bytes-1):r.bytes-1}
  else{const suffix=Number(match[2]);offset=Math.max(0,r.bytes-suffix);end=r.bytes-1}
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(end)||offset<0||offset>=r.bytes||end<offset)return new Response(null,{status:416,headers:{...headers,'Content-Range':'bytes */'+r.bytes}});
  length=end-offset+1;status=206;headers['Content-Range']='bytes '+offset+'-'+end+'/'+r.bytes;
 }
 headers['Content-Length']=String(length);
 if(request.method==='HEAD')return new Response(null,{status,headers});
 const object=await env.BUCKET.get(r.object_key,{range:{offset,length}});if(!object?.body)fail('Retained recording is temporarily unavailable',503);
 return new Response(object.body,{status,headers});
}
async function serveRecording(request,env,id){
 const row=await env.DB.prepare('SELECT snapshot FROM runs WHERE id=?').bind(id).first();if(!row)fail('Run not found',404);
 const saved=JSON.parse(row.snapshot),local=localRecording(saved,id);if(local)return serveLocalRecording(request,env,local);
 const source=approvedReplay(saved,id);if(!source)fail('A verified recording is not ready for this run',409);
 // Only retained, attributed URLs are eligible; this is not an arbitrary URL proxy.
 if(new URL(source).origin!=='https://playground.blupe.io')return Response.redirect(source,302);
 const range=request.headers.get('Range'),headers={'Accept':'video/mp4'};
 if(range){if(range.length>80||!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))fail('Unsupported video byte range',416);headers.Range=range}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);let upstream;
 try{upstream=await fetch(source,{method:request.method,headers,redirect:'manual',signal:controller.signal})}finally{clearTimeout(timer)}
 if(![200,206,304,416].includes(upstream.status))fail('Recording delivery is temporarily unavailable',502);
 if(upstream.status!==304&&upstream.status!==416&&!/^video\/mp4(?:;|$)/i.test(upstream.headers.get('Content-Type')||''))fail('Recording returned an unsupported media type',502);
 const output=new Headers({'Content-Type':'video/mp4','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});
 for(const key of ['Content-Length','Content-Range','ETag','Last-Modified'])if(upstream.headers.has(key))output.set(key,upstream.headers.get(key));
 return new Response(request.method==='HEAD'||upstream.status===304?null:upstream.body,{status:upstream.status,headers:output});
}
export default {async fetch(request,env){const path=new URL(request.url).pathname;try{
 if(path==='/'&&request.method==='GET')return new Response(PAGE,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https://playground.blupe.io https://huggingface.co https://*.huggingface.co https://*.hf.co; base-uri 'none'; frame-ancestors 'none'"}});
 if(path==='/api/browser'&&request.method==='GET'){const t=cookie(request)||random();return json({csrf:t},200,{'Set-Cookie':'kinex-owner='+t+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000'})}
 if(/^\/api\/cameras\/(top|left|right)$/.test(path)){const response=await fetch('https://yam-session-api.n5hthc3gj4cqy.us-east-1.cs.amazonlightsail.com/v1/robots/robot-ba8413962083809c/cameras/'+path.split('/').pop()+'.jpg');if(!response.ok)return json({error:'Live camera unavailable'},503);return new Response(response.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'no-store'}})}
 if(!env.DB)fail('Run storage is being configured. Refresh shortly.',503);
 if(path==='/api/state'&&request.method==='GET'){const s=await env.DB.prepare('SELECT * FROM runner WHERE id=1').first();const rows=await env.DB.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT 30').all();return json({approach:'Kinex',underlying_model:'gpt-6-astra',station:'robot-ba8413962083809c',runner:s?{...JSON.parse(s.status),online:Date.now()-s.heartbeat_at<15000}:{online:false,message:'Waiting for the Kinex worker'},runs:rows.results.map(r=>({...publicRun(r),owned:r.owner===cookie(request)}))})}
 if(/^\/api\/runs\/[a-f0-9-]+\/video$/.test(path)&&['GET','HEAD'].includes(request.method))return await serveRecording(request,env,path.split('/')[3]);
 if(/^\/api\/runs\/[a-f0-9-]+\/replay$/.test(path)&&request.method==='GET')return json(await resolveRecording(env,path.split('/')[3]));
 if(path==='/api/runs'&&request.method==='POST'){const identity=owner(request),d=await body(request);const name=String(d.name||'').trim(),email=String(d.email||'').trim(),prompt=String(d.prompt||'').trim();if(!name||name.length>32||/^(anonymous|automated|autonomous)$/i.test(name)||/[\x00-\x1f]/.test(name))fail('Enter the actual runner name');if(email.length>200||!/^\S+@\S+\.\S+$/.test(email))fail('Enter a valid email');if(!prompt||prompt.length>4000)fail('Enter a task up to 4,000 characters');if(!Number.isInteger(d.duration_s)||d.duration_s<60||d.duration_s>180)fail('Choose 60 to 180 seconds');const s=await env.DB.prepare('SELECT * FROM runner WHERE id=1').first();if(!s||Date.now()-s.heartbeat_at>15000||JSON.parse(s.status).ready!==true)fail('Kinex runner is not ready. See its status below Run.',503);if(d.request_id!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.request_id))fail('Invalid run request ID');const id=d.request_id||crypto.randomUUID(),now=Date.now();try{await env.DB.prepare("INSERT INTO runs(id,owner,runner_name,runner_email,prompt,duration_s,status,created_at,updated_at,active_slot) VALUES(?,?,?,?,?,?,'queued',?,?,1)").bind(id,identity,name,email,prompt,d.duration_s,now,now).run()}catch(e){if(String(e).includes('UNIQUE'))fail('A Kinex run is active. Wait for completion.',409);throw e}return json({id,status:'queued',message:'Submitted to Kinex; the runner will join the normal BluPe queue.'},201)}
 if(/^\/api\/runs\/[a-f0-9-]+\/stop$/.test(path)&&request.method==='POST'){const identity=owner(request),id=path.split('/')[3];const row=await env.DB.prepare('SELECT * FROM runs WHERE id=? AND owner=?').bind(id,identity).first();if(!row)fail('This browser does not own that run',403);if(row.status==='queued')await env.DB.prepare("UPDATE runs SET status='cancelled',active_slot=NULL,stop_requested=1,updated_at=? WHERE id=? AND status='queued'").bind(Date.now(),id).run();else await env.DB.prepare('UPDATE runs SET stop_requested=1,updated_at=? WHERE id=?').bind(Date.now(),id).run();return json({ok:true})}
 if(path.startsWith('/api/runner/')){await agent(request,env);
  if(/^\/api\/runner\/recordings\/[a-f0-9-]+$/.test(path)&&request.method==='POST')return await retainRecording(request,env,path.split('/')[4]);
  if(path==='/api/runner/heartbeat'&&request.method==='POST'){const d=await body(request);await env.DB.prepare('INSERT INTO runner(id,heartbeat_at,status) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at,status=excluded.status').bind(Date.now(),JSON.stringify(d)).run();return json({ok:true})}
  if(path==='/api/runner/claim'&&request.method==='POST'){const r=await env.DB.prepare("UPDATE runs SET status='preparing',updated_at=? WHERE id=(SELECT id FROM runs WHERE status='queued' AND stop_requested=0 ORDER BY created_at LIMIT 1) AND status='queued' RETURNING *").bind(Date.now()).first();return json({run:r?{id:r.id,name:r.runner_name,email:r.runner_email,prompt:r.prompt,duration_s:r.duration_s}:null})}
  if(path==='/api/runner/update'&&request.method==='POST'){const d=await body(request);if(!['preparing','queued_robot','running',...TERMINAL].includes(d.status))fail('Invalid status');const priorRow=await env.DB.prepare('SELECT snapshot FROM runs WHERE id=?').bind(d.id).first();if(!priorRow)fail('Run not found',404);const prior=JSON.parse(priorRow.snapshot);if(prior.episode_id&&d.episode_id&&prior.episode_id!==d.episode_id)fail('Run episode cannot change',409);if(d.publication_sequence!==undefined&&(!Number.isSafeInteger(d.publication_sequence)||d.publication_sequence<1))fail('Invalid publication sequence');if(d.replay!==undefined)fail('Recordings are resolved from the public index',400);const patch={};for(const key of ['episode_id','session_id','stage','message','configuration','metrics','error','queue_lifecycle','publication_sequence','recording_capture'])if(d[key]!==undefined&&(d[key]!==null||key==='error'))patch[key]=d[key];if(d.events!==undefined)patch.events=d.events.slice(-60);await env.DB.prepare("UPDATE runs SET status=?,updated_at=?,snapshot=json_patch(snapshot,?),active_slot=? WHERE id=? AND status!='cancelled' AND NOT(status IN ('completed','failed','stopped','timed_out') AND ?=1) AND ((json_extract(snapshot,'$.publication_sequence') IS NULL AND ? IS NULL) OR ? > COALESCE(json_extract(snapshot,'$.publication_sequence'),0))").bind(d.status,Date.now(),JSON.stringify(patch),TERMINAL.has(d.status)?null:1,d.id,TERMINAL.has(d.status)?0:1,d.publication_sequence??null,d.publication_sequence??null).run();const row=await env.DB.prepare('SELECT stop_requested FROM runs WHERE id=?').bind(d.id).first();return json({ok:true,stop:!!row?.stop_requested})}
 }
 return json({error:'Not found'},404);
}catch(e){return json({error:e.status?e.message:'Service request failed. Refresh and inspect runner status.'},e.status||500)}}};
const PAGE=String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Kinex × BluPe</title><meta name="description" content="Run Kinex robotics tools with Astra on real BluPe arms."><style>
:root{color-scheme:dark;--bg:#202124;--surface:#303134;--well:#141517;--text:#f1f3f4;--muted:#bdc1c6;--blue:#a8c7fa;--line:#494b50;font-family:Arial,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,textarea,select{font:inherit}button,a,input,select,textarea{outline-offset:4px}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--blue)}::selection{background:var(--blue);color:#062e6f}a{color:var(--blue);text-underline-offset:4px}header{min-height:76px;display:flex;align-items:center;justify-content:space-between;padding:16px 32px;gap:20px;border-bottom:1px solid var(--line)}h1{font-size:23px;letter-spacing:-.03em;margin:0;font-weight:600}h1 span{font-weight:400;color:var(--muted)}header p{margin:0;font-size:14px;color:var(--muted)}main{max-width:1600px;padding:24px 32px 48px;margin:auto}.workspace{display:grid;grid-template-columns:minmax(0,3fr) minmax(300px,1fr);gap:24px}.cameras{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-content:start}.camera{background:var(--well);border-radius:12px;overflow:hidden;position:relative;min-width:0;aspect-ratio:4/3}.camera.main{grid-column:1/-1;aspect-ratio:16/9}.camera img{width:100%;height:100%;object-fit:contain;display:block;opacity:0}.camera figcaption{position:absolute;left:12px;top:12px;padding:5px 8px;background:#202124dc;font-size:12px;border-radius:6px}.missing{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);padding:40px;text-align:center;font-size:14px}.missing[hidden]{display:none}figure{margin:0}.panel{min-width:0}h2{font-size:19px;line-height:1.3;font-weight:500;margin:0 0 16px}label{display:block;font-size:13px;color:var(--muted);margin:18px 0 7px}textarea,input,select{width:100%;border:1px solid #73767d;border-radius:8px;padding:11px 12px;background:var(--well);color:var(--text);caret-color:var(--blue)}textarea{resize:vertical;min-height:132px;line-height:1.5}.identity{display:grid;grid-template-columns:1fr 1fr;gap:12px}.identity input{min-width:0}.actions{display:flex;gap:12px;margin-top:20px}button{border:0;border-radius:24px;padding:12px 22px;min-height:46px;cursor:pointer;background:var(--blue);color:#062e6f;font-weight:600}button:hover{filter:brightness(1.1)}button:disabled{opacity:.5;cursor:not-allowed}button.stop{background:#b3261e;color:white}.status{margin:18px 0 24px;padding:16px;background:var(--surface);border-radius:12px;line-height:1.5;min-height:100px}.status strong{display:block;font-size:14px}.status p{font-size:13px;color:var(--muted);margin:6px 0 0}.notes{border-top:1px solid var(--line);padding-top:20px}.notes ol{padding:0;list-style:none;max-height:250px;overflow:auto;scrollbar-color:#73767d var(--surface)}.notes li{font-size:13px;line-height:1.5;padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.notes time{color:var(--muted);font-variant-numeric:tabular-nums;margin-right:8px}.detail{font-size:13px;line-height:1.6;color:var(--muted)}.runs{margin-top:40px;border-top:1px solid var(--line);padding-top:24px}.run{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;border-bottom:1px solid var(--line);padding:18px 0}.run h3{font-size:15px;line-height:1.5;margin:0 0 5px;font-weight:500}.run p{font-size:12px;color:var(--muted);margin:0;line-height:1.6}.run button{align-self:center;background:var(--surface);color:var(--text);font-size:13px;min-height:40px}.run .playback{grid-column:1/-1;min-width:0}.run video{grid-column:1/-1;width:100%;max-height:500px;background:var(--well)}details{margin-top:22px;font-size:13px;line-height:1.6;color:var(--muted)}summary{cursor:pointer;color:var(--text)}.empty{color:var(--muted);font-size:14px}.error{color:#ffb4ab}footer{margin-top:32px;font-size:12px;color:var(--muted);display:flex;gap:20px;flex-wrap:wrap}@media(max-width:850px){header{padding:16px 20px}header p{display:none}main{padding:20px}.workspace{grid-template-columns:1fr}.camera.main{aspect-ratio:4/3}.notes ol{max-height:180px}.status{min-height:0}.run{grid-template-columns:minmax(0,1fr)}.run button{justify-self:start}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style></head><body><header><h1>Kinex <span>× BluPe</span></h1><p>Robo-house YAM · Real hardware · Astra through Codex</p><a href="#runs">Past runs</a></header><main><div class="workspace"><section class="cameras" aria-label="Robot camera feeds"><figure class="camera main"><img data-camera="top" alt="Live overhead view of the physical Robo-house YAM robot"><span class="missing">Connecting to the overhead camera…</span><figcaption>Overhead · Camera feed</figcaption></figure><figure class="camera"><img data-camera="left" alt="Live left wrist camera"><span class="missing">Connecting to the left camera…</span><figcaption>Left wrist</figcaption></figure><figure class="camera"><img data-camera="right" alt="Live right wrist camera"><span class="missing">Connecting to the right camera…</span><figcaption>Right wrist</figcaption></figure></section><section class="panel"><h2>Give Kinex a task</h2><p class="detail">Astra uses Kinex device tools to observe and command the robot. Initial scope: bounded joint and gripper tools. Physical verification is pending.</p><form id="taskForm"><label for="prompt">Task</label><textarea id="prompt" required maxlength="4000">Read the cameras and both arms' measured joints. Move only the left wrist's sixth joint by 0.03 radians within its limits, verify completion, then return it to its original angle. Keep all other joints and grippers unchanged.</textarea><div class="identity"><div><label for="name">Your name</label><input id="name" autocomplete="name" required maxlength="32"></div><div><label for="email">Email · private</label><input id="email" type="email" autocomplete="email" required maxlength="200"></div></div><label for="duration">Run limit</label><select id="duration"><option value="60">1 minute</option><option value="120">2 minutes</option><option value="180">3 minutes</option></select><div class="actions"><button id="run" type="submit" disabled>Run Kinex</button><button id="stop" class="stop" type="button" disabled>Stop</button></div><div class="status" role="status" aria-live="polite"><strong id="stage">Connecting to Kinex</strong><p id="reason">Checking the runner before enabling Run.</p><p id="queueSummary" hidden></p><p id="recordingSummary" hidden></p></div></form><section class="notes"><h2>Kinex activity</h2><ol id="activity"><li>Actual tool calls and model messages will appear here during your run.</li></ol></section><details><summary>What is running?</summary><p>Model / approach: Kinex 1.0.0 native device tools. Agent host: Codex 0.162.1. Planning and vision: gpt-6-astra, low reasoning. The provider does not report an immutable resolved model version.</p><p>Supported: cameras, measured joint state, joint servo and normalized grippers. Cartesian goals, arbitrary Python and simultaneous actuator buffers are unavailable. Robot queue, lease, startup readiness, gateway limits, feedback and Stop remain enabled.</p><p>Runs, task text, runner name, results and recordings are public. Email stays private. A joint-motion test does not demonstrate pick-and-place.</p></details></section></div><section id="runs" class="runs"><h2>Past Kinex runs</h2><div id="history"><p class="empty">No runs have been recorded on this integration yet.</p></div></section><footer><a href="https://github.com/stacx-lab/kinex" target="_blank" rel="noopener">Kinex upstream</a><a href="https://github.com/andlyu/blupe-kinex" target="_blank" rel="noopener">Integration source</a><span id="lastUpdate">Waiting for the runner</span></footer></main><script>
const $=id=>document.getElementById(id);let csrf='',current='',data=null,actionNotice=null,replayCheckAt=0;
const openPlaybacks=new Map();
const active=s=>['queued','preparing','queued_robot','running'].includes(s);
for(const field of ['name','email']){try{$(field).value=localStorage.getItem('kinex-'+field)||''}catch{}}
async function request(path,method='GET',body){const response=await fetch(path,{method,headers:{'Content-Type':'application/json',...(method==='POST'?{'X-Kinex-CSRF':csrf}:{})},...(body?{body:JSON.stringify(body)}:{}),cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error||'Request failed');return value}
function status(title,reason,error=false){$('stage').textContent=title;$('reason').textContent=reason;$('reason').className=error?'error':''}
function actionStatus(title,reason,error=false,type='error',runId=current){actionNotice={title,reason,error,type,runId};status(title,reason,error)}
function render(state){data=state;const runs=state.runs||[],running=runs.find(r=>active(r.status)),ownActive=runs.find(r=>r.owned&&active(r.status));if(ownActive&&current!==ownActive.id){current=ownActive.id;sessionStorage.setItem('kinex-current',current)}const selected=ownActive||runs.find(r=>r.id===current)||running;
$('run').disabled=!!running||!state.runner.online||!state.runner.ready;$('stop').disabled=!selected?.owned||!active(selected.status)||selected.stop_requested;
if(selected&&active(selected.status)){status(selected.stage||selected.status,selected.stop_requested?'Stop requested; waiting for acknowledgement.':selected.message||'Kinex is preparing the run.');if(!state.runner.online)status('Runner connection interrupted','Last state retained. Do not resubmit an uncertain movement. Restore the runner connection.',true)}else if(selected?.error)status('Run stopped with an error',selected.error,true);else status(state.runner.ready&&state.runner.online?'Kinex ready':state.runner.online?(state.runner.stage||'Robot not ready'):'Kinex runner offline',state.runner.online?(state.runner.message||'Enter a task and confirm your identity, then Run.'):'Waiting for the Kinex worker. Live viewing remains available.');
if(actionNotice?.type==='submission_error'&&runs.some(r=>r.id===actionNotice.runId&&r.owned))actionNotice=null;if(actionNotice?.type==='stop_error'&&runs.some(r=>r.id===actionNotice.runId&&r.owned&&(r.stop_requested||!active(r.status))))actionNotice=null;if(actionNotice?.type==='submitted'&&selected&&selected.status!=='queued')actionNotice=null;if(actionNotice?.type==='stopping'&&selected&&(selected.stop_requested||!active(selected.status)))actionNotice=null;if(actionNotice)status(actionNotice.title,actionNotice.reason,actionNotice.error);else if(running&&!running.owned)status('Another run is active','You can watch this run. Only its owner can Stop it.');
const recordingRun=running||selected,recordingNote=recordingRun?.recording_capture;
$('recordingSummary').textContent=recordingNote?.reason||'';$('recordingSummary').hidden=!recordingNote?.reason;
const queue=recordingRun?.queue_lifecycle||{},stages=[];
const queueTime=value=>typeof value==='number'&&Number.isFinite(value)?new Date(value*1000).toLocaleTimeString():null;
if(queueTime(queue.entered_at))stages.push('Entered robot queue '+queueTime(queue.entered_at));
if(queueTime(queue.admitted_at))stages.push('Robot admitted '+queueTime(queue.admitted_at));
if(queueTime(queue.home_observed_at))stages.push('Startup Home verified '+queueTime(queue.home_observed_at));
$('queueSummary').textContent=stages.join(' · ');$('queueSummary').hidden=!stages.length;
$('lastUpdate').textContent=state.runner.online?'Kinex worker connected · Approach: Kinex · Underlying: Astra':'Kinex worker offline';
if(selected?.events?.length){$('activity').replaceChildren(...selected.events.slice(-20).map(e=>{const li=document.createElement('li'),t=document.createElement('time');t.textContent=new Date(e.time*1000).toLocaleTimeString();li.append(t,document.createTextNode(e.message));return li}))}
const signature=JSON.stringify(runs.map(r=>[r.id,r.status,r.replay,r.recording?.state,r.recording_capture]));
if($('history').dataset.signature===signature)return;
$('history').dataset.signature=signature;$('history').replaceChildren();
if(!runs.length){const p=document.createElement('p');p.className='empty';p.textContent='No runs have been recorded on this integration yet.';$('history').append(p)}
for(const run of runs){
 const row=document.createElement('article');row.className='run';
 const text=document.createElement('div'),h=document.createElement('h3'),p=document.createElement('p');
 h.textContent=run.prompt;p.textContent=run.runner+' · Kinex / Astra · '+run.status+' · '+new Date(run.created_at).toLocaleString();text.append(h,p);row.append(text);
 const opened=openPlaybacks.get(run.id);if(opened&&opened.url!==run.replay)openPlaybacks.delete(run.id);
 if(run.replay){
  const b=document.createElement('button');b.textContent=run.recording?.preview_speed>1?'Replay · '+run.recording.preview_speed+'× preview':'Replay';
  b.onclick=()=>{
   if(openPlaybacks.has(run.id))return;
   const box=document.createElement('div');box.className='playback';
   const v=document.createElement('video');v.controls=true;v.playsInline=true;v.preload='metadata';v.src='/api/runs/'+run.id+'/video';
   if(run.recording?.source==='worker_top_camera'){const note=document.createElement('p');note.textContent='Actual overhead camera · 2 fps samples · real time'+(run.recording.capture_partial?' · capture has gaps':'');box.append(note)}
   v.addEventListener('error',()=>{
    if(box.querySelector('.replay-error'))return;
    const p=document.createElement('p');p.className='replay-error error';p.textContent='This browser could not play the recording. ';
    const a=document.createElement('a');a.href=run.replay;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Open recording in another player';p.append(a);box.append(p)
   });
   box.append(v);openPlaybacks.set(run.id,{url:run.replay,element:box});row.append(box)
  };row.append(b)
 }else{const span=document.createElement('p');span.textContent=active(run.status)?'Run in progress':run.recording_capture?.reason||run.recording?.reason||(run.episode_id?'Recording is processing':'No robot episode recorded');row.append(span)}
 const playback=openPlaybacks.get(run.id);if(playback)row.append(playback.element);
 $('history').append(row)
}
for(const id of openPlaybacks.keys())if(!runs.some(r=>r.id===id))openPlaybacks.delete(id)
}
async function poll(){try{const state=await request('/api/state');render(state);const pending=state.runs.filter(r=>!active(r.status)&&r.episode_id&&!r.replay).sort((a,b)=>(a.recording?.checked_at||0)-(b.recording?.checked_at||0))[0];if(pending&&Date.now()-replayCheckAt>3000){replayCheckAt=Date.now();request('/api/runs/'+pending.id+'/replay').catch(()=>{})}}catch(e){status('Connection unavailable',e.message,true);$('run').disabled=true}setTimeout(poll,1000)}
$('taskForm').onsubmit=async event=>{event.preventDefault();const requestId=crypto.randomUUID();$('run').disabled=true;actionNotice=null;actionStatus('Submitting to Kinex','Connecting to the runner; robot queue and readiness checks follow.');for(const field of ['name','email']){try{localStorage.setItem('kinex-'+field,$(field).value)}catch{}}try{const run=await request('/api/runs','POST',{request_id:requestId,name:$('name').value,email:$('email').value,prompt:$('prompt').value,duration_s:Number($('duration').value)});current=run.id;sessionStorage.setItem('kinex-current',current);actionStatus('Submitted to Kinex',run.message,false,'submitted')}catch(e){actionStatus('Submission not confirmed',e.message+' Check the run list before submitting again.',true,'submission_error',requestId)}};
$('stop').onclick=async()=>{const id=current||(data?.runs||[]).find(r=>active(r.status))?.id;if(!id)return;$('stop').disabled=true;actionStatus('Stopping','Sending Stop and waiting for acknowledgement.',false,'stopping');try{await request('/api/runs/'+id+'/stop','POST',{})}catch(e){actionStatus('Stop acknowledgement unavailable',e.message+' Use the operator if the connection stays unavailable.',true,'stop_error',id)}};
for(const img of document.querySelectorAll('[data-camera]')){let last=0;const load=()=>{img.onload=()=>{img.style.opacity='1';last=Date.now();img.nextElementSibling.hidden=true;setTimeout(load,650)};img.onerror=()=>{img.style.opacity='0';img.nextElementSibling.hidden=false;img.nextElementSibling.textContent=last?'Camera interrupted; reconnecting…':'Live camera unavailable; reconnecting…';setTimeout(load,2000)};img.src='/api/cameras/'+img.dataset.camera+'?t='+Date.now()};load()}
request('/api/browser').then(session=>{csrf=session.csrf;current=sessionStorage.getItem('kinex-current')||'';poll()}).catch(e=>status('Page setup failed',e.message,true));
</script></body></html>`;
