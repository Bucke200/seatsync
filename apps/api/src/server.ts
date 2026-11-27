import { createApp } from "./app";
import { loadConfig, type Config } from "./config";
import { createPool } from "./db/pool";
import { startExpireHoldsJob } from "./jobs/expireHolds";
import { startRetryRefundsJob } from "./jobs/retryRefunds";
import { logger } from "./logger";
import { createPaymentProvider } from "./payments";
import { startSeatEventPublisher } from "./realtime/publisher";
import { createRedisClient } from "./realtime/redis";
import { startSeatEventSubscriber } from "./realtime/subscriber";
import { attachRealtimeServer } from "./realtime/ws";

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
  // D24: refund retries share the sweeper cadence (doc-unspecified interval,
  // recorded in the Sprint 3 report) and, like the sweeper, never run at boot
  // (D16). A provider that cannot be built (e.g. unimplemented stripe) leaves
  // the HTTP app serving; the job simply stays off.
  let refundTimer: NodeJS.Timeout | null = null;

  try {
    const paymentProvider = createPaymentProvider(config);
    refundTimer = startRetryRefundsJob(pool, config, paymentProvider);
  } catch (error) {
    logger.error(
      { err: error },
      "refund retry job not started: payment provider unavailable",
    );
  }

  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "SeatSync API listening");
  });

  // D28: the WebSocket server shares the HTTP listen socket at `/ws`. Step 2
  // connects the in-process seat emitter to Redis and Redis back into this
  // attachment's rooms. Both pub/sub clients are dedicated (D26) and are
  // stopped by their handles during shutdown.
  const realtime = attachRealtimeServer(server, { config });
  const publisher = startSeatEventPublisher({ config, logger });
  const subscriber = startSeatEventSubscriber({ config, hub: realtime.hub, logger });

  server.on("error", (error) => {
    logger.fatal({ err: error }, "HTTP server error");
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, "shutting down");
    clearInterval(sweeperTimer);
    if (refundTimer !== null) {
      clearInterval(refundTimer);
    }

    // Shutdown order: stop accepting new sockets and terminate live WebSocket
    // connections first, then stop the pub/sub bridge (so no Redis message is
    // delivered into a closing hub), let the HTTP server drain, then close
    // Redis (health client included).
    const realtimeClosed = realtime.close();
    const publisherStopped = publisher.stop();
    const subscriberStopped = subscriber.stop();

    server.close(() => {
      const cleanup: Array<Promise<unknown>> = [
        realtimeClosed,
        publisherStopped,
        subscriberStopped,
        pool.end(),
      ];

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
