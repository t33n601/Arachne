/**
 * A tiny leveled logger with pluggable handlers, plus a context-aware `log` proxy: code running inside a crawler
 * logs through that crawler's logger (tracked with `AsyncLocalStorage`) while everything else uses the library one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;
export type LogLevelName = "debug" | "info" | "warning" | "error" | "critical";
export const LEVEL_NAMES: Record<number, string> = { 10: "DEBUG", 20: "INFO", 30: "WARNING", 40: "ERROR", 50: "CRITICAL" };

export function levelFromName(name: string): number | undefined {
  const map: Record<string, number> = {
    debug: 10,
    info: 20,
    warning: 30,
    warn: 30,
    error: 40,
    critical: 50,
    fatal: 50,
  };
  return map[name.trim().toLowerCase()];
}

export interface LogRecord {
  level: number;
  levelName: string;
  message: string;
  time: Date;
  logger: string;
  error?: unknown;
}

export type LogHandler = (record: LogRecord) => void;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Build a formatter from a template with `{time}`, `{level}`, `{message}`, and `{name}` placeholders */
export function makeFormatter(template = "[{time}] {level}: {message}"): (record: LogRecord) => string {
  return (record) =>
    template
      .replace("{time}", formatTime(record.time))
      .replace("{level}", record.levelName)
      .replace("{name}", record.logger)
      .replace("{message}", record.message);
}

export function consoleHandler(format = makeFormatter()): LogHandler {
  return (record) => {
    let line = format(record);
    if (record.error instanceof Error && record.error.stack) line += `\n${record.error.stack}`;
    process.stderr.write(`${line}\n`);
  };
}

export function fileHandler(path: string, format = makeFormatter()): LogHandler {
  mkdirSync(dirname(path), { recursive: true });
  return (record) => {
    let line = format(record);
    if (record.error instanceof Error && record.error.stack) line += `\n${record.error.stack}`;
    appendFileSync(path, `${line}\n`);
  };
}

function render(args: unknown[]): string {
  return args.map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 4, breakLength: 120 }))).join(" ");
}

export class Logger {
  handlers: LogHandler[];

  constructor(
    public readonly name: string,
    public level: number = LogLevel.INFO,
    handlers?: LogHandler[],
  ) {
    this.handlers = handlers ?? [consoleHandler()];
  }

  setLevel(level: number | LogLevelName): void {
    this.level = typeof level === "number" ? level : (levelFromName(level) ?? LogLevel.INFO);
  }

  isEnabledFor(level: number): boolean {
    return level >= this.level;
  }

  getEffectiveLevel(): number {
    return this.level;
  }

  addHandler(handler: LogHandler): void {
    this.handlers.push(handler);
  }

  log(level: number, ...args: unknown[]): void {
    if (level < this.level) return;
    const error = args.find((arg) => arg instanceof Error);
    const record: LogRecord = {
      level,
      levelName: LEVEL_NAMES[level] ?? `LEVEL ${level}`,
      message: render(args),
      time: new Date(),
      logger: this.name,
      error,
    };
    for (const handler of this.handlers) {
      try {
        handler(record);
      } catch {
        // A broken handler must never break scraping
      }
    }
  }

  debug(...args: unknown[]): void {
    this.log(LogLevel.DEBUG, ...args);
  }

  info(...args: unknown[]): void {
    this.log(LogLevel.INFO, ...args);
  }

  warning(...args: unknown[]): void {
    this.log(LogLevel.WARNING, ...args);
  }

  warn(...args: unknown[]): void {
    this.log(LogLevel.WARNING, ...args);
  }

  error(...args: unknown[]): void {
    this.log(LogLevel.ERROR, ...args);
  }

  critical(...args: unknown[]): void {
    this.log(LogLevel.CRITICAL, ...args);
  }
}

/** The library's default logger */
export const rootLogger = new Logger("arachne", LogLevel.INFO);

const loggerContext = new AsyncLocalStorage<Logger>();

/** Run `fn` with `logger` as the current context logger */
export function withLogger<T>(logger: Logger, fn: () => T): T {
  return loggerContext.run(logger, fn);
}

/** Return the logger of the current async context */
export function currentLogger(): Logger {
  return loggerContext.getStore() ?? rootLogger;
}

/** Proxy that always logs through the logger of the current async context */
export const log = {
  debug: (...args: unknown[]) => currentLogger().debug(...args),
  info: (...args: unknown[]) => currentLogger().info(...args),
  warning: (...args: unknown[]) => currentLogger().warning(...args),
  warn: (...args: unknown[]) => currentLogger().warning(...args),
  error: (...args: unknown[]) => currentLogger().error(...args),
  critical: (...args: unknown[]) => currentLogger().critical(...args),
  isEnabledFor: (level: number) => currentLogger().isEnabledFor(level),
  getEffectiveLevel: () => currentLogger().getEffectiveLevel(),
  setLevel: (level: number | LogLevelName) => currentLogger().setLevel(level),
};
