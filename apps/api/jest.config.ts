import type { Config } from "jest";

/**
 * Integration tests truncate shared Postgres tables and must never overlap, so
 * `maxWorkers: 1` forces Jest to run every suite serially (in band).
 */
const config: Config = {
  rootDir: __dirname,
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  maxWorkers: 1,
};

export default config;
