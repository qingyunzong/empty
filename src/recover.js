import { existsSync } from 'node:fs';

// Three-state crash recovery for the patch write protocol:
//   old     - neither final file exists (tmp leftovers may remain): safe to clean tmp and rerun
//   new     - both final files exist: patch fully applied, run `audit check`
//   partial - exactly one final file renamed: DO NOT MIX; rollback the renamed file, then rerun
export function recoverState(outPath, certPath) {
  const out = existsSync(outPath);
  const cert = existsSync(certPath);
  const outTmp = existsSync(outPath + '.tmp');
  const certTmp = existsSync(certPath + '.tmp');
  const tmps = [outTmp ? outPath + '.tmp' : null, certTmp ? certPath + '.tmp' : null].filter(Boolean);

  if (out && cert) {
    const cleanup = tmps.length ? `; stale tmp files may be removed: rm ${tmps.join(' ')}` : '';
    return { state: 'new', message: `STATE new: patched log and certificate both present; verify with: audit check <old> ${outPath} ${certPath}${cleanup}` };
  }
  if (!out && !cert) {
    if (tmps.length) {
      return { state: 'old', message: `STATE old: crash before rename; originals untouched; rollback: rm ${tmps.join(' ')}` };
    }
    return { state: 'old', message: 'STATE old: no patch output present; nothing was applied' };
  }
  const stray = [out ? outPath : null, cert ? certPath : null, ...tmps].filter(Boolean);
  return {
    state: 'partial',
    message: `STATE partial: crash between renames; do NOT mix files; rollback: rm ${stray.join(' ')} then re-run audit patch`,
  };
}
