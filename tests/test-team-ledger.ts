import { strict as assert } from 'node:assert';
import { newLedger, addRequest, addTasks, addBacklog, readyTasks, dispatchBatch, taskConflict, markDispatched, observeTask, updateTask, resolveRequest, completionBlockers, ledgerPrompt, moveTask, archivePrompt, parseTeamTaskId } from '../team-ledger.ts';
import { stateFromEntries, defaultConfig, initialState, newGoal, applyAudit } from '../extensions/team.ts';
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };
function fixture() { const b = newLedger(); const q = addRequest(b, 'Original implementation and integrated regression', 'input:1'); return { b, q }; }
const spec = (q: string, id: string, changes: any = {}) => ({ id, title: id, role: 'bridges', requestIds: [q], dependsOn: [], readPaths: [], writePaths: [`src/${id}.ts`], acceptance: ['test evidence for this deliverable'], ...changes });
const accept = (b: any, id: string) => updateTask(b, { id, status: 'done', evidence: ['test: exit 0'], reason: 'Main CP verified output and acceptance.' });
test('TEAM_TASK accepts a dedicated line and inline goal text without losing exact task IDs', () => {
 for (const prompt of ['TEAM_TASK: W-6', 'TEAM_TASK: W-6\nGoal: package', 'TEAM_TASK: W-6. Goal: package', '\tTEAM_TASK: W-6 Goal: package', 'TEAM_TASK: W-6; Goal: package', 'TEAM_TASK: W-6。目标：打包', 'Context\r\nTEAM_TASK: W-6\r\nGoal: package', 'TEAM_TASK: W-6\nTEAM_TASK: W-6']) assert.equal(parseTeamTaskId(prompt),'W-6');
 assert.equal(parseTeamTaskId('TEAM_TASK: W-long_id-123. Goal: scoped work'),'W-long_id-123');
 assert.equal(parseTeamTaskId('TEAM_TASK: W-6. Goal: explain TEAM_TASK: W-7 as an example'),'W-6');
 assert.equal(parseTeamTaskId('Goal: mention TEAM_TASK: W-6 as an example'),undefined);
 assert.equal(parseTeamTaskId('No assignment'),undefined);
});
test('malformed, partial and conflicting TEAM_TASK IDs fail closed rather than binding a prefix', () => {
 for (const prompt of ['TEAM_TASK: W-6/extra', 'TEAM_TASK: W-6.extra', 'TEAM_TASK: W-6*', 'TEAM_TASK:', 'TEAM_TASK: X-6', 'TEAM_TASK: W-6\nTEAM_TASK: W-7', 'TEAM_TASK: W-6\nTEAM_TASK: invalid']) assert.throws(()=>parseTeamTaskId(prompt),/Invalid TEAM_TASK|Conflicting TEAM_TASK/);
});
test('new requests append and source receipt is idempotent, repeated text is not deduped', () => {
 const {b,q} = fixture(); const q2 = addRequest(b, q.text, 'input:2'); assert.notEqual(q.id,q2.id); assert.equal(addRequest(b, 'other', 'input:2'),q2); assert.equal(b.requests.length,2);
});
test('parallelism applies within a decomposed objective and across distinct objectives, including same-role instances', () => {
 const {b,q}=fixture(); const q2=addRequest(b,'Independent second objective','input:2');
 addTasks(b,[spec(q.id,'W-a'),spec(q.id,'W-b'),spec(q2.id,'W-c')],'/repo');
 assert.deepEqual(dispatchBatch(b,3).map(t=>t.id),['W-a','W-b','W-c']);
 const prompt=ledgerPrompt(b,3);assert.match(prompt,/both WITHIN each objective and ACROSS different objectives/);assert.match(prompt,/multiple instances of the same role/);assert.match(prompt,/decompose EACH objective as finely as independently executable and verifiable outputs allow/);
 for(const task of [...dispatchBatch(b,3)]) markDispatched(b,task.id,'bridges',`run-${task.id}`);
 assert.equal(b.tasks.filter(t=>t.status==='running').length,3);assert.deepEqual(b.tasks.map(t=>t.requestIds),[[q.id],[q.id],[q2.id]]);
});
test('legacy slot arguments cannot limit independent batches, including more than six children', () => {
 const {b,q}=fixture();addTasks(b,Array.from({length:12},(_,i)=>spec(q.id,`W-many-${i}`)),'/repo');
 for(const slots of [0,1,2,6,Infinity])assert.equal(dispatchBatch(b,slots).length,12);
 assert.match(ledgerPrompt(b,1),/unlimited \(no child-count cap\)/);
 assert.equal(JSON.stringify(b).includes('Infinity'),false);
});
test('queue append is FIFO; front/before/after/tail insertion is persistent and stable', () => {
 const {b,q}=fixture(); addTasks(b,['W-a','W-b','W-c'].map(id=>spec(q.id,id)), '/repo');
 moveTask(b,{id:'W-c',position:'front',reason:'user: urgent fix'}); assert.deepEqual(dispatchBatch(b,2).map(t=>t.id),['W-c','W-a','W-b']);
 moveTask(b,{id:'W-c',position:'after',targetId:'W-a',reason:'priority changed'}); assert.deepEqual(b.tasks.map(t=>t.id),['W-a','W-c','W-b']);
 moveTask(b,{id:'W-b',position:'before',targetId:'W-c',reason:'user ordering'}); assert.deepEqual(b.tasks.map(t=>t.id),['W-a','W-b','W-c']);
 moveTask(b,{id:'W-a',position:'tail',reason:'user ordering'}); assert.deepEqual(b.tasks.map(t=>t.id),['W-b','W-c','W-a']);
 addTasks(b,[spec(q.id,'W-d')],'/repo'); assert.equal(b.tasks.at(-1)!.id,'W-d'); assert.deepEqual(structuredClone(b).tasks.map(t=>t.id),b.tasks.map(t=>t.id));
});
test('insert does not bypass dependencies or preempt a live task', () => {
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a'),spec(q.id,'W-b',{dependsOn:['W-a']})],'/repo');
 moveTask(b,{id:'W-b',position:'front',reason:'urgent'}); assert.deepEqual(readyTasks(b).map(t=>t.id),['W-a']);
 markDispatched(b,'W-a','bridges','run-a'); assert.throws(()=>moveTask(b,{id:'W-a',position:'tail',reason:'urgent'}),/preempted/);
});
test('read/read parallel, exact write/write and write/read serialize; a bare directory path is not a scope ancestor', () => {
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a',{readPaths:['src'],writePaths:[]}),spec(q.id,'W-b',{readPaths:['src/a.ts'],writePaths:[]}),spec(q.id,'W-c',{writePaths:['src/a.ts']})],'/repo');
 assert.equal(taskConflict(b.tasks[0],b.tasks[1]),false); assert.equal(taskConflict(b.tasks[0],b.tasks[2]),false, 'W-120: src is one concrete path, not an ancestor of src/a.ts');
 // W-c writes the same file W-b reads, so the same-file rule still keeps it out of the batch.
 assert.deepEqual(dispatchBatch(b,3).map(t=>t.id),['W-a','W-b']); assert.equal(dispatchBatch(b,1).length,2, 'legacy batch limit cannot serialize independent readers');
});
test('an explicit directory scope reserves the entry only, never dot-prefixed descendants',()=>{
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a',{writePaths:['src/']}),spec(q.id,'W-b',{readPaths:['src/..config/a'],writePaths:[]})],'/repo'); assert.equal(taskConflict(b.tasks[0],b.tasks[1]),false,'W-120: W-a owns src/ only, W-b reads a distinct path under it');
});
test('relative scopes normalize and globs reject atomically',()=>{
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a',{writePaths:['src/../src/a']})],'/repo'); assert.deepEqual(b.tasks[0].writePaths,['/repo/src/a']); const before=structuredClone(b);
 assert.throws(()=>addTasks(b,[spec(q.id,'W-b'),spec(q.id,'W-c',{writePaths:['src/**']})],'/repo'),/globs/); assert.deepEqual(b,before);
});
test('DAG cycle, unknown dependencies, duplicate IDs, read-only role writes reject atomically',()=>{
 for(const items of [[spec('Q-1','W-a',{dependsOn:['W-b']}),spec('Q-1','W-b',{dependsOn:['W-a']})],[spec('Q-1','W-a',{dependsOn:['W-unknown']})],[spec('Q-1','W-a'),spec('Q-1','W-a')],[spec('Q-1','W-a',{role:'cp'})]]) {
  const {b}=fixture(); const before=structuredClone(b); assert.throws(()=>addTasks(b,items,'/repo')); assert.deepEqual(b,before);
 }
 const {b,q}=fixture();
 addTasks(b,[spec(q.id,'W-ayton-tests',{role:'ayton',writePaths:['tests/W-a.test.ts']})],'/repo');
 assert.deepEqual(b.tasks[0].writePaths,['/repo/tests/W-a.test.ts']);
 // Granularity guardrails: reject >3 ACs, multi-dir/code+tests/ bundling, >=6 writePaths unless splitWaiverReason
 assert.throws(()=>addTasks(b,[spec(q.id,'W-fat-ac',{acceptance:['a1','a2','a3','a4']})],'/repo'),/too coarse/);
 assert.throws(()=>addTasks(b,[spec(q.id,'W-fat-dirs',{writePaths:['src/a.ts','tests/']})],'/repo'),/generic tests\//);
 assert.throws(()=>addTasks(b,[spec(q.id,'W-fat-multi-dir',{writePaths:['src/','pkg/']})],'/repo'),/multi-directory locks/);
 assert.throws(()=>addTasks(b,[spec(q.id,'W-fat-files',{writePaths:['a.ts','b.ts','c.ts','d.ts','e.ts','f.ts']})],'/repo'),/too many writePaths/);
 addTasks(b,[spec(q.id,'W-waived',{acceptance:['a1','a2','a3','a4'],splitWaiverReason:'atomic single migration'})],'/repo');
 assert.equal(b.tasks.at(-1)!.splitWaiverReason,'atomic single migration');
});
test('reported is not done; verified return unlocks successors while unrelated child still runs',()=>{
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a'),spec(q.id,'W-b'),spec(q.id,'W-c',{dependsOn:['W-a']})],'/repo');
 markDispatched(b,'W-a','bridges','run-a'); markDispatched(b,'W-b','bridges','run-b'); observeTask(b,'run-a','child-a','completed');
 assert.equal(b.tasks[0].status,'reported'); assert.equal(readyTasks(b).length,0); accept(b,'W-a'); assert.deepEqual(dispatchBatch(b,1).map(t=>t.id),['W-c']); assert.equal(b.tasks[1].status,'running');
});
test('timeout/unknown retains scope lease; explicit stopped evidence permits blocked then retry',()=>{
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a'),spec(q.id,'W-b',{writePaths:['src/W-a.ts']})],'/repo'); markDispatched(b,'W-a','bridges','run-a');
 observeTask(b,'run-a','child-a','interrupted'); assert.equal(b.tasks[0].status,'uncertain'); assert.equal(readyTasks(b).length,0);
 assert.throws(()=>updateTask(b,{id:'W-a',status:'ready',evidence:['timeout'],reason:'guess'}),/still be live/);
 updateTask(b,{id:'W-a',status:'blocked',childStopped:true,evidence:['child process stopped: verified'],reason:'Main verified stopped'});
 updateTask(b,{id:'W-a',status:'ready',evidence:['correct role snapshot verified'],reason:'Resume safely'}); assert.throws(()=>markDispatched(b,'W-a','bridges','run-a2','wrong-child'),/resume/);
});
test('blocked/planned/running/reported/uncertain and unresolved requests all prevent completion',()=>{
 const {b,q}=fixture(); addBacklog(b,['remaining regression']); assert.ok(completionBlockers(b).some(s=>s.includes('planned'))); assert.ok(completionBlockers(b).some(s=>s.includes(q.id)));
 assert.throws(()=>resolveRequest(b,{id:q.id,status:'done',evidence:['x:1'],reason:'done'}),/unfinished/); accept(b,b.tasks[0].id); resolveRequest(b,{id:q.id,status:'done',evidence:['x:1'],reason:'verified'}); assert.deepEqual(completionBlockers(b),[]);
});
test('backlog is additive, repeated pending obligation dedupes; decomposition retains provenance',()=>{
 const {b,q}=fixture(); addBacklog(b,['original','original']); addBacklog(b,['additional']); assert.equal(b.tasks.length,2);
 addTasks(b,[spec(q.id,'W-replacement')],'/repo'); const original=b.tasks[0];
 assert.throws(()=>updateTask(b,{id:original.id,status:'superseded',evidence:['plan:1'],reason:'decomposed'}),/replacement/);
 updateTask(b,{id:original.id,status:'superseded',replacementIds:['W-replacement'],evidence:['plan:1'],reason:'decomposed'}); assert.equal(original.status,'superseded'); assert.ok(original.archivedAt); assert.ok(completionBlockers(b).some(s=>s.includes('W-replacement')));
});
test('acceptance auto-archives; default prompt omits completed work but archive preserves evidence',()=>{
 const {b,q}=fixture(); addTasks(b,[spec(q.id,'W-a')],'/repo'); accept(b,'W-a'); assert.ok(b.tasks[0].archivedAt); assert.doesNotMatch(ledgerPrompt(b,2),/W-a \[done\]/); assert.match(archivePrompt(b),/W-a \[done\].*test: exit 0/);
 assert.throws(()=>updateTask(b,{id:'W-a',status:'ready',evidence:['x:1'],reason:'redo'}),/immutable/);
});
test('goal request cannot bypass registered goal acceptance via generic resolve',()=>{
 const b=newLedger(); const q=addRequest(b,'root','goal:1','goal'); assert.throws(()=>resolveRequest(b,{id:q.id,status:'done',evidence:['x:1'],reason:'claimed'}),/team_goal/);
});
test('audit PASS does not erase prior nextTasks',()=>{
 let g=newGoal('goal',[]); g=applyAudit(g,{verdict:'REWORK',summary:'rework',evidence:['x:1'],nextTasks:['old task']}); g=applyAudit(g,{verdict:'PASS',summary:'stage passed',evidence:['x:2'],nextTasks:['new task']}); assert.deepEqual(g.nextTasks,['old task','new task']);
});
test('restored ledger is detached from historical branch snapshots',()=>{
 const {b,q}=fixture(); const cfg=defaultConfig(); const state=initialState(cfg); state.ledger=b;
 const entry={type:'custom',customType:'team-state',data:state}; const restored=stateFromEntries([entry],cfg).state; addRequest(restored.ledger!,'new','input:2'); assert.equal(entry.data.ledger!.requests.length,1); assert.equal(entry.data.ledger!.requests[0].id,q.id);
});
test('attempt identity wins over archived session reuse; stale old child cannot release a fresh retry',()=>{
 const {b,q}=fixture();addTasks(b,[spec(q.id,'W-a'),spec(q.id,'W-b')],'/repo');
 markDispatched(b,'W-a','bridges','old');observeTask(b,'old','same-child','completed');accept(b,'W-a');
 markDispatched(b,'W-b','bridges','new','same-child');assert.equal(observeTask(b,'new','same-child','completed'),true);assert.equal(b.tasks[1].status,'reported');
 updateTask(b,{id:'W-b',status:'ready',evidence:['new requirement'],reason:'Rework'});markDispatched(b,'W-b','bridges','fresh');assert.equal(b.tasks[1].sessionId,undefined);
 assert.equal(observeTask(b,'new','same-child','completed'),false);assert.equal(b.tasks[1].status,'running');
 assert.equal(observeTask(b,undefined,'same-child','completed'),false);assert.equal(b.tasks[1].status,'running');
});
test('old running session receipt survives over fifty later records',()=>{
 const entries=[{type:'custom',customType:'team-run',data:{taskId:'old',sessionId:'live-child',status:'running'}},...Array.from({length:55},(_,i)=>({type:'custom',customType:'team-run',data:{taskId:String(i),status:'ok'}}))]; assert.ok(stateFromEntries(entries,defaultConfig()).runs.some(r=>r.sessionId==='live-child'));
});
console.log(`\nTeam ledger unit tests: ${passed} passed`);
