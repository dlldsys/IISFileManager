const pino = require('pino');

const REDACT = ['password', 'password_hash', 'token', 'secret', 'authorization', 'cookie', 'session'];

module.exports = pino({
  redact: { paths: REDACT, censor: '[REDACTED]' },
  level: process.env.LOG_LEVEL || 'info'
});