// Minimal ambient declarations so the project compiles offline without @types/node.
declare module "node:fs";
declare module "node:os";
declare module "node:path";
declare module "node:readline";
declare module "node:stream";
declare module "node:stream/promises";
declare module "node:events";
declare module "node:child_process";
declare module "node:test";
declare module "node:assert";

declare const process: any;
declare const __dirname: string;
declare const require: any;
declare const module: any;
