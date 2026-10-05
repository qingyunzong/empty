import { StringDecoder } from 'node:string_decoder';
import { c0Effect, csiEffect, type ControlEffect } from './controlSequences.ts';

export type SegmentKind = 'echo' | 'output';

/**
 * A maximal run of printable characters of one kind in the received stream.
 * `start`/`end` are byte offsets into the original received byte stream
 * (`end` is exclusive). Segment boundaries never depend on how the stream
 * was chunked into `feed()` calls.
 */
export interface Segment {
  kind: SegmentKind;
  text: string;
  start: number;
  end: number;
}

export type CommandStatus = 'pending' | 'completed' | 'incomplete';

export interface CommandRecord {
  index: number;
  /** The command line as submitted, without the terminating CR. */
  command: string;
  /** Exact bytes sent for this command (command + '\r'). */
  sent: string;
  /** Byte offset of `sent` within the overall sent stream. */
  sentOffset: number;
  /** Bytes received back as terminal echo for this command. */
  echo: string;
  /** Printable program output attributed to this command. */
  output: string;
  /**
   * 'pending'    — echo not fully received yet;
   * 'completed'  — every sent byte (including the newline) was echoed;
   * 'incomplete' — echo mismatched, or the session ended first (truncated).
   */
  status: CommandStatus;
}

interface PendingEcho {
  ch: string;
  commandIndex: number | null;
}

type ParserState = 'text' | 'esc' | 'csi' | 'osc' | 'oscEsc';

const TAB_WIDTH = 8;

/**
 * Incremental parser for an interactive command session.
 *
 * - `send()` / `sendCommand()` record bytes written to the session.
 * - `feed()` consumes received bytes in arbitrarily sized chunks; the
 *   resulting visible text, segment offsets and command states are identical
 *   to feeding the whole stream at once.
 * - `end()` finalizes the session; commands whose echo never completed are
 *   marked 'incomplete' (truncated).
 */
export class SessionParser {
  private decoder = new StringDecoder('utf8');
  private state: ParserState = 'text';
  private csiParams = '';

  private recvOffset = 0;
  private sentOffset = 0;
  private sentChunks: string[] = [];

  private pendingEcho: PendingEcho[] = [];
  private commands: CommandRecord[] = [];
  private remainingEcho: number[] = [];
  private sessionOutput = '';

  private segments: Segment[] = [];
  private segKind: SegmentKind | null = null;
  private segText = '';
  private segStart = 0;

  private lines: string[][] = [[]];
  private cursorCol = 0;

  private lastEchoCommand: number | null = null;
  private expectEchoLf = false;
  private truncatedStream = false;
  private ended = false;

  /** Record raw bytes written to the session (kept for echo matching). */
  send(data: string): void {
    this.sentChunks.push(data);
    for (const ch of data) this.pendingEcho.push({ ch, commandIndex: null });
    this.sentOffset += data.length;
  }

  /** Record a command line written to the session (command + '\r'). */
  sendCommand(command: string): CommandRecord {
    const sent = command + '\r';
    const record: CommandRecord = {
      index: this.commands.length,
      command,
      sent,
      sentOffset: this.sentOffset,
      echo: '',
      output: '',
      status: 'pending',
    };
    this.commands.push(record);
    this.remainingEcho.push(sent.length);
    this.sentChunks.push(sent);
    for (const ch of sent) this.pendingEcho.push({ ch, commandIndex: record.index });
    this.sentOffset += sent.length;
    return { ...record };
  }

  /** Feed a chunk of received bytes. Chunk boundaries are irrelevant. */
  feed(chunk: string | Uint8Array): void {
    if (this.ended) throw new Error('feed() after end()');
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (const ch of text) {
      const start = this.recvOffset;
      this.recvOffset += Buffer.byteLength(ch, 'utf8');
      this.consume(ch, start);
    }
  }

  /** Finalize the session and flag truncated commands as 'incomplete'. */
  end(): void {
    if (this.ended) return;
    const rest = this.decoder.end();
    for (const ch of rest) {
      const start = this.recvOffset;
      this.recvOffset += Buffer.byteLength(ch, 'utf8');
      this.consume(ch, start);
    }
    this.flushSegment();
    if (this.state !== 'text') this.truncatedStream = true;
    for (let i = 0; i < this.commands.length; i++) {
      if (this.remainingEcho[i] > 0 && this.commands[i].status === 'pending') {
        this.commands[i].status = 'incomplete';
      }
    }
    this.ended = true;
  }

  /** True when the received stream ended in the middle of a control sequence. */
  isTruncated(): boolean {
    return this.truncatedStream;
  }

  /** All bytes ever passed to send()/sendCommand(), in order. */
  getSentBytes(): string {
    return this.sentChunks.join('');
  }

  /** Visible screen text (echo + output, control effects applied). */
  getVisibleText(): string {
    return this.lines.map((line) => line.join('')).join('\n');
  }

  /** Printable segments with byte offsets into the received stream. */
  getSegments(): Segment[] {
    return this.segments.map((s) => ({ ...s }));
  }

  /** Program result only: concatenated 'output' segments, never echo. */
  getResult(): string {
    return this.segments
      .filter((s) => s.kind === 'output')
      .map((s) => s.text)
      .join('');
  }

  getCommands(): CommandRecord[] {
    return this.commands.map((c) => ({ ...c }));
  }

  // ---- byte stream state machine ----

  private consume(ch: string, offset: number): void {
    switch (this.state) {
      case 'text':
        this.consumeText(ch, offset);
        return;
      case 'esc':
        this.state = ch === '[' ? 'csi' : ch === ']' ? 'osc' : 'text';
        if (this.state === 'csi') this.csiParams = '';
        return;
      case 'csi': {
        const code = ch.codePointAt(0)!;
        if (code >= 0x40 && code <= 0x7e) {
          const params = this.csiParams === '' ? [] : this.csiParams.split(';').map((p) => parseInt(p, 10) || 0);
          const effect = csiEffect(ch, params);
          if (effect) this.applyEffect(effect);
          this.state = 'text';
        } else {
          this.csiParams += ch;
        }
        return;
      }
      case 'osc':
        if (ch === '\x07') this.state = 'text';
        else if (ch === '\x1b') this.state = 'oscEsc';
        return;
      case 'oscEsc':
        this.state = ch === '\\' ? 'text' : 'osc';
        return;
    }
  }

  private consumeText(ch: string, offset: number): void {
    if (ch !== '\n') this.expectEchoLf = false;
    if (ch === '\x1b') {
      this.flushSegment();
      this.state = 'esc';
      return;
    }
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) {
      this.flushSegment();
      const effect = c0Effect(code);
      if (effect) {
        this.consumeEchoControl(ch);
        this.applyEffect(effect);
      }
      return; // control bytes outside the table are consumed and ignored
    }
    const kind = this.classify(ch);
    this.appendSegment(kind, ch, offset);
    this.writeChar(ch);
  }

  // ---- echo vs. output classification ----

  private classify(ch: string): SegmentKind {
    while (this.pendingEcho.length > 0) {
      const head = this.pendingEcho[0];
      if (head.ch === ch) {
        this.pendingEcho.shift();
        if (head.commandIndex !== null) this.recordEcho(head.commandIndex, ch);
        return 'echo';
      }
      if (head.commandIndex === null || this.commands[head.commandIndex].echo === '') {
        // Either a raw sent byte, or a command whose echo has not started
        // yet: a mismatching character is program output of whatever ran
        // before, not proof of a truncated echo. Leave the queue alone.
        return 'output';
      }
      // The command's echo started but diverges: it was cut off or altered.
      this.pendingEcho.shift();
      const idx = head.commandIndex;
      if (this.commands[idx].status === 'pending') this.commands[idx].status = 'incomplete';
      this.remainingEcho[idx] = 0;
      while (this.pendingEcho.length > 0 && this.pendingEcho[0].commandIndex === idx) {
        this.pendingEcho.shift();
      }
    }
    return 'output';
  }

  private recordEcho(commandIndex: number, ch: string): void {
    const record = this.commands[commandIndex];
    record.echo += ch;
    this.lastEchoCommand = commandIndex;
    if (--this.remainingEcho[commandIndex] === 0 && record.status === 'pending') {
      record.status = 'completed';
    }
  }

  /** CR/LF can be the echo of the sent newline ('\r' typically echoes as CRLF). */
  private consumeEchoControl(ch: string): void {
    if (ch === '\n' && this.expectEchoLf) {
      this.expectEchoLf = false;
      if (this.lastEchoCommand !== null) this.commands[this.lastEchoCommand].echo += ch;
      return;
    }
    const head = this.pendingEcho[0];
    if (head && (head.ch === '\r' || head.ch === '\n')) {
      this.pendingEcho.shift();
      if (head.commandIndex !== null) this.recordEcho(head.commandIndex, ch);
      if (ch === '\r') this.expectEchoLf = true;
    }
  }

  private attributeOutput(ch: string): void {
    if (this.commands.length > 0) this.commands[this.commands.length - 1].output += ch;
    else this.sessionOutput += ch;
  }

  // ---- segments ----

  private appendSegment(kind: SegmentKind, ch: string, offset: number): void {
    if (kind === 'output') this.attributeOutput(ch);
    if (this.segKind === kind) {
      this.segText += ch;
    } else {
      this.flushSegment();
      this.segKind = kind;
      this.segText = ch;
      this.segStart = offset;
    }
  }

  private flushSegment(): void {
    if (this.segKind === null) return;
    this.segments.push({
      kind: this.segKind,
      text: this.segText,
      start: this.segStart,
      end: this.segStart + Buffer.byteLength(this.segText, 'utf8'),
    });
    this.segKind = null;
    this.segText = '';
  }

  // ---- visible-text model ----

  private currentLine(): string[] {
    return this.lines[this.lines.length - 1];
  }

  private writeChar(ch: string): void {
    const line = this.currentLine();
    while (line.length < this.cursorCol) line.push(' ');
    if (this.cursorCol === line.length) line.push(ch);
    else line[this.cursorCol] = ch;
    this.cursorCol++;
  }

  private applyEffect(effect: ControlEffect): void {
    switch (effect.type) {
      case 'lineFeed':
        this.lines.push([]);
        break;
      case 'carriageReturn':
        this.cursorCol = 0;
        break;
      case 'backspace':
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        break;
      case 'tab':
        this.cursorCol = (Math.floor(this.cursorCol / TAB_WIDTH) + 1) * TAB_WIDTH;
        break;
      case 'bell':
        break;
      case 'cursorBack':
        this.cursorCol = Math.max(0, this.cursorCol - effect.count);
        break;
      case 'cursorForward':
        this.cursorCol += effect.count;
        break;
      case 'cursorColumn':
        this.cursorCol = Math.max(0, effect.column);
        break;
      case 'eraseInLine': {
        const line = this.currentLine();
        if (effect.mode === 0) line.length = Math.min(line.length, this.cursorCol);
        else if (effect.mode === 1) {
          for (let i = 0; i <= this.cursorCol && i < line.length; i++) line[i] = ' ';
        } else line.length = 0;
        break;
      }
      case 'eraseInDisplay':
        if (effect.mode === 0) {
          const line = this.currentLine();
          line.length = Math.min(line.length, this.cursorCol);
        } else if (effect.mode === 1) {
          const line = this.currentLine();
          for (let i = 0; i <= this.cursorCol && i < line.length; i++) line[i] = ' ';
          this.lines = [line];
        } else {
          this.lines = [[]];
          this.cursorCol = 0;
        }
        break;
      case 'deleteChars': {
        const line = this.currentLine();
        line.splice(this.cursorCol, effect.count);
        break;
      }
      case 'insertChars': {
        const line = this.currentLine();
        while (line.length < this.cursorCol) line.push(' ');
        line.splice(this.cursorCol, 0, ...new Array<string>(effect.count).fill(' '));
        break;
      }
    }
  }
}
