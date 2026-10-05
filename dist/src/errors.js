export class VfsError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.name = new.target.name;
        this.code = code;
    }
}
export class NotFoundError extends VfsError {
    constructor(path) {
        super(`ENOENT: no such file or directory: '${path}'`, 'ENOENT');
    }
}
export class NotDirectoryError extends VfsError {
    constructor(path) {
        super(`ENOTDIR: not a directory: '${path}'`, 'ENOTDIR');
    }
}
export class IsDirectoryError extends VfsError {
    constructor(path) {
        super(`EISDIR: illegal operation on a directory: '${path}'`, 'EISDIR');
    }
}
export class AlreadyExistsError extends VfsError {
    constructor(path) {
        super(`EEXIST: file already exists: '${path}'`, 'EEXIST');
    }
}
/** A resolution step would land outside the sandbox root. */
export class SandboxEscapeError extends VfsError {
    constructor(path) {
        super(`EESCAPE: path escapes sandbox boundary: '${path}'`, 'EESCAPE');
    }
}
/** A symlink was encountered twice during a single resolution. */
export class SymlinkLoopError extends VfsError {
    constructor(path) {
        super(`ELOOP: symbolic link loop detected while resolving: '${path}'`, 'ELOOP');
    }
}
/** The per-resolution symlink expansion budget was exhausted. */
export class TooManyExpansionsError extends VfsError {
    constructor(path, max) {
        super(`EMAXEXPAND: more than ${max} symlink expansions while resolving: '${path}'`, 'EMAXEXPAND');
    }
}
/** The directory generation captured at check time no longer matches at open time. */
export class StaleGenerationError extends VfsError {
    constructor(path) {
        super(`ESTALEGEN: directory generation changed between check and open: '${path}'`, 'ESTALEGEN');
    }
}
