import { Router } from "express";
import type { Pool } from "pg";
import type { Config } from "../config";
import { asyncHandler } from "../middleware/errors";
import {
  handleWebhookDelivery,
  webhookSignatureHeader,
} from "../services/webhooks";

/**
 * `POST /webhooks/:provider` (D22/D23).
 *
 * No auth middleware: the provider authenticates itself with the HMAC over the
 * raw body. The app mounts the raw body parser on `/webhooks` before
 * `express.json()` so `req.body` here is the exact delivered Buffer,
 * which is what `verifyWebhook` must hash.
 *
 * Success (including an already-processed event or a terminal booking) is
 * always 200 after the transaction commits. Bad verification is 400; an
 * unexpected mid-transaction failure is 500 with the dedupe row rolled back,
 * which puts the provider into its normal redelivery path.
 */
export function createWebhooksRouter(pool: Pool, config: Config): Router {
  const router = Router();

  router.post(
    "/:provider",
    asyncHandler(async (req, res) => {
      const providerName = req.params.provider;

      await handleWebhookDelivery(pool, config, {
        providerName,
        rawBody: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        signature: req.get(webhookSignatureHeader(providerName)),
      });

      res.status(200).json({ received: true });
    }),
  );

  return router;
}
