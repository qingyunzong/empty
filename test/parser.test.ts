import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTROL_SEQUENCES,
  c0Effect,
  csiEffect,
  SessionParser,
  type CommandRecord,
  type Segment,
} from '../src/index.ts';

/** Deterministic PRNG so random chunkings are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomChunks(text: string, rng: () => number): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(rng() * Math.min(17, text.length - i));
    chunks.push(text.slice(i, i + size));
    i += size;
  }
  return chunks;
}

interface Snapshot {
  visible: string;
  result: string;
  segments: Segment[];
  commands: CommandRecord[];
  sent: string;
  truncated: boolean;
}

function snapshot(p: SessionParser): Snapshot {
  return {
    visible: p.getVisibleText(),
    result: p.getResult(),
    segments: p.getSegments(),
    commands: p.getCommands(),
    sent: p.getSentBytes(),
    truncated: p.isTruncated(),
  };
}

test('public control-sequence table is finite and complete', () => {
  assert.ok(Array.isArray(CONTROL_SEQUENCES));
  assert.equal(CONTROL_SEQUENCES.length, 13);
  assert.deepEqual(c0Effect(0x0a), { type: 'lineFeed' });
  assert.deepEqual(c0Effect(0x0d), { type: 'carriageReturn' });
  assert.deepEqual(csiEffect('D', [3]), { type: 'cursorBack', count: 3 });
  assert.deepEqual(csiEffect('K', []), { type: 'eraseInLine', mode: 0 });
  // SGR and other unlisted sequences are not in the table.
  assert.equal(csiEffect('m', [1, 31]), null);
  assert.equal(c0Effect(0x00), null);
});

test('echo is kept apart from the program result', () => {
  const p = new SessionParser();
  p.sendCommand('echo hi');
  p.feed('echo hi\r\nhi\r\n');
  p.end();
  assert.equal(p.getResult(), 'hi');
  assert.equal(p.getVisibleText(), 'echo hi\nhi\n');
  const [cmd] = p.getCommands();
  assert.equal(cmd.status, 'completed');
  assert.equal(cmd.echo, 'echo hi\r\n');
  assert.equal(cmd.output, 'hi');
  assert.equal(cmd.sent, 'echo hi\r');
  assert.equal(cmd.sentOffset, 0);
  assert.equal(p.getSentBytes(), 'echo hi\r');
  const kinds = p.getSegments().map((s) => `${s.kind}:${s.text}`);
  assert.deepEqual(kinds, ['echo:echo hi', 'output:hi']);
});

test('sent bytes are retained across multiple commands', () => {
  const p = new SessionParser();
  p.sendCommand('ls -la');
  p.sendCommand('pwd');
  p.feed('ls -la\r\nout1\r\npwd\r\nout2\r\n');
  p.end();
  assert.equal(p.getSentBytes(), 'ls -la\r' + 'pwd\r');
  const [ls, pwd] = p.getCommands();
  assert.equal(ls.sentOffset, 0);
  assert.equal(pwd.sentOffset, 7);
  assert.equal(ls.status, 'completed');
  assert.equal(pwd.status, 'completed');
  assert.equal(p.getResult(), 'out1out2');
});

test('raw sent bytes are retained and matched as echo', () => {
  const p = new SessionParser();
  p.send('abc');
  p.feed('abc\r\n');
  p.end();
  assert.equal(p.getSentBytes(), 'abc');
  assert.deepEqual(
    p.getSegments().map((s) => s.kind),
    ['echo'],
  );
  assert.equal(p.getResult(), '');
});

test('control sequences from the table shape the visible text', () => {
  const p = new SessionParser();
  p.feed(
    'abc\b\bXY\r\n' + // backspace overwrite -> aXY
      'foo\x1b[2D!\r\n' + // cursor back -> f!o
      'abcdef\r\x1b[Kxy\r\n' + // erase to end of line -> xy
      'a\tb\r\n' + // tab to column 8
      'hello\x1b[1P!\r\n' + // delete char at cursor... cursor at end: no-op
      'xy\x1b[2D\x1b[1P\r\n' + // cursor to col 0, delete 'x' -> y
      'ab\x1b[1D\x1b[@Z\r\n', // insert space then overwrite with Z -> aZb
  );
  p.end();
  assert.equal(
    p.getVisibleText(),
    ['aXY', 'f!o', 'xy', 'a       b', 'hello!', 'y', 'aZb', ''].join('\n'),
  );
});

test('sequences outside the table are consumed and ignored', () => {
  const p = new SessionParser();
  p.feed('\x1b[1;31mred\x1b[0m!\r\n'); // SGR
  p.feed('\x1b]0;window title\x07ok\r\n'); // OSC terminated by BEL
  p.feed('\x1b]8;;http://x\x1b\\link\r\n'); // OSC terminated by ST
  p.feed('\x1b7save\x1b8\r\n'); // two-char escapes
  p.feed('\x00\x01done\r\n'); // unlisted C0 bytes
  p.end();
  assert.equal(p.getVisibleText(), ['red!', 'ok', 'link', 'save', 'done', ''].join('\n'));
  assert.equal(p.getResult(), 'red!oklinksavedone');
});

test('truncated command is marked incomplete at end()', () => {
  const p = new SessionParser();
  p.sendCommand('run-tests');
  p.feed('run'); // only a prefix of the echo ever arrives
  p.end();
  const [cmd] = p.getCommands();
  assert.equal(cmd.status, 'incomplete');
  assert.equal(cmd.echo, 'run');
  assert.equal(p.getResult(), '');
});

test('echo mismatch marks the command incomplete and stays output', () => {
  const p = new SessionParser();
  p.sendCommand('ls');
  p.feed('XX\r\n'); // terminal never echoed the command
  p.end();
  const [cmd] = p.getCommands();
  assert.equal(cmd.status, 'incomplete');
  assert.equal(cmd.echo, '');
  assert.equal(p.getResult(), 'XX');
});

test('echo diverging mid-command marks the command incomplete', () => {
  const p = new SessionParser();
  p.sendCommand('list');
  p.feed('liZZ\r\n'); // echo starts, then diverges from what was sent
  p.end();
  const [cmd] = p.getCommands();
  assert.equal(cmd.status, 'incomplete');
  assert.equal(cmd.echo, 'li');
  assert.equal(p.getResult(), 'ZZ');
});

test('stream ending mid control sequence is flagged truncated', () => {
  const p = new SessionParser();
  p.sendCommand('cat');
  p.feed('cat\r\npartial\x1b[3;');
  p.end();
  assert.equal(p.isTruncated(), true);
  assert.equal(p.getVisibleText(), 'cat\npartial');
  const [cmd] = p.getCommands();
  assert.equal(cmd.status, 'completed'); // echo itself was complete
});

test('segment offsets point into the original received stream', () => {
  const p = new SessionParser();
  p.sendCommand('echo café');
  const received = 'echo café\r\nCAFÉ \x1b[1mbright\x1b[0m done\r\n';
  p.feed(received);
  p.end();
  for (const seg of p.getSegments()) {
    const slice = Buffer.from(received, 'utf8').slice(seg.start, seg.end).toString('utf8');
    assert.equal(slice, seg.text);
  }
  // 'CAFÉ ' starts right after 'echo café\r\n' = 9 + 2 = 11 bytes... compute:
  const echoBytes = Buffer.byteLength('echo café\r\n', 'utf8');
  const firstOutput = p.getSegments().find((s) => s.kind === 'output')!;
  assert.equal(firstOutput.start, echoBytes);
});

function buildSession(p: SessionParser): string {
  p.sendCommand('echo hello');
  const received =
    'echo hello\r\n' + // echo of the command
    'hello world\r\n' + // program output
    'abc\b\bXY\r\n' + // backspaces
    '\x1b[1;31mred\x1b[0m\r\n' + // unknown SGR ignored
    'foo\x1b[2D!\r\n' + // cursor back
    'abcdef\r\x1b[Kxy\r\n' + // erase in line
    'a\tb\x1b]0;t\x07c\r\n' + // tab + OSC
    'caf\u00e9 \x1b[2D!!\r\n'; // multibyte + cursor move
  p.feed(received);
  return received;
}

test('arbitrary chunking matches whole-block interpretation', () => {
  const whole = new SessionParser();
  buildSession(whole);
  whole.end();
  const expected = snapshot(whole);

  const rng = mulberry32(0xc0ffee);
  for (let trial = 0; trial < 200; trial++) {
    const p = new SessionParser();
    const received = buildSessionReplay(p, rng);
    p.end();
    assert.deepEqual(snapshot(p), expected, `trial ${trial} chunks=${received}`);
  }
});

function buildSessionReplay(p: SessionParser, rng: () => number): number {
  p.sendCommand('echo hello');
  const received =
    'echo hello\r\n' +
    'hello world\r\n' +
    'abc\b\bXY\r\n' +
    '\x1b[1;31mred\x1b[0m\r\n' +
    'foo\x1b[2D!\r\n' +
    'abcdef\r\x1b[Kxy\r\n' +
    'a\tb\x1b]0;t\x07c\r\n' +
    'caf\u00e9 \x1b[2D!!\r\n';
  // Feed as buffers in random byte-sized chunks (may split UTF-8 sequences).
  const bytes = Buffer.from(received, 'utf8');
  let i = 0;
  let chunks = 0;
  while (i < bytes.length) {
    const size = 1 + Math.floor(rng() * Math.min(11, bytes.length - i));
    p.feed(bytes.slice(i, i + size));
    i += size;
    chunks++;
  }
  return chunks;
}

test('every two-way split of a tricky stream matches the whole', () => {
  const received =
    'cmd\r\nout\x1b[2Kline\r\n\x1b[1;1Hend \u00e9\x1b[K\r\n';
  const whole = new SessionParser();
  whole.sendCommand('cmd');
  whole.feed(received);
  whole.end();
  const expected = snapshot(whole);
  const bytes = Buffer.from(received, 'utf8');
  for (let cut = 1; cut < bytes.length; cut++) {
    const p = new SessionParser();
    p.sendCommand('cmd');
    p.feed(bytes.slice(0, cut));
    p.feed(bytes.slice(cut));
    p.end();
    assert.deepEqual(snapshot(p), expected, `cut at byte ${cut}`);
  }
});

test('visible text and result for a realistic session', () => {
  const p = new SessionParser();
  p.sendCommand('echo hello');
  p.feed('echo hello\r\nhello\r\n');
  p.sendCommand('exit');
  p.feed('exit\r\n');
  p.end();
  assert.equal(p.getVisibleText(), 'echo hello\nhello\nexit\n');
  assert.equal(p.getResult(), 'hello');
  assert.deepEqual(
    p.getCommands().map((c) => c.status),
    ['completed', 'completed'],
  );
});
