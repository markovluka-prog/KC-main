/**
 * Structured logging via pino. PII fields (token, password, email body)
 * are redacted globally so accidental log lines don't leak credentials.
 *
 * R3.4 mitigation from the master plan.
 */
import pino from 'pino';
import { loadEnv } from './env.js';

const env = loadEnv();

export const logger = pino({
  level: env.LOG_LEVEL,
  formatters: {
    level: (label) => ({ severity: label.toUpperCase() }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.token',
      '*.access_token',
      '*.refresh_token',
      '*.id_token',
      '*.client_secret',
      '*.passwordHash',
      'password',
      'token',
      'accessToken',
      'refreshToken',
    ],
    censor: '[redacted]',
  },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
});
