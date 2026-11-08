import assert from 'node:assert/strict';

// Only the paid provider transport is replaced; app evaluation and SQLite remain real.
export function mockOpenRouter(t, { verdict = 'equivalent', solved = true } = {}) {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.response_format.json_schema.strict, true);
    const input = JSON.parse(body.messages[1].content);
    const solving = body.response_format.json_schema.name === 'independent_solution';
    const stage = body.response_format.json_schema.name;
    calls.push({ model: body.model, input, solving, stage });
    if (solving) assert.deepEqual(Object.keys(input), ['problem']);
    const complete = !input.referenceSolution || input.referenceSolution.length >= 70;
    const output = solving
      ? { answer: solved ? (verdict === 'different' ? '0' : input.problem.includes('nine') ? '511' : '16384') : '', reason: 'Provider fixture solver reasoning.', solved }
      : stage === 'reference_verification'
        ? { verdict: complete ? 'valid' : 'uncertain', reason: 'Provider fixture verification.', meetsRequirements: complete, requirementsReason: 'Provider fixture contract fit.' }
        : { verdict, reason: verdict === 'different' ? 'The solver answer 0 differs from the verified positive count.' : 'Provider fixture comparison.' };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }), { status: 200 });
  });
  return calls;
}
