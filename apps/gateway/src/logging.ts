/**
 * Structured logging.
 *
 * Every line is JSON on a single line and carries a correlation id where one
 * exists, so one tool call can be reconstructed end to end from the log stream
 * (ARCHITECTURE.md §21.1).
 *
 * Phase 1 note: the redacting logger wrapper described in ARCHITECTURE.md
 * §17.7 is NOT implemented here. This logger never logs request arguments or
 * results, which is why it is safe today — but the guarantee currently rests on
 * call sites being careful rather than on the logger enforcing it. Phase 6 adds
 * enforcement plus the CI test that greps the log stream for planted secrets.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    /** Derive a logger that stamps every line with additional fields. */
    child(fields: Record<string, unknown>): Logger;
}

function write(level: LogLevel, minimum: LogLevel, base: Record<string, unknown>, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minimum]) return;

    const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg: message,
        ...base,
        ...fields
    });

    // stdout is reserved for protocol traffic on stdio servers; the gateway
    // speaks HTTP, but keeping logs on stderr keeps the convention uniform and
    // makes `node gateway.js > protocol.log` safe if that ever changes.
    process.stderr.write(`${line}\n`);
}

export function createLogger(minimum: LogLevel = 'info', base: Record<string, unknown> = {}): Logger {
    return {
        debug: (message, fields) => write('debug', minimum, base, message, fields),
        info: (message, fields) => write('info', minimum, base, message, fields),
        warn: (message, fields) => write('warn', minimum, base, message, fields),
        error: (message, fields) => write('error', minimum, base, message, fields),
        child: (fields) => createLogger(minimum, { ...base, ...fields })
    };
}

/** A logger that discards everything. Used in tests that assert on behaviour, not output. */
export const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => silentLogger
};
