import { createApp } from "./app";
import { loadConfig } from "./config";
import { createPool } from "./db/pool";
import { logger } from "./logger";
import { createRedisClient } from "./realtime/redis";

const PORT = 4000;

function main(): void {
  let config;

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

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "SeatSync API listening");
  });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "HTTP server error");
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutting down");
    server.close(() => {
      void Promise.allSettled([pool.end(), redis.quit()]).then(() => {
        process.exit(0);
      });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
