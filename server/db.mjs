import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const USERS = {
  expert: { name: 'Dr. Maya Chen', organization: 'Independent mathematician' },
  buyer: { name: 'Alex Morgan', organization: 'Atlas AI' },
};

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'proof-market.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  const list = (table) => db.prepare(`SELECT data FROM ${table} ORDER BY rowid DESC`).all().map(row => JSON.parse(row.data));
  const get = (table, id) => { const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id); return row ? JSON.parse(row.data) : null; };
  const put = (table, record) => { db.prepare(`INSERT INTO ${table}(id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, JSON.stringify(record)); return record; };
  const store = {
    contracts: () => list('contracts'), submissions: () => list('submissions'),
    contract: id => get('contracts', id), submission: id => get('submissions', id),
    saveContract: record => put('contracts', record), saveSubmission: record => put('submissions', record),
    close: () => db.close(),
  };
  if (!db.prepare('SELECT id FROM contracts LIMIT 1').get()) seed(store);
  // A process restart cannot resume an interrupted local evaluation automatically.
  for (const record of store.submissions().filter(s => s.status === 'evaluating')) {
    store.saveSubmission({ ...record, status: 'error', error: 'Evaluation was interrupted. Retry this submission.', payout: 0 });
  }
  return store;
}

function seed(store) {
  const now = Date.now();
  const iso = (days) => new Date(now + days * 86400000).toISOString();
  const contracts = [
    ['number-theory', 'Olympiad number theory', 'Atlas AI', 'Number theory', 'Olympiad', 'Number theory problems that reward structured reasoning, not memorized tricks.', ['Include a complete proof with every divisibility argument justified.', 'Use elementary methods and state all integer domains.', 'State the final conclusion clearly.'], 18000, 180, 100],
    ['geometry', 'Geometry with rigorous proofs', 'Northstar Research', 'Geometry', 'Olympiad', 'Build a collection of self-contained geometry challenges with clear textual constructions.', ['The statement must be solvable without a diagram.', 'Prove all geometric claims with exact reasoning.', 'Prefer synthetic approaches with an analytic cross-check.'], 24000, 240, 100],
    ['probability', 'Probability for reasoning models', 'Helix Labs', 'Probability', 'Advanced', 'Build intuition-testing probability questions with transparent, auditable solutions.', ['Define the sample space and independence assumptions.', 'Provide an exact probability and reasoning.', 'Check edge cases and explain conditioning.'], 14000, 175, 80],
  ];
  contracts.forEach(([id, title, buyer, domain, difficulty, description, requirements, budget, reward, target], index) => store.saveContract({ id, title, buyer, domain, difficulty, description, requirements, budget, reward, target, deadline: iso(21 + index * 4).slice(0, 10), createdAt: iso(-12 + index), status: 'open' }));
  const rows = [
    ['number-theory','A prime divisibility constraint','Prove that for every integer n, the integer n^5 - n is divisible by 5.','5 divides n^5 - n.','If 5 divides n the claim is immediate. Otherwise Fermat’s little theorem gives n^4 ≡ 1 (mod 5); multiplying by n gives n^5 ≡ n (mod 5). Thus every integer n satisfies the claim.'],
    ['geometry','A median and its length','A triangle has side lengths 13, 14, and 15. Find the median to the side of length 14.','sqrt(148) = 2 sqrt(37)','By Apollonius’s theorem, the median has squared length (2·13² + 2·15² - 14²)/4 = (338 + 450 - 196)/4 = 148. Taking its positive square root gives 2 sqrt(37).'],
    ['probability','A waiting-time calculation','A fair die is rolled until a six first appears. What is the expected number of rolls, including the final roll?','6','Let E be the expected number of rolls. The first roll always contributes one. With probability 5/6 the process restarts independently, so E=1+(5/6)E. Solving gives E=6.'],
    ['number-theory','Parity in consecutive products','Show that the product of any three consecutive integers is divisible by 6.','The product is divisible by 6.','Among three consecutive integers at least one is even, and exactly one is divisible by 3. As 2 and 3 are coprime, their product 6 divides the product of the three integers.'],
  ];
  rows.forEach(([contractId,title,problem,answer,solution], index) => {
    const contract=store.contract(contractId); if (!contract) return; const valid=true; const payout=contract.reward;
    store.saveSubmission({ id:`seed-${index+1}`,contractId,title,problem,answer,solution,expert:index%3===0?'Dr. Maya Chen':['Dr. Maya Chen','Elena Rossi','Samir Patel'][index%3],status:valid?'accepted':'needs_revision',createdAt:iso(-7+index*0.7),payout,evaluation:{status:valid?'accepted':'needs_revision',mode:'seeded',model:'Sample record',verification:{valid,reason:valid?'Seeded example: complete reasoning and a consistent final answer.':'The claim needs a,b nonzero with the same sign; a=1,b=-1 is a counterexample.'},solve:{solved:valid,answer:valid?answer:'Counterexample: a=1, b=-1 gives -2.',reason:valid?'Seeded example solution agrees with the supplied answer.':'The statement is false for arbitrary real numbers.'},payout}});
  });
}
