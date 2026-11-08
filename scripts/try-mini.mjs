import { readFile } from 'node:fs/promises';
import { evaluateSubmission } from '../server/evaluate.mjs';

if (process.argv.includes('--help')) {
  console.log('Usage: npm run try:mini\nRuns the coin-pattern example through real GPT-4.1-mini verification, solving and comparison.\nReads OPENROUTER_API_KEY from .env. Uses OpenRouter credits. Does not write to SQLite.');
} else {
  try {
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      throw new Error('Set OPENROUTER_API_KEY in .env, then run npm run try:mini.');
    }
    // Pin this experiment even if the app is configured to use another model.
    process.env.OPENROUTER_MODEL = 'openai/gpt-4.1-mini';
    const example = JSON.parse(await readFile(new URL('./examples/coin-patterns.json', import.meta.url), 'utf8'));
    console.log(`Model: ${process.env.OPENROUTER_MODEL}\nProblem: ${example.title}\n${example.problem}\nReference answer: ${example.answer}\n`);
    const started = Date.now();
    const stages = { verification: 'Verifying the reference solution', solve: 'Solving independently (problem only)', comparison: 'Comparing the answers' };
    const result = await evaluateSubmission({
      ...example,
      contract: {
        title: 'Probability for reasoning models', domain: 'Probability', difficulty: 'Advanced', reward: 175,
        description: 'Probability questions with transparent, auditable solutions.',
        requirements: ['Define the sample space and independence assumptions.', 'Provide an exact probability and reasoning.', 'Check edge cases and explain conditioning.'],
      },
      onProgress: result => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${stages[result.phase]}…`),
    });
    console.log('\nFull evaluation:\n' + JSON.stringify(result, null, 2));
    const outcome = result.status === 'accepted'
      ? 'STUMPED: verification passed and comparison confirmed a wrong AI answer.'
      : result.comparison?.verdict === 'equivalent'
        ? 'NOT STUMPED: the AI produced an equivalent, supported answer.'
        : 'INCONCLUSIVE: this run did not establish a confirmed wrong AI answer.';
    console.log(`\n${outcome}\nElapsed: ${((Date.now() - started) / 1000).toFixed(1)}s. No submission or reward was saved.`);
  } catch (error) {
    console.error(`\nTest failed: ${error.message}`);
    process.exitCode = 1;
  }
}
