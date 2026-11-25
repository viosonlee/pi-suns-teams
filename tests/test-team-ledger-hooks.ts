/** Real extension factory, offline host-hook tests. No provider/model calls. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig, newGoal } from '../extensions/team.ts';
const root=mkdtempSync(join(tmpdir(),'team-ledger-hooks-')); const original=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=root;
writeFileSync(join(root,'team.json'),JSON.stringify({maxConcurrent:2,sessionBudgetUSD:0.001,maxAutoRetries:1,goalMaxRounds:1,goalMaxStalls:1,roles:{bridges:{maxCalls:1,budgetUSD:0.001}},fallbacks:{}}));
let seq=0,passed=0;
function harness(seed?:any[],child=false) {
 const state=initialState(defaultConfig()); state.enabled=true; state.startedAt='2026-01-01'; state.goal=newGoal('Original goal',['Original acceptance']);
 let entries:any[]=seed??[{type:'custom',id:'seed',customType:'team-state',data:state}]; let branch=entries;
 if(child) entries.push({type:'custom',id:'child',customType:'pi-web:subagent',data:{parentSessionId:'parent'}});
 const hooks=new Map<string,Function[]>(),tools=new Map<string,any>(),commands=new Map<string,any>(),notes:string[]=[],prompts:string[]=[];
 const ctx:any={cwd:root,hasUI:true,isIdle:()=>true,sessionManager:{getEntries:()=>entries,getBranch:()=>branch,getSessionId:()=> 'parent',getSessionFile:()=>join(root,'parent.jsonl')},ui:{notify:(m:string)=>notes.push(m),setStatus(){}},model:{provider:'fixture',id:'unused'},modelRegistry:{find:()=>undefined}};
 const pi:any={on:(n:string,f:Function)=>hooks.set(n,[...(hooks.get(n)??[]),f]),registerFlag(){},getFlag:()=>false,registerTool:(t:any)=>tools.set(t.name,t),registerCommand:(n:string,c:any)=>commands.set(n,c),appendEntry:(t:string,data:any)=>{const e={type:'custom',id:`e${++seq}`,customType:t,data};entries.push(e);if(branch!==entries)branch.push(e);},getThinkingLevel:()=> 'high',sendMessage(){},sendUserMessage:async(m:string)=>prompts.push(m)};
 team(pi);
 return {ctx,tools,notes,prompts,entries:()=>entries,state:()=>[...branch].reverse().find(e=>e.customType==='team-state').data,
  async emit(name:string,event:any={}){let e=event;for(const f of hooks.get(name)??[]){const p=await f(e,ctx);if(p)e={...e,...p};}return e;},
  async start(){await this.emit('session_start',{reason:'startup'});},
  async command(s:string){await commands.get('team').handler(s,ctx);},
  async ledger(p:any){return tools.get('team_tasks').execute(`ledger${++seq}`,p,undefined,undefined,ctx);},
  async audit(){return tools.get('team_goal').execute('audit',{verdict:'GOAL_COMPLETE',summary:'Verified all fixture deliverables',evidence:['fixture: tests exit 0'],acceptanceMet:['Original acceptance: verified']},undefined,undefined,ctx);},
  setBranch(es:any[]){branch=es;},
 };
}
async function test(name:string,fn:()=>Promise<void>){await fn();passed++;console.log(`✓ ${name}`);}
async function request(h:any,text='Additional task'){await h.emit('input',{text,source:'rpc'});return h.state().ledger.requests.at(-1).id;}
const spec=(q:string,id:string,extra:any={})=>({id,title:id,role:'bridges',requestIds:[q],dependsOn:[],readPaths:[],writePaths:[`src/${id}`],acceptance:['verified output'],...extra});
function completedChild(id:string,reportAt:string,parent='parent') {
 const dir=join(root,'sessions','--fixture--');mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,`2026-01-01T00-00-00-000Z_${id}.jsonl`),[
  {type:'session',id,version:3,cwd:root,timestamp:reportAt},
  {type:'custom',id:'meta',parentId:null,timestamp:reportAt,customType:'pi-web:subagent',data:{version:1,parentSessionId:parent}},
  {type:'message',id:'report',parentId:'meta',timestamp:reportAt,message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'Verified fixture report'}],timestamp:Date.parse(reportAt)}},
  {type:'custom',id:'result',parentId:'report',timestamp:reportAt,customType:'pi-web:subagent-result',data:{status:'completed'}},
 ].map(e=>JSON.stringify(e)).join('\n')+'\n');
}
async function dispatch(h:any,id:string,call=id,extra:any={}) {return h.emit('tool_call',{toolName:'Agent',toolCallId:call,input:{subagent_type:'bridges',prompt:`TEAM_TASK: ${id}\nGoal: bounded fixture work.`,...extra}});}
async function result(h:any,call:string,sessionId:string,status='completed'){return h.emit('tool_result',{toolName:'Agent',toolCallId:call,input:{},isError:false,details:{sessionId,status},content:[{type:'text',text:status==='completed'?'Verified report body':'Task accepted'}]});}
const accept=(h:any,id:string)=>h.ledger({action:'update',updates:[{id,status:'done',evidence:['test: exit 0'],reason:'Main verified report and acceptance'}]});
try {
 await test('input captures appended/steering/follow-up requests without overwriting original; fallback dedupes normal prompt',async()=>{
  const h=harness();await h.start();await request(h,'A');await h.emit('input',{text:'B',source:'rpc',streamingBehavior:'steer'});await h.emit('input',{text:'C',source:'rpc',streamingBehavior:'followUp'});
  await h.emit('before_agent_start',{prompt:'A',systemPrompt:'base'});assert.deepEqual(h.state().ledger.requests.map((r:any)=>r.text),['Original goal','A','B','C']);
  await h.emit('before_agent_start',{prompt:'SDK-only D',systemPrompt:'base'});assert.equal(h.state().ledger.requests.at(-1).text,'SDK-only D');
 });
 await test('queued input persists immediately and historical snapshot data is never mutated by append',async()=>{
  const h=harness();await h.start();await request(h,'A');const old=h.entries().at(-1).data;const snapshot=structuredClone(old);await request(h,'B');assert.deepEqual(old,snapshot);assert.equal(old.ledger.requests.length,2);
 });
 await test('goal append preserves original objective, acceptance, audit and next tasks; kickoff is not a second request',async()=>{
  const h=harness();await h.start();await h.command('goal New scope --accept "New acceptance"');assert.match(h.state().goal.objective,/Original goal/);assert.match(h.state().goal.objective,/New scope/);assert.deepEqual(h.state().goal.acceptance,['Original acceptance','New acceptance']);
  const before=h.state().ledger.requests.length;await h.emit('before_agent_start',{prompt:h.prompts.at(-1),systemPrompt:'base'});assert.equal(h.state().ledger.requests.length,before);
  await h.command('goal clear');assert.ok(h.state().goal);assert.match(h.notes.at(-1)!,/不能/);
 });
 await test('queue insert moves pending work, dependencies remain enforced, archived history survives reload',async()=>{
  const h=harness();await h.start();const q=await request(h);assert.notEqual((await h.ledger({action:'add',tasks:['W-a','W-b','W-c'].map(id=>spec(q,id))})).isError,true);
  await h.ledger({action:'move',move:{id:'W-c',position:'front',reason:'User urgent task'}});assert.deepEqual((await h.ledger({action:'list'})).details.dispatchable,['W-c','W-a','W-b']);
  await accept(h,'W-c');const archive=await h.ledger({action:'archive'});assert.match(archive.content[0].text,/W-c \[done\].*test: exit 0/);
  const restored=harness(structuredClone(h.entries()));await restored.start();assert.equal(restored.state().ledger.tasks[0].status,'done');assert.deepEqual((await restored.ledger({action:'list'})).details.dispatchable,['W-a','W-b']);
 });
 await test('explicit slash queue insertion is persistent and invalid/live moves are atomic',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:['W-a','W-b','W-c'].map(id=>spec(q,id))});
  await h.command('tasks move W-c before W-a');assert.deepEqual(h.state().ledger.tasks.map((t:any)=>t.id),['W-c','W-a','W-b']);
  const before=structuredClone(h.state());await h.command('tasks move W-c after W-missing');assert.deepEqual(h.state(),before);assert.match(h.notes.at(-1)!,/队列未改动/);
  await dispatch(h,'W-c');const running=structuredClone(h.state());await h.command('tasks move W-c tail');assert.deepEqual(h.state(),running);
 });
 await test('fresh context after compaction/reload injects all open obligations once, never stale archived queue',async()=>{
  const h=harness();await h.start();const q=await request(h,'Keep old integration obligation');await h.ledger({action:'add',tasks:[spec(q,'W-a')]});
  const restored=harness(structuredClone(h.entries()));await restored.start();const event=await restored.emit('context',{messages:[{role:'custom',customType:'team-work-ledger',content:'stale'},{role:'user',content:'compaction summary'}]});
  assert.equal(event.messages.filter((m:any)=>m.customType==='team-work-ledger').length,1);assert.match(event.messages.at(-1).content,/Keep old integration obligation/);assert.match(event.messages.at(-1).content,/W-a/);assert.equal(event.messages[0].content,'compaction summary');
 });
 await test('branch navigation restores active branch queue instead of abandoned branch newer data',async()=>{
  const h=harness();await h.start();await request(h,'Branch A');const branchA=structuredClone(h.entries());await request(h,'Branch B');h.setBranch(branchA);await h.emit('session_tree',{});
  assert.ok(h.state().ledger.requests.some((r:any)=>r.text==='Branch A'));assert.ok(!h.state().ledger.requests.some((r:any)=>r.text==='Branch B'));
  const event=await h.emit('context',{messages:[]});assert.doesNotMatch(event.messages.at(-1).content,/Branch B/);
 });
 await test('reported production inline TEAM_TASK prompts dispatch both registered independent children without re-registration',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-6'),spec(q,'W-7',{role:'ayton',writePaths:[]})]});
  const inputs=[{subagent_type:'bridges',prompt:'TEAM_TASK: W-6. Goal: offline conversion package.'},{subagent_type:'ayton',prompt:'TEAM_TASK: W-7. Goal: focused no-SDK release QA.'}];
  const launches=await Promise.all(inputs.map((input,i)=>h.emit('tool_call',{toolName:'Agent',toolCallId:`inline-${i}`,input})));
  for(const launch of launches){assert.notEqual(launch.block,true);assert.equal(launch.input.run_in_background,true);}
  assert.deepEqual(h.state().ledger.tasks.map((t:any)=>[t.id,t.status]),[['W-6','running'],['W-7','running']]);assert.equal(h.state().tasks,2);
 });
 await test('inline parsing does not bypass unknown IDs, role, dependency or scope guards; malformed assignments leave ledger unchanged',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b',{dependsOn:['W-a']}),spec(q,'W-c',{writePaths:['src/W-a']})]});
  const before=structuredClone(h.state());
  for(const prompt of ['TEAM_TASK: W-a/extra','TEAM_TASK: W-a\nTEAM_TASK: W-b','TEAM_TASK: W-a\nTEAM_TASK: invalid','TEAM_TASK: W-unknown. Goal: work','TEAM_TASK: W-b. Goal: dependent work'])assert.equal((await dispatch(h,'W-a',`invalid-${prompt}`,{prompt})).block,true);
  assert.equal((await dispatch(h,'W-a','role',{subagent_type:'ayton',prompt:'TEAM_TASK: W-a. Goal: wrong role'})).block,true);assert.deepEqual(h.state(),before);
  assert.notEqual((await dispatch(h,'W-a','valid',{prompt:'TEAM_TASK: W-a. Goal: bounded work'})).block,true);
  const running=structuredClone(h.state());assert.equal((await dispatch(h,'W-c','conflict',{prompt:'TEAM_TASK: W-c. Goal: overlapping work'})).block,true);assert.deepEqual(h.state(),running);
 });
 await test('registered obligations cannot be bypassed with untracked Agent; foreground waiting rejected while independent work ready',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b')]});
  const untracked=await h.emit('tool_call',{toolName:'Agent',toolCallId:'bad',input:{subagent_type:'bridges',prompt:'bundle everything'}});assert.equal(untracked.block,true);assert.match(untracked.reason,/Already registered ready bridges tasks: W-a, W-b/);assert.match(untracked.reason,/Do not register duplicate tasks/);
  assert.equal((await dispatch(h,'W-a','fg',{run_in_background:false})).block,true);
  const bg=await dispatch(h,'W-a');assert.notEqual(bg.block,true);assert.equal(bg.input.run_in_background,true);await result(h,'W-a','child-a','running');
  assert.equal((await h.emit('tool_call',{toolName:'get_subagent_result',input:{agent_id:'child-a',wait:true}})).block,true);
  assert.notEqual((await h.emit('tool_call',{toolName:'get_subagent_result',input:{agent_id:'child-a',wait:false}})).block,true);
 });
 await test('background children retain ownership but never consume a finite numeric capacity',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:['W-a','W-b','W-c'].map(id=>spec(q,id))});
  await dispatch(h,'W-a');await result(h,'W-a','child-a','running');await dispatch(h,'W-b');await result(h,'W-b','child-b','running');
  assert.notEqual((await dispatch(h,'W-c')).block,true);await result(h,'W-c','child-c','running');
  assert.equal(h.state().ledger.tasks.filter((t:any)=>t.status==='running').length,3);
  // Coordination change: same-task/same-role duplicate without resume is a no-op acknowledgement that
  // Agent.execute answers with the existing child, not a blocking error. The hook itself mutates nothing.
  const beforeDuplicate=structuredClone(h.state());
  assert.notEqual((await dispatch(h,'W-a','duplicate')).block,true);
  assert.deepEqual(h.state(),beforeDuplicate);
  await h.emit('tool_result',{toolName:'get_subagent_result',input:{agent_id:'child-a'},isError:false,details:{sessionId:'child-a',status:'completed'},content:[{type:'text',text:'final report'}]});
  assert.equal(h.state().ledger.tasks[0].status,'reported');assert.equal(h.state().ledger.tasks[2].status,'running');
 });
 await test('rolling continuation fills a free slot before waiting for unrelated running child',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:['W-a','W-b'].map(id=>spec(q,id))});await dispatch(h,'W-a');await result(h,'W-a','child-a','running');
  assert.equal((await h.emit('agent_before_settle',{entries:[]})).continue,true);await dispatch(h,'W-b');await result(h,'W-b','child-b','running');assert.notEqual((await h.emit('agent_before_settle',{entries:[]})).continue,true);
 });
 await test('interruption cannot silently release scope; stopped attestation only permits blocked and releases capacity safely',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b',{writePaths:['src/W-a']})]});await dispatch(h,'W-a');await result(h,'W-a','child-a','interrupted');
  assert.equal((await dispatch(h,'W-b')).block,true);assert.equal((await accept(h,'W-a')).isError,true);
  const confirmed=await h.ledger({action:'update',updates:[{id:'W-a',status:'blocked',childStopped:true,evidence:['child process stopped: verified by parent'],reason:'Actual stop verified, not inferred from timeout'}]});assert.notEqual(confirmed.isError,true);assert.notEqual((await dispatch(h,'W-b')).block,true);
 });
 await test('mutations are atomic and reported is not accepted; final completion requires every user request resolved',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a')]});const before=structuredClone(h.state());
  assert.equal((await h.ledger({action:'update',updates:[{id:'W-a',status:'done',evidence:['test: exit 0'],reason:'verified'},{id:'W-missing',status:'done',evidence:['test: exit 0'],reason:'verified'}]})).isError,true);assert.deepEqual(h.state(),before);
  assert.equal((await h.audit()).isError,true);await accept(h,'W-a');assert.equal((await h.audit()).isError,true);
  await h.ledger({action:'resolve',request:{id:q,status:'done',evidence:['acceptance verified: test exit 0'],reason:'User request fulfilled'}});assert.notEqual((await h.audit()).isError,true);assert.equal(h.state().goal.status,'complete');assert.ok(h.state().ledger.requests.every((r:any)=>r.archivedAt));
 });
 await test('reload consumes persisted queued input exactly once while repeated genuine requests remain distinct',async()=>{
  const h=harness();await h.start();await request(h,'same request');const restored=harness(structuredClone(h.entries()));await restored.start();
  await restored.emit('before_agent_start',{prompt:'same request',systemPrompt:'base'});assert.equal(restored.state().ledger.requests.filter((r:any)=>r.text==='same request').length,1);
  await request(restored,'same request');await restored.emit('before_agent_start',{prompt:'same request',systemPrompt:'base'});assert.equal(restored.state().ledger.requests.filter((r:any)=>r.text==='same request').length,2);
 });
 await test('profile-less native resume derives known role and rejects live/unknown children or unsupported profiles',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a')]});await dispatch(h,'W-a');await result(h,'W-a','child-a','running');
  const native=(resume:string,type?:string)=>h.emit('tool_call',{toolName:'Agent',toolCallId:'resume',input:{resume,prompt:'TEAM_TASK: W-a\nBounded rework.',...(type?{subagent_type:type}:{})}});
  assert.equal((await native('child-a')).block,true);assert.equal((await native('unknown','bridges')).block,true);assert.equal((await h.emit('tool_call',{toolName:'Agent',input:{subagent_type:'general-purpose',prompt:'bypass'}})).block,true);
  await result(h,'other','child-a');await h.ledger({action:'update',updates:[{id:'W-a',status:'ready',evidence:['real rework needed'],reason:'Reuse stopped child'}]});assert.notEqual((await native('child-a')).block,true);assert.equal(h.state().ledger.tasks[0].role,'bridges');
 });
 await test('re-queueing a delivered attempt releases only that child; live, uncertain or foreign children keep the scope',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a')]});await dispatch(h,'W-a');await result(h,'W-a','child-a','running');
  const native=(resume:string)=>h.emit('tool_call',{toolName:'Agent',toolCallId:'resume',input:{resume,prompt:'TEAM_TASK: W-a\nBounded rework.'}});
  const requeue=()=>h.ledger({action:'update',updates:[{id:'W-a',status:'ready',evidence:['real rework needed'],reason:'Reuse stopped child'}]});
  // A genuinely live child can never be re-queued by the parent, and its scope stays held.
  assert.equal((await requeue()).isError,true);assert.equal(h.state().ledger.tasks[0].status,'running');assert.equal((await native('child-a')).block,true);
  // A terminal result for a foreign session never releases child-a's attempt.
  await result(h,'other','child-foreign','completed');assert.equal(h.state().ledger.tasks[0].status,'running');assert.equal((await requeue()).isError,true);assert.equal((await native('child-a')).block,true);
  // An ambiguous (interrupted) child is not a delivered attempt: still blocked until the parent attests it stopped.
  await result(h,'other','child-a','interrupted');assert.equal(h.state().ledger.tasks[0].status,'uncertain');assert.equal((await requeue()).isError,true);assert.equal((await native('child-a')).block,true);
  // Only the explicit stop attestation frees the scope, and only then may the stopped child be re-queued and resumed.
  assert.notEqual((await h.ledger({action:'update',updates:[{id:'W-a',status:'blocked',childStopped:true,evidence:['child process stopped: verified by parent'],reason:'Actual stop verified'}]})).isError,true);
  assert.notEqual((await requeue()).isError,true);assert.equal(h.state().ledger.tasks[0].status,'ready');assert.notEqual((await native('child-a')).block,true);
 });
 await test('branch navigation and reload preserve session-wide live leases and cannot redispatch a rolled-back ready task',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b'),spec(q,'W-c',{writePaths:['src/W-a']})]});const branch=structuredClone(h.entries());
  await dispatch(h,'W-a');await result(h,'W-a','child-a','running');await dispatch(h,'W-b');await result(h,'W-b','child-b','running');h.setBranch(branch);await h.emit('session_tree');
  assert.equal((await dispatch(h,'W-a','duplicate')).block,true);assert.equal((await dispatch(h,'W-c')).block,true);
  assert.equal((await accept(h,'W-a')).isError,true);
  const restored=harness(structuredClone(h.entries()));restored.setBranch(structuredClone(branch));await restored.start();assert.equal((await dispatch(restored,'W-c')).block,true);
  await result(restored,'returned','child-a');assert.notEqual((await dispatch(restored,'W-c')).block,true);
 });
 await test('authenticated completion creates exactly one reviewer and holds the scope, while foreign or old-attempt notifications cannot release it',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b'),spec(q,'W-c',{writePaths:['src/W-a']})]});const a='33333333-3333-7333-8333-333333333333',b='44444444-4444-7444-8444-444444444444';
  await dispatch(h,'W-a');await result(h,'W-a',a,'running');await dispatch(h,'W-b');await result(h,'W-b',b,'running');
  const stamp=new Date(Date.now()+100).toISOString();completedChild(a,stamp,'foreign-parent');
  h.entries().push({type:'custom_message',id:'notice-a',customType:'pi-web:subagent-notification',timestamp:stamp,details:{sessionId:a,status:'completed'},content:'host notification'});
  await h.emit('context',{messages:[]});assert.equal((await dispatch(h,'W-c')).block,true);
  completedChild(a,'2020-01-01T00:00:00.000Z');await h.emit('context',{messages:[]});assert.equal(h.state().ledger.tasks[0].status,'running');
  completedChild(a,stamp);await h.emit('context',{messages:[]});
  // A reported task must never be left unreviewed: the probe auto-creates exactly one reviewer and
  // the reviewed deliverable keeps its write scope until that review resolves.
  const revs=()=>h.state().ledger.tasks.filter((t:any)=>t.id==='W-rev-a'&&t.status!=='superseded').length;
  assert.equal(h.state().ledger.tasks[0].status,'reviewing');assert.equal(revs(),1);
  const count=h.entries().filter((e:any)=>e.customType==='team-child-lease').length;
  await h.emit('context',{messages:[]});assert.equal(h.entries().filter((e:any)=>e.customType==='team-child-lease').length,count);assert.equal(revs(),1);
  // Foreign/old completions above never released the scope, and an in-review deliverable keeps it:
  // a second writer would invalidate the review. Release happens when the review resolves.
  assert.equal((await dispatch(h,'W-c')).block,true);
 });
 await test('stale session-level completion cannot release a resumed attempt during explicit reconciliation',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a')]});const a='55555555-5555-7555-8555-555555555555';completedChild(a,'2020-01-01T00:00:00.000Z');
  await dispatch(h,'W-a');await result(h,'W-a',a);h.entries().push({type:'message',message:{role:'toolResult',toolName:'Agent',details:{sessionId:a,status:'completed'}}});
  await h.ledger({action:'update',updates:[{id:'W-a',status:'ready',evidence:['rework required'],reason:'Resume the stopped child'}]});assert.notEqual((await dispatch(h,'W-a','attempt-b',{resume:a})).block,true);
  const runId=h.state().ledger.tasks[0].runId;await h.command(`reconcile ${a}`);assert.equal(h.state().ledger.tasks[0].status,'running');assert.equal(h.state().ledger.tasks[0].runId,runId);
  await h.emit('tool_result',{toolName:'get_subagent_result',toolCallId:'stale-get',input:{agent_id:a},isError:false,details:{sessionId:a,status:'completed'},content:[{type:'text',text:'Cached attempt-A completion'}]});assert.equal(h.state().ledger.tasks[0].status,'running');
  await result(h,'stale-attempt-a',a);assert.equal(h.state().ledger.tasks[0].status,'running');
  completedChild(a,new Date(Date.now()+100).toISOString());await h.command(`reconcile ${a}`);assert.equal(h.state().ledger.tasks[0].status,'reported');
 });
 await test('an old historical lease cannot authorize acceptance after branch rollback while a newer retry is live',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a')]});await dispatch(h,'W-a');await result(h,'W-a','old-child');
  await h.ledger({action:'update',updates:[{id:'W-a',status:'ready',evidence:['rework needed'],reason:'Fresh retry'}]});const branch=structuredClone(h.entries()),oldRun=h.state().ledger.tasks[0].runId;
  await dispatch(h,'W-a','retry-b');await result(h,'retry-b','new-child','running');assert.notEqual(h.state().ledger.tasks[0].runId,oldRun);h.setBranch(branch);await h.emit('session_tree');
  const before=structuredClone(h.state());assert.equal((await accept(h,'W-a')).isError,true);assert.deepEqual(h.state(),before);assert.equal((await dispatch(h,'W-a','duplicate-retry')).block,true);
  const injected=await h.emit('context',{messages:[]});assert.match(injected.messages.at(-1).content,/Dispatchable independent batch: none\./);
 });
 await test('multiple independent requests and new appended objective all advance immediately without waiting for returned children',async()=>{
  const h=harness();await h.start();const qa=await request(h,'First objective'),qb=await request(h,'Second objective');await h.ledger({action:'add',tasks:[spec(qa,'W-a'),spec(qb,'W-b')]});assert.deepEqual((await h.ledger({action:'list'})).details.dispatchable,['W-a','W-b']);
  await Promise.all([dispatch(h,'W-a','multi-a'),dispatch(h,'W-b','multi-b')]);await result(h,'multi-a','multi-child-a','running');await result(h,'multi-b','multi-child-b','running');assert.equal(h.state().ledger.tasks.filter((t:any)=>t.status==='running').length,2);
  const qc=await request(h,'Appended third objective');await h.ledger({action:'add',tasks:[spec(qc,'W-c')]});assert.notEqual((await dispatch(h,'W-c','multi-c')).block,true);await result(h,'multi-c','multi-child-c','running');
  await result(h,'multi-a-returned','multi-child-a');await accept(h,'W-a');await h.ledger({action:'resolve',request:{id:qa,status:'done',evidence:['W-a accepted'],reason:'First objective verified'}});assert.equal(h.state().ledger.tasks.find((t:any)=>t.id==='W-c').status,'running');assert.equal(h.state().ledger.tasks.find((t:any)=>t.id==='W-b').status,'running');
 });
 await test('twelve tracked independent children run simultaneously past six and every positive legacy cap',async()=>{
  const seed=initialState(defaultConfig());seed.enabled=true;seed.goal=newGoal('Original goal',['Original acceptance']);seed.limitsOff=false;seed.budgetOverrideUSD=0.001;seed.spendUSD=1000000;seed.reservedUSD=1000000;seed.calls.bridges=1000000;seed.failures.bridges=1000000;
  const h=harness([{type:'custom',id:'legacy-restrictive',customType:'team-state',data:seed}]);await h.start();const q=await request(h,'Many parallel deliverables');
  await h.ledger({action:'add',tasks:Array.from({length:12},(_,i)=>spec(q,`W-many-${i}`))});assert.equal((await h.ledger({action:'list'})).details.dispatchable.length,12);
  for(let i=0;i<12;i++){assert.notEqual((await dispatch(h,`W-many-${i}`)).block,true);await result(h,`W-many-${i}`,`many-child-${i}`,'running');}
  const live=h.state().ledger.tasks.filter((t:any)=>t.status==='running');assert.equal(live.length,12);assert.equal(new Set(live.map((t:any)=>t.sessionId)).size,12);
  assert.equal(h.state().calls.bridges,1000012);assert.equal(h.state().limitsOff,true);assert.equal(h.state().budgetOverrideUSD,0);
  const reloaded=harness(structuredClone(h.entries()));await reloaded.start();assert.equal(reloaded.state().ledger.tasks.filter((t:any)=>t.status==='running').length,12);
  // Coordination change: a same-task/role duplicate without resume is a success acknowledgement of the
  // existing child (Agent.execute returns its sessionId), not a blocking error; nothing is re-registered.
  assert.notEqual((await dispatch(reloaded,'W-many-0','duplicate-after-reload')).block,true);
  assert.equal(reloaded.state().ledger.tasks.filter((t:any)=>t.status==='running').length,12);assert.doesNotMatch(JSON.stringify(h.entries()),/Infinity/);
  const prompt=await reloaded.emit('context',{messages:[]});assert.match(prompt.messages.at(-1).content,/unlimited \(no child-count cap\)/);
 });
 await test('legacy limits and budget setters cannot re-enable or persist numeric limits',async()=>{
  const h=harness();await h.start();const before=structuredClone(h.state());
  const {readFileSync}=await import('node:fs');const configBefore=readFileSync(join(root,'team.json'),'utf8');
  for(const command of ['limits on','limits off','budget on','budget reset','budget session 1','budget set concurrent 1','budget set retries 1','budget set cp.calls 1','budget set booker.usd 1'])await h.command(command);
  assert.deepEqual(h.state(),before);assert.equal(readFileSync(join(root,'team.json'),'utf8'),configBefore);
  await h.command('budget');assert.match(h.notes.at(-1)!,/仅为统计/);
 });
 await test('children cannot access or mutate parent queue',async()=>{
  const h=harness(undefined,true);await h.start();const before=structuredClone(h.state());assert.equal((await h.ledger({action:'add',tasks:[]})).isError,true);assert.deepEqual(h.state(),before);
 });
 console.log(`\nTeam ledger hook tests: ${passed} passed`);
} finally {if(original===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=original;rmSync(root,{recursive:true,force:true});}
