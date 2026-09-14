import { pino } from 'pino';
import { config } from '../config/index.js';

/**
 * One pino instance for the process, in its own module rather than defined
 * inline in `main.ts` - `main.ts` imports the route tree, which now reaches
 * down into `handlers/ingest.handlers.ts` for the debug log on an overridden
 * `resource`; importing `logger` from `main.ts` there would be a circular
 * import back into the file doing the importing.
 */
export const logger = pino({
  level: config.logLevel,
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
});
