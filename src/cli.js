import { readFileSync, writeFileSync } from 'node:fs';
import { compileContract, runOrders } from './runtime.js';
import { buildCert, verifyCertificate } from './cert.js';

const USAGE = `usage:
  fee calc <contract.fee> <orders.json> [--cert[=path]]
  fee verify <contract.fee> <orders.json> <cert.json>`;

// Returns { code, stdout, stderr } so it can be tested in-process.
export function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const fail = (code, message) => {
    stderr += `${JSON.stringify({ error: { code, message } })}\n`;
    return { code: 1, stdout, stderr };
  };
  const readJson = (path, what) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw Object.assign(new Error(`cannot read ${what} '${path}': ${e.message}`), { code: 'E_LEX' });
    }
  };

  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'calc') {
      const [contractPath, ordersPath, ...flags] = rest;
      if (!contractPath || !ordersPath) return fail('E_USAGE', USAGE);
      const contract = compileContract(readFileSync(contractPath, 'utf8'));
      const ordersRaw = readJson(ordersPath, 'orders file');
      const report = runOrders(contract, ordersRaw);
      const hasError = report.results.some((r) => r.error);
      stdout += `${JSON.stringify(report, null, 2)}\n`;
      const certFlag = flags.find((f) => f === '--cert' || f.startsWith('--cert='));
      if (certFlag) {
        if (hasError) {
          stderr += 'certificate not written: some orders failed\n';
        } else {
          const cert = buildCert(contract, ordersRaw, report.results);
          const out = certFlag.startsWith('--cert=')
            ? certFlag.slice('--cert='.length)
            : ordersPath.replace(/\.json$/, '') + '.cert.json';
          writeFileSync(out, JSON.stringify(cert, null, 2));
          stderr += `certificate written to ${out}\n`;
        }
      }
      return { code: hasError ? 1 : 0, stdout, stderr };
    }
    if (cmd === 'verify') {
      const [contractPath, ordersPath, certPath] = rest;
      if (!contractPath || !ordersPath || !certPath) return fail('E_USAGE', USAGE);
      const source = readFileSync(contractPath, 'utf8');
      const ordersRaw = readJson(ordersPath, 'orders file');
      const cert = readJson(certPath, 'certificate file');
      verifyCertificate(source, ordersRaw, cert);
      stdout += 'OK\n';
      return { code: 0, stdout, stderr };
    }
    return fail('E_USAGE', USAGE);
  } catch (e) {
    return fail(e.code ?? 'E_INTERNAL', e.message);
  }
}
