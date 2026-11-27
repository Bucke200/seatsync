import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://localhost:4000";

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Docker image copies .next/standalone and runs apps/web/server.js.
  output: "standalone",
  // In a pnpm workspace, trace files from the repo root so shared packages and
  // the root node_modules store are included in the standalone output.
  outputFileTracingRoot: path.join(projectRoot, "../.."),
  // Linting is a separate CI step (`pnpm lint`); a production image build only
  // needs the type check and the compiled app.
  eslint: { ignoreDuringBuilds: true },
  // @seatsync/shared ships TypeScript source, so Next must transpile it.
  transpilePackages: ["@seatsync/shared"],
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiProxyTarget}/:path*`,
      },
    ];
  },
};

export default nextConfig;
