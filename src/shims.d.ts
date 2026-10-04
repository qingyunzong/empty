// Minimal ambient declarations so the project compiles without @types/node
// (the runtime library code itself only uses standard JS: Uint8Array/DataView).
declare module "node:*" {
  const value: any;
  export = value;
}

declare const process: any;
declare const console: any;
declare const __dirname: string;

declare class TextDecoder {
  constructor(encoding?: string);
  decode(input?: Uint8Array): string;
}
