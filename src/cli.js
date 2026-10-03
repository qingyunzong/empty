import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compileSource } from './compiler.js';
import { VM, normalizeOrder } from './vm.js';
import { buildCertificate, verifyCertificate } from './cert.js';
import { FeeError } from './errors.js';

const USAGE = `usage:
  fee calc <contract.fee> <orders.json> [--cert]   compute fees, optionally emit certificates
  fee verify <contract.fee> <cert.json>            replay and verify certificates`;

export function runCli(argv, io = { out: console.log, err: console.error }) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'calc') {
      const wantCert = args.includes('--cert');
      const files = args.filter((a) => a !== '--cert');
      if (files.length !== 2) { io.err(USAGE); return 2; }
      const [contractPath, ordersPath] = files;
      const source = readFileSync(contractPath, 'utf8');
      const program = compileSource(source);
      const vm = new VM(program);
      const ordersDoc = JSON.parse(readFileSync(ordersPath, 'utf8'));
      const rawOrders = Array.isArray(ordersDoc) ? ordersDoc : ordersDoc.orders;
      if (!Array.isArray(rawOrders)) throw new FeeError('E_LEX', 'orders JSON must be an array or {orders: [...]}');

      const certs = [];
      for (const raw of rawOrders) {
        const order = normalizeOrder(raw, program);
        const result = vm.execute(order);
        const tieNote = result.ties.length > 1 ? ` ties=[${result.ties.join(',')}]` : '';
        io.out(
          `${result.orderId}: fee=${result.totalFee} ${program.currency ?? ''} residual=${result.residual} -> ${result.residualAccount} tiers=[${result.matchedTiers.join(',')}]${tieNote}`
        );
        if (wantCert) certs.push(buildCertificate(program, source, order, result));
      }
      if (wantCert) {
        const certPath = ordersPath.replace(/\.json$/i, '') + '.cert.json';
        writeFileSync(certPath, JSON.stringify({ version: 1, contractFile: basename(contractPath), certificates: certs }, null, 2));
        io.out(`certificates written to ${certPath}`);
      }
      return 0;
    }
    if (cmd === 'verify') {
      if (args.length !== 2) { io.err(USAGE); return 2; }
      const [contractPath, certPath] = args;
      const source = readFileSync(contractPath, 'utf8');
      const doc = JSON.parse(readFileSync(certPath, 'utf8'));
      const certs = doc.certificates ?? [];
      for (const cert of certs) {
        verifyCertificate(source, cert);
        io.out(`${cert.order.id}: OK (replayed ${cert.steps.length} steps, total=${cert.totalFee}, residual=${cert.residual} -> ${cert.residualAccount})`);
      }
      io.out(`verified ${certs.length} certificate(s)`);
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof FeeError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}
