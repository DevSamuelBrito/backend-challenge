import { Injectable, type LoggerService } from "@nestjs/common";
import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";
import type { LogLevel } from "../../../config/env";
import { currentContext } from "../../application/request-context";
import { REDACT_CENSOR, REDACT_PATHS } from "./redaction";

export const LOG_DESTINATION = Symbol("LOG_DESTINATION");

export function createPino(level: LogLevel, destination?: DestinationStream): PinoLogger {
  const options: pino.LoggerOptions = {
    level,
    base: { service: "distributed-wagering-processor" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...currentContext() }),
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  };

  return destination ? pino(options, destination) : pino(options);
}

type NestLevel = "log" | "error" | "warn" | "debug" | "verbose" | "fatal";

const PINO_LEVEL = {
  log: "info",
  error: "error",
  warn: "warn",
  debug: "debug",
  verbose: "trace",
  fatal: "fatal",
} as const satisfies Record<NestLevel, string>;

@Injectable()
export class PinoLoggerService implements LoggerService {
  constructor(private readonly pinoLogger: PinoLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit("log", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.emit("error", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit("verbose", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.emit("fatal", message, params);
  }

  private emit(level: NestLevel, message: unknown, params: unknown[]): void {
    const last = params.at(-1);
    const context = typeof last === "string" ? last : undefined;
    const target = PINO_LEVEL[level];

    if (typeof message === "object" && message !== null && !(message instanceof Error)) {
      const fields = message as Record<string, unknown>;
      const event = typeof fields.event === "string" ? fields.event : undefined;

      this.pinoLogger[target]({ ...fields, ...(context && { context }) }, event);
      return;
    }

    const text = message instanceof Error ? message.name : String(message);

    this.pinoLogger[target]({ ...(context && { context }) }, text);
  }
}
