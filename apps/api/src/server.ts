import { createApp } from "./app";
import { loadConfig, type Config } from "./config";
import { createPool } from "./db/pool";
import { startExpireHoldsJob } from "./jobs/expireHolds";
import { logger } from "./logger";
import { createRedisClient } from "./realtime/redis";

const PORT = 4000;

function main(): void {
  let config: Config;

  try {
    config = loadConfig();
  } catch (error) {
    logger.fatal({ err: error }, "invalid environment configuration");
    process.exitCode = 1;
    return;
  }

  const pool = createPool(config);
  const redis = createRedisClient(config);
  const app = createApp({ pool, redis });
  const sweeperTimer = startExpireHoldsJob(pool, config, logger);

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "SeatSync API listening");
  });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "HTTP server error");
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweeperTimer);
    server.close(() => {
      const cleanup: Array<Promise<unknown>> = [pool.end()];

      if (redis.status !== "wait" && redis.status !== "end") {
        cleanup.push(redis.quit());
      }

      void Promise.allSettled(cleanup).then(() => {
        logger.flush(() => {
          process.exit(0);
        });
      });
    });
    server.closeIdleConnections();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
