import { DIIISCO } from ".";
import environment from "./environment/environment";
import { logger } from "./utils/logger";

console.log(environment);

(async () => {
  const diiisco = new DIIISCO(environment);

  const shutdown = async (code = 0) => {
    try { await diiisco.stop(); } catch (err) { logger.error('Error during shutdown', err); }
    process.exit(code);
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (err) => { logger.error('Uncaught exception', err); shutdown(1); });
  process.on('unhandledRejection', (reason) => { logger.error('Unhandled rejection', reason); });

  try {
    await diiisco.start();
  } catch (err) {
    logger.error('Failed to start Diiisco', err);
    await shutdown(1);
  }
})();