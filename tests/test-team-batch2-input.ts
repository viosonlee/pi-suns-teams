import { strict as assert } from 'node:assert';
import { classifyUserInput, newLedger, addRequest, completionBlockers, ledgerPrompt } from '../team-ledger.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

test('classifier: pure gratitude/acknowledgment chatter is feedback', () => {
	for (const t of ['thanks!', 'Thank you so much', 'great', 'ok', 'got it', 'lgtm', 'sounds good']) {
		assert.equal(classifyUserInput(t), 'feedback', JSON.stringify(t));
	}
});

test('rework-H3: steering/approval tokens are WORK, never silently absorbed', () => {
	for (const t of ['continue', 'go ahead', 'proceed', 'carry on', 'keep going', 'sure', 'yes', 'stop everything now', 'this is critical and broken']) {
		assert.equal(classifyUserInput(t), 'work', JSON.stringify(t));
	}
	// mixed feedback + instruction is still work
	assert.equal(classifyUserInput('thanks, now fix the build'), 'work');
});

test('classifier: status queries without action content are feedback', () => {
	for (const t of ["what's the status?", 'how is it going', 'status?', 'are you done?']) {
		assert.equal(classifyUserInput(t), 'feedback', JSON.stringify(t));
	}
});

test('classifier: action-bearing input is work even when polite', () => {
	for (const t of [
		'thanks, now implement the login flow',
		'fix the bug in src/auth.ts',
		'please update the readme',
		'run the tests',
		'great — next deploy to staging',
		'why does auth.ts fail?',
		'what changed in team-ledger.ts?',
	]) {
		assert.equal(classifyUserInput(t), 'work', JSON.stringify(t));
	}
});

test('classifier: ambiguous input defaults to work (never silently drops a request)', () => {
	assert.equal(classifyUserInput('hmm interesting observation about the cache layer'), 'work');
	assert.equal(classifyUserInput('the colors look off'), 'work');
	assert.equal(classifyUserInput(''), 'work');
});

test('feedback requests never block completion and stay out of the obligation queue', () => {
	const board = newLedger();
	addRequest(board, 'thanks, looks perfect', 'input:Q-1', 'feedback');
	assert.deepEqual(completionBlockers(board).filter(b => b.includes('unresolved user request')), [], 'feedback is not a user-request blocker');
	const prompt = ledgerPrompt(board);
	assert.ok(!prompt.includes('looks perfect') || prompt.includes('feedback note'), 'feedback text not listed as an obligation');
	assert.ok(prompt.includes('feedback note(s) absorbed'), 'absorption is disclosed');
	// a real user request in the same board still blocks
	addRequest(board, 'implement the thing', 'input:Q-2', 'user');
	assert.ok(completionBlockers(board).some(b => b.includes('unresolved user request')), 'user request still blocks');
});

console.log(`\n${passed} assertions passed`);
