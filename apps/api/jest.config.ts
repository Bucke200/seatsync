import type { Config } from "jest";

/**
 * Jest 29 exposes `runInBand` only as a CLI flag, but the Sprint 0 plan requires
 * it in the config file. Keeping the property documents intent; `maxWorkers: 1`
 * is the supported config key that guarantees the same serial execution. That
 * matters because the integration tests truncate shared Postgres tables and must
 * never overlap.
 */
type IntegrationJestConfig = Config & { runInBand: boolean };

const config: IntegrationJestConfig = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  runInBand: true,
  maxWorkers: 1,
};

export default config;
