import path from 'path';
import fs from 'fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Centralized JSON logger with daily file rotation.
 *
 * - Each log line is a single JSON object (one object per line).
 * - Files are rotated daily and capped in size, with a bounded retention so a
 *   single file never grows without bound.
 * - Console output is included for local development and container stdout.
 *
 * Configuration (env vars):
 *   LOG_DIR              – directory where rotating log files are stored
 *                          (default: "logs" relative to process cwd).
 *   LOG_LEVEL            – winston level (default: "info").
 *   LOG_MAX_SIZE         – max size of a single rotated file (default: "20m").
 *   LOG_MAX_FILES        – retention, e.g. "14d" or a number (default: "14d").
 */

const LOG_DIR = process.env.LOG_DIR
  ? path.isAbsolute(process.env.LOG_DIR)
    ? process.env.LOG_DIR
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.LOG_DIR)
  : path.resolve(/* turbopackIgnore: true */ process.cwd(), 'logs');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '20m';
const LOG_MAX_FILES = process.env.LOG_MAX_FILES || '14d';

let fileTransportError: Error | null = null;
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  fileTransportError = err instanceof Error ? err : new Error(String(err));
}

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  }),
];

if (!fileTransportError) {
  try {
    const rotateAll: DailyRotateFile = new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_MAX_SIZE,
      maxFiles: LOG_MAX_FILES,
      level: LOG_LEVEL,
    });

    const rotateErrors: DailyRotateFile = new DailyRotateFile({
      dirname: LOG_DIR,
      filename: 'app-error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: LOG_MAX_SIZE,
      maxFiles: LOG_MAX_FILES,
      level: 'error',
    });

    transports.push(rotateAll, rotateErrors);
  } catch (err) {
    fileTransportError = err instanceof Error ? err : new Error(String(err));
  }
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: 'personal-pitcher' },
  transports,
});

if (fileTransportError) {
  logger.warn('rotating_file_logger_disabled', {
    reason: fileTransportError.message,
    logDir: LOG_DIR,
  });
}

export const LOGGING_CONFIG = {
  dir: LOG_DIR,
  level: LOG_LEVEL,
  maxSize: LOG_MAX_SIZE,
  maxFiles: LOG_MAX_FILES,
  fileTransportEnabled: !fileTransportError,
};
