import { PermissionStore } from '../src/store.js';
import { format } from '../src/vectorClock.js';

function show(title: string, store: PermissionStore): void {
  console.log(`\n== ${title} ==`);
  console.log(`causal version: ${format(store.version())}`);
  const eff = store.effective();
  if (eff.size === 0) {
    console.log('(no effective permissions)');
    return;
  }
  for (const { perm, sources } of eff.values()) {
    console.log(`effective: ${perm}`);
    for (const s of sources) {
      console.log(`  <- source grant ${s.opId} by ${s.actor} @ ${format(s.clock)}`);
    }
  }
}

// Replica A grants, replica B concurrently revokes the same permission.
const a = new PermissionStore('A');
const b = new PermissionStore('B');

const g1 = a.grant('doc:read');
const r1 = b.revoke('doc:read'); // concurrent with g1 -> remove-wins
console.log(`g1 = ${g1.id} @ ${format(g1.clock)}`);
console.log(`r1 = ${r1.id} @ ${format(r1.clock)}  (concurrent with g1)`);

// Deliver OUT OF ORDER: revoke arrives at A before the grant reaches B.
a.apply(r1);
b.apply(g1);
show('after concurrent grant+revoke (remove-wins)', a);

// A causally-later grant restores the permission.
const g2 = a.grant('doc:read'); // A has seen r1, so g2 happens after it
console.log(`\ng2 = ${g2.id} @ ${format(g2.clock)}  (causally after r1 -> restores)`);
b.apply(g2);
show('after causally-later grant (restored)', a);

// State-based merge converges B to the same view.
b.mergeFrom(a);
a.mergeFrom(b);
console.log(`\nconverged: ${a.describe() === b.describe()}`);
console.log('B view:');
console.log(b.describe());
