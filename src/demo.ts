import { Cluster } from './cluster.js';
import { DominanceEvidence } from './siblings.js';

function showEvidence(title: string, evidence: readonly DominanceEvidence[]): void {
  console.log(`\n== ${title} ==`);
  const unique = [...new Set(evidence.map((e) => `[${e.relation}] ${e.detail}`))];
  if (unique.length === 0) console.log('  (no dominance decisions needed)');
  for (const line of unique) console.log(`  ${line}`);
}

const cluster = new Cluster<string>(['A', 'B', 'C']);

// 1. Sequential writes: v2 causally supersedes v1 -> v1 is retracted.
const w1 = cluster.write('A', 'stock', 'v1=10');
const w2 = cluster.write('B', 'stock', 'v2=9', w1.vv);
console.log(`wrote v1 @ ${w1.vv}, then v2 @ ${w2.vv} (context ${w1.vv})`);

// 2. Partition: A alone, {B,C} together. Concurrent writes on both sides.
cluster.partition([['A'], ['B', 'C']]);
const w3 = cluster.write('A', 'stock', 'v3=99', w2.vv); // A saw v2
const w4 = cluster.write('C', 'stock', 'v4=7', w2.vv);  // C saw v2, never saw v3
console.log(`partition {A}|{B,C}: wrote v3 @ ${w3.vv} on A, v4 @ ${w4.vv} on C`);

// 3. Read on C's side: contacts >= 2 replicas, repairs missing versions.
const outcome = cluster.read('C', 'stock');
console.log(`read via C contacted [${outcome.contacted}], conflict set: ${outcome.siblings.map((s) => `${s.value}@${s.vv}`).join(' , ')}`);
showEvidence('dominance evidence from read-merge', outcome.evidence);
for (const r of outcome.repairs) {
  console.log(`  read-repair -> ${r.replica} installed [${r.installed.join(', ')}]`);
}

// 4. Heal and sync: concurrent v3/v4 both survive; retracted v1/v2 stay gone.
cluster.heal();
const healEvidence: DominanceEvidence[] = [];
cluster.syncToFixpoint(healEvidence);
showEvidence('dominance evidence from heal sync', healEvidence);
console.log('\nfinal state (v1, v2 retracted for good; v3/v4 kept as conflict set):');
console.log(cluster.snapshot());
