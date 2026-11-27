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

    // Shutdown order (drain-safe):
    // 1. Close the WebSocket attachment FIRST. Upgraded sockets are not part of
    //    the HTTP request drain, so leaving them open would keep
    //    `server.close()` waiting; this also clears the rooms so no later
    //    broadcast can target a socket that is already gone.
    // 2. `server.close()` stops accepting connections and drains in-flight HTTP
    //    requests. The publisher and subscriber deliberately stay alive here:
    //    a hold/booking that commits during the drain must still publish its
    //    live update instead of losing it.
    // 3. Only in the close callback (drain finished, so no request can emit a
    //    seat change any more) stop the publisher, then the subscriber: the
    //    publisher first removes the sole `seatEvents` listener, so nothing new
    //    can be published, and stopping the subscriber next guarantees no
    //    Redis -> hub broadcast outlives the drain. The WS server is already
    //    closed, so nothing can be written to a closed socket. Redis (health
    //    client) and the pool go last.
    const realtimeClosed = realtime.close();

    server.close(() => {
      const publisherStopped = publisher.stop();
      const subscriberStopped = subscriber.stop();
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
