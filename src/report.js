export function formatJournal(vm) {
  const lines = ['== Ledger =='];
  for (const e of vm.journal) {
    switch (e.type) {
      case 'APPLY':
        lines.push(`APPLY ${e.id} ${e.kind} ${e.security} v${e.version} ex=${e.exdate} #${e.hash} cash=${e.cashDelta}`);
        break;
      case 'SELL':
        lines.push(`SELL ${e.security} ${e.qty} on ${e.date} (${e.allocations.map((a) => `${a.lotId}:${a.qty}`).join(', ')})`);
        break;
      case 'REVERSE':
        lines.push(`REVERSE ${e.id} inverse-of=${e.reverseOf} ${e.kind} ${e.security} v${e.version} cash=${e.cashDelta}`);
        break;
      case 'RESTATED':
        lines.push(`RESTATED ${e.id} ${e.security} v${e.fromVersion} -> v${e.toVersion}`);
        break;
      case 'RECEIVABLE':
        lines.push(`RECEIVABLE ${e.security} ${e.qty} (${e.reason})`);
        break;
      default:
        lines.push(JSON.stringify(e));
    }
  }
  return lines.join('\n');
}

export function formatState(vm) {
  const lines = ['== Positions =='];
  const positions = vm.positions();
  if (positions.length === 0) lines.push('(none)');
  for (const l of positions) lines.push(`${l.security} ${l.id} ${l.qty} acquired=${l.acquired}`);
  lines.push('== Cash ==');
  lines.push(vm.cash.toString());
  lines.push('== Receivables ==');
  if (vm.receivables.length === 0) lines.push('(none)');
  for (const r of vm.receivables) lines.push(`${r.security} ${r.qty} (${r.reason})`);
  return lines.join('\n');
}
