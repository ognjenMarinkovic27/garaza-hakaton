import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestClient } from './request-client.mjs';
import { createApp } from '../server/app.mjs';
import { mockOpenRouter } from './openrouter-fixture.mjs';

// Exercise public request/response contracts with real SQLite. Inject streams into
// the HTTP request listener so this suite also runs where binding ports is prohibited.
test('buyer posts a contract; expert can resubmit the same problem; buyer sees persisted evaluation', async t => {
  const calls = mockOpenRouter(t, { verdict: 'different' });
  const dataDir = await mkdtemp(join(tmpdir(), 'proof-journey-'));
  let server;
  async function start() {
    server = createApp({ dataDir });
    return server;
  }
  await start();
  let client = requestClient(server);
  async function request(path, body) {
    const response = await client(path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  try {
    const seed = await request('/api/state');
    assert.equal(seed.status, 200);
    assert.equal(seed.data.contracts.length, 3);
    assert.ok(seed.data.submissions.length >= 4);
    const forbidden = await request('/api/contracts', {});
    assert.equal(forbidden.status, 403);
    await request('/api/session', { role: 'buyer' });
    const created = await request('/api/contracts', {
      title: 'Original finite counting problems', domain: 'Combinatorics', difficulty: 'Advanced',
      description: 'Counting tasks with complete, independently checkable proofs for a research dataset.',
      requirements: 'State all assumptions and include a complete worked solution and final answer.',
      budget: 1000, reward: 100, target: 10, deadline: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created));
    const contract = created.data;
    assert.ok(contract.id);
    await request('/api/session', { role: 'expert' });
    const submission = {
      contractId: contract.id, title: 'Nonempty subsets of a nine-element set',
      problem: 'A collection contains nine distinguishable tokens. How many nonempty subsets of this collection can be selected? Give an exact integer and justify the count.',
      answer: '511',
      solution: 'Each of the nine distinguishable tokens can either be included or excluded independently. Thus there are 2^9 = 512 subsets altogether. Exactly one of these is empty, so removing that subset leaves 512 - 1 = 511 nonempty subsets. Every selection has a unique inclusion vector, so no subset is counted twice.',
    };
    const incomplete = await request('/api/submissions', { ...submission, solution: 'Choose independently for each token, then remove the empty set.' });
    assert.equal(incomplete.data.status, 'needs_revision');
    const sent = await request('/api/submissions', submission);
    assert.ok([200, 201].includes(sent.status), JSON.stringify(sent));
    assert.equal(sent.data.status, 'accepted', JSON.stringify(sent.data));
    assert.equal(sent.data.payout, 100);
    assert.deepEqual(calls.map(c=>c.stage), ['reference_verification','reference_verification','independent_solution','answer_comparison']);
    assert.equal(calls[1].input.independentSolve, undefined);
    assert.deepEqual(Object.keys(calls[2].input), ['problem']);
    assert.ok(calls[3].input.independentSolve);
    assert.equal(sent.data.evaluation.mode, 'openrouter');
    assert.deepEqual(sent.data.evaluation.comparison, { verdict: 'different', matches: false, reason: 'The solver answer 0 differs from the verified positive count.' });
    const duplicate = await request('/api/submissions', { ...submission, title: 'A duplicate submission' });
    assert.ok([200, 201].includes(duplicate.status), JSON.stringify(duplicate));
    assert.equal(duplicate.data.status, 'accepted');
    assert.equal(duplicate.data.payout, sent.data.payout);
    assert.equal(calls.length, 7, 'repeated submissions receive an independent evaluation');
    assert.equal(new Set(calls.map(call => call.model)).size, 1);
    server.emit('close');
    await start();
    client = requestClient(server);
    await request('/api/session', { role: 'buyer' });
    const persisted = await request('/api/state');
    assert.ok(persisted.data.contracts.some(row => row.id === contract.id));
    const row = persisted.data.submissions.find(row => row.id === sent.data.id);
    assert.equal(row.payout, sent.data.payout);
    assert.deepEqual(row.evaluation.comparison, sent.data.evaluation.comparison);
    assert.equal(row.evaluation.quality, undefined);
  } finally {
    if (server) server.emit('close');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('failed evaluation remains visible and can be retried without a second submission', async t => {
  const calls = mockOpenRouter(t, { verdict: 'different' });
  const dataDir = await mkdtemp(join(tmpdir(), 'proof-retry-'));
  const { evaluateSubmission } = await import('../server/evaluate.mjs');
  let unavailable = true;
  const server = createApp({ dataDir, evaluator: async input => {
    if (unavailable) throw new Error('OpenRouter unavailable. Please retry.');
    return evaluateSubmission(input);
  } });
  const request = requestClient(server);
  try {
    const result = await request('/api/submissions', { method: 'POST', body: JSON.stringify({
      contractId: 'probability', title: 'Words over a four-symbol alphabet',
      problem: 'How many length-seven words can be made from four distinct symbols when repetitions are allowed?',
      answer: '16384', solution: 'At each of the seven positions there are exactly four independent choices. Applying the multiplication principle gives 4^7 = 16384 words. Each sequence of choices yields exactly one word, so every word is counted once.',
    }) });
    const failed = await result.json();
    assert.equal(failed.status, 'error');
    assert.equal(failed.payout, 0);
    assert.match(failed.error, /unavailable/);
    unavailable = false;
    const retry = await request(`/api/submissions/${failed.id}/retry`, { method: 'POST', body: '{}' });
    const recovered = await retry.json();
    assert.equal(recovered.id, failed.id);
    assert.equal(recovered.status, 'accepted');
    assert.ok(recovered.payout > 0);
    const state = await (await request('/api/state')).json();
    assert.equal(state.submissions.filter(row => row.id === failed.id).length, 1);
    const again = await request(`/api/submissions/${failed.id}/retry`, { method: 'POST', body: '{}' });
    assert.equal(again.status, 409);
  } finally {
    server.emit('close');
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('missing OpenRouter credentials fail visibly rather than simulating success', async t => {
  const calls = mockOpenRouter(t);
  delete process.env.OPENROUTER_API_KEY;
  const dataDir = await mkdtemp(join(tmpdir(), 'proof-key-'));
  const server = createApp({ dataDir });
  const request = requestClient(server);
  try {
    const result = await request('/api/submissions', { method: 'POST', body: JSON.stringify({
      contractId: 'probability', title: 'Two independent fair coin flips',
      problem: 'Two fair coins are tossed independently. What is the probability that both outcomes are heads?',
      answer: '1/4', solution: 'Each coin has probability one half of landing heads. Independence makes the joint probability the product (1/2)(1/2)=1/4.',
    }) });
    const record = await result.json();
    assert.equal(record.status, 'error');
    assert.equal(record.payout, 0);
    assert.match(record.error, /OPENROUTER_API_KEY/);
    assert.equal(calls.length, 0);
    const state = await (await request('/api/state')).json();
    assert.ok(!JSON.stringify(state).includes('test-key'));
  } finally { server.emit('close'); await rm(dataDir, { recursive: true, force: true }); }
});

test('background pipeline exposes real stages and preserves completed work on failure', async t => {
  mockOpenRouter(t);
  const provider = globalThis.fetch;
  const gates = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve, reject) => {
    gates.push({ stage: JSON.parse(options.body).response_format.json_schema.name,
      finish: () => provider(url, options).then(resolve, reject), reject });
  }));
  const dataDir = await mkdtemp(join(tmpdir(), 'pipeline-stages-'));
  const server = createApp({ dataDir });
  const request = requestClient(server);
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const response = await request('/api/submissions?background=1', { method:'POST', body:JSON.stringify({
      contractId:'probability', title:'Four symbols, seven positions',
      problem:'How many length-seven words can be made from four distinct symbols when repetitions are allowed?',
      answer:'16384', solution:'Each of the seven positions has four independent choices. The multiplication principle gives 4^7 = 16384, with each word counted exactly once.',
    }) });
    assert.equal(response.status, 202);
    const saved = await response.json();
    const current = async () => (await (await request('/api/state')).json()).submissions.find(s => s.id === saved.id);
    assert.equal((await current()).evaluation.phase, 'verification');
    assert.equal(gates[0].stage, 'reference_verification');
    await gates[0].finish(); await tick();
    assert.equal((await current()).evaluation.phase, 'solve');
    assert.equal(gates[1].stage, 'independent_solution');
    await gates[1].finish(); await tick();
    const comparing = await current();
    assert.equal(comparing.evaluation.phase, 'comparison');
    assert.ok(comparing.evaluation.solve.answer);
    assert.equal(gates[2].stage, 'answer_comparison');
    gates[2].reject(new Error('Transport interrupted')); await tick();
    const failed = await current();
    assert.equal(failed.status, 'error');
    assert.equal(failed.payout, 0);
    assert.ok(failed.evaluation.verification.valid);
    assert.ok(failed.evaluation.solve.answer);
    assert.equal(failed.evaluation.comparison, null);
  } finally { server.emit('close'); await rm(dataDir, { recursive:true, force:true }); }
});

for (const [verdict, solved, expected] of [
  ['equivalent', true, 'rejected'],
  ['different', true, 'accepted'],
  ['uncertain', true, 'needs_revision'],
  ['uncertain', false, 'needs_revision'],
  ['different', false, 'needs_revision'],
]) {
  test(`acceptance gate: ${verdict}, solver claimed solved=${solved}`, async t => {
    mockOpenRouter(t, { verdict, solved });
    const { evaluateSubmission } = await import('../server/evaluate.mjs');
    const result = await evaluateSubmission({
      problem: 'How many nonempty subsets of nine distinct objects are there?', answer: '511',
      solution: 'Each object is either included or excluded independently, giving 2^9 subsets. Remove the empty subset to obtain 511.',
      contract: { title: 'Counting problems', reward: 100, requirements: [] },
    });
    assert.equal(result.status, expected);
    assert.equal(result.payout, expected === 'accepted' ? 100 : 0);
    assert.ok(result.acceptanceReason);
  });
}
