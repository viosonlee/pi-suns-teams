/** Real extension factory, offline host-hook tests. No provider/model calls. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig, newGoal } from '../extensions/team.ts';
const root=mkdtempSync(join(tmpdir(),'team-probe-')); const original=process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR=root;
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
 await test('probe144',async()=>{
  const h=harness();await h.start();const q=await request(h);await h.ledger({action:'add',tasks:[spec(q,'W-a'),spec(q,'W-b'),spec(q,'W-c',{writePaths:['src/W-a']})]});const a='33333333-3333-7333-8333-333333333333',b='44444444-4444-7444-8444-444444444444';
  const dump=(tag:string)=>console.error('[P]',tag,JSON.stringify(h.state().ledger.tasks.map((t:any)=>({id:t.id,status:t.status,runId:t.runId,sessionId:t.sessionId}))),'leases:',JSON.stringify(h.entries().filter((e:any)=>e.customType==='team-child-lease').map((e:any)=>[e.data.id,e.data.status,e.data.sessionId])));
  await dispatch(h,'W-a');await result(h,'W-a',a,'running');await dispatch(h,'W-b');await result(h,'W-b',b,'running');dump('after results');
  const stamp=new Date(Date.now()+100).toISOString();completedChild(a,stamp,'foreign-parent');
  h.entries().push({type:'custom_message',id:'notice-a',customType:'pi-web:subagent-notification',timestamp:stamp,details:{sessionId:a,status:'completed'},content:'host notification'});
  await h.emit('context',{messages:[]});dump('after foreign notif');
  assert.equal((await dispatch(h,'W-c')).block,true);dump('after dispatch W-c');
  completedChild(a,'2020-01-01T00:00:00.000Z');await h.emit('context',{messages:[]});dump('after stale file');
  completedChild(a,stamp);await h.emit('context',{messages:[]});dump('after fresh file');
 });
 console.log('ok');
} finally {if(original===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=original;rmSync(root,{recursive:true,force:true});}
