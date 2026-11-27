/** 改造2: pending review still protects writers, not strict read-only readers. Offline hooks only. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig } from '../extensions/team.ts';
import { newLedger, addRequest, addTasks, createReviewerTask, readyTasks, scopeBlockingLive, isActiveReviewHold, taskConflict, reviewingReadAllowed } from '../team-ledger.ts';
const root = mkdtempSync(join(tmpdir(), 'team-reviewing-readers-'));
const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, 'team.json'), JSON.stringify({ autoWorktreeOnConflict: false }));
let passed = 0;
function seed(status = 'reviewing') {
 const state = initialState(defaultConfig()); state.enabled = true;
 const b = state.ledger = newLedger(), q = addRequest(b, 'Verify reviewing reader admission', 'fixture');
 addTasks(b, [
  { id:'W-holder', role:'bridges', title:'Deliver file', requestIds:[q.id], dependsOn:[], readPaths:[], writePaths:['src/file.ts'], acceptance:['file checked'], sharedResources:['device:1'] },
  { id:'W-read', role:'ayton', title:'Read file', requestIds:[q.id], dependsOn:[], readPaths:['src/file.ts'], writePaths:[], acceptance:['inspection reported'], readMode:'strict' },
  { id:'W-write', role:'bridges', title:'Repair file', requestIds:[q.id], dependsOn:[], readPaths:[], writePaths:['src/file.ts'], acceptance:['repair checked'] },
  { id:'W-resource', role:'ayton', title:'Inspect exclusive device', requestIds:[q.id], dependsOn:[], readPaths:['src/file.ts'], writePaths:[], acceptance:['device checked'], sharedResources:['device:1'] },
 ], root);
 const holder = b.tasks[0]; holder.status = 'reported'; holder.runId = 'run-holder'; holder.dispatchedAt = new Date().toISOString();
 createReviewerTask(b, holder); holder.status = status as any;
 return state;
}
function harness(status = 'reviewing') {
 const state = seed(status); let seq=0;
 const entries:any[] = [ {type:'custom',customType:'team-state',data:state}, {type:'custom',customType:'team-child-lease',data:structuredClone(state.ledger.tasks[0])} ];
 const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
 const ctx:any = {cwd:root,hasUI:false,isIdle:()=>true, sessionManager:{getEntries:()=>entries,getBranch:()=>entries,getSessionId:()=> 'parent',getSessionFile:()=>join(root,'parent.jsonl')}, ui:{notify(){},setStatus(){}}, model:{provider:'fixture',id:'unused'},modelRegistry:{find:()=>undefined}};
 const pi:any = {on:(n:string,f:Function)=>hooks.set(n,[...(hooks.get(n)??[]),f]),registerFlag(){},getFlag:()=>false,registerTool:(t:any)=>tools.set(t.name,t),registerCommand(){},appendEntry:(t:string,data:any)=>entries.push({type:'custom',id:`e${++seq}`,customType:t,data}),getThinkingLevel:()=> 'high',sendMessage(){},sendUserMessage(){}};
 team(pi);
 return { async emit(name:string,event:any={}) { let e=event; for(const f of hooks.get(name)??[]) { const p=await f(e,ctx); if(p)e={...e,...p}; } return e; }, async list(){return tools.get('team_tasks').execute('list',{action:'list'},undefined,undefined,ctx);} };
}
async function test(name:string,fn:()=>void|Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
try {
 await test('reviewing hold remains active; strict readers admitted, writers and resources blocked', () => {
  const b=seed().ledger, [holder,reader,writer,resource] = b.tasks;
  assert.equal(scopeBlockingLive(b,holder),true); assert.equal(isActiveReviewHold(b,holder),true);
  assert.equal(taskConflict(reader,holder),true, 'filesystem conflict model itself is not weakened');
  assert.equal(reviewingReadAllowed(reader,holder),true);
  assert.equal(reviewingReadAllowed(writer,holder),false); assert.equal(reviewingReadAllowed(resource,holder),false);
  const ids=readyTasks(b).map(t=>t.id); assert.ok(ids.includes(reader.id)); assert.ok(!ids.includes(writer.id)); assert.ok(!ids.includes(resource.id));
 });
 await test('running/uncertain writers still block strict readers and writers', () => {
  for(const status of ['running','uncertain']) { const b=seed(status).ledger; const ids=readyTasks(b).map(t=>t.id); assert.ok(!ids.includes('W-read')); assert.ok(!ids.includes('W-write')); }
 });
 await test('writer capability cannot be disguised as empty writePaths', () => {
  const b=seed().ledger; const candidate={...b.tasks[1],role:'bridges',writePaths:[]}; assert.equal(reviewingReadAllowed(candidate,b.tasks[0]),false);
 });
 await test('real Agent hook and persisted reviewing lease agree with readyTasks', async () => {
  const h=harness(); await h.emit('session_start',{reason:'startup'});
  const listed=await h.list(); assert.ok(listed.details.dispatchable.includes('W-read')); assert.ok(!listed.details.dispatchable.includes('W-write'));
  const event=await h.emit('tool_call',{toolName:'Agent',toolCallId:'read',input:{subagent_type:'ayton',prompt:'TEAM_TASK: W-read\nRead delivered file without writing.'}});
  assert.notEqual(event.block,true,event.reason);
 });
 await test('hook rejection guidance still names reviewing holder for writers/resources', async () => {
  for(const [id,role] of [['W-write','bridges'],['W-resource','ayton']]) {
   const h=harness(); await h.emit('session_start',{reason:'startup'});
   const event=await h.emit('tool_call',{toolName:'Agent',toolCallId:id,input:{subagent_type:role,prompt:`TEAM_TASK: ${id}\nBounded fixture.`}});
   assert.equal(event.block,true); assert.match(event.reason,/W-holder/); assert.match(event.reason,/Next:/);
  }
 });
 await test('hook keeps live running writer/strict reader mutual exclusion', async () => {
  const h=harness('running'); await h.emit('session_start',{reason:'startup'});
  const event=await h.emit('tool_call',{toolName:'Agent',toolCallId:'blocked-read',input:{subagent_type:'ayton',prompt:'TEAM_TASK: W-read\nRead file.'}});
  assert.equal(event.block,true); assert.match(event.reason,/W-holder/);
 });
 console.log(`\n${passed} passed / 0 failed`);
} finally { if(prior===undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=prior; rmSync(root,{recursive:true,force:true}); }
