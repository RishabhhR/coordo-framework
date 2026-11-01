#!/usr/bin/env node

// Safety boundary: this benchmark is deliberately in-process. It never imports
// the Mongo driver, opens a socket, or contacts Atlas. It measures how Coordo
// should behave when the storage dependency is already known to be unavailable.

import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

class MongoDownError extends Error {
  constructor() {
    super("MongoDB is unavailable (local fault injection)");
    this.name = "MongoDownError";
  }
}

function positiveInt(value, name, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}.`);
  }
  return parsed;
}

function parseArgs(args) {
  const values = { requestsPerSecond: 1_000_000, seconds: 1 };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--requests-per-second") values.requestsPerSecond = positiveInt(args[++i], "--requests-per-second", 5_000_000);
    else if (arg === "--seconds") values.seconds = positiveInt(args[++i], "--seconds", 60);
    else if (arg === "--help") values.help = true;
    else throw new Error(`Unknown option '${arg}'. Use --help.`);
  }
  return values;
}

export function simulateMongoOutage({ requestsPerSecond = 1_000_000, seconds = 1 } = {}) {
  const total = positiveInt(requestsPerSecond, "requestsPerSecond", 5_000_000) * positiveInt(seconds, "seconds", 60);
  let rejected = 0;
  let networkAttempts = 0;
  const started = performance.now();
  for (let i = 0; i < total; i += 1) {
    try {
      // This is the fault-injected storage boundary. It is intentionally not
      // a Mongo client call and therefore cannot reach any external service.
      throw new MongoDownError();
    } catch (error) {
      if (!(error instanceof MongoDownError)) throw error;
      rejected += 1;
    }
  }
  const elapsedMs = performance.now() - started;
  return {
    mode: "local-fault-injection",
    targetRequestsPerSecond: requestsPerSecond,
    simulatedSeconds: seconds,
    logicalRequests: total,
    rejected: rejected,
    accepted: total - rejected,
    networkAttempts,
    elapsedMs: Number(elapsedMs.toFixed(3)),
    logicalRequestsPerSecond: Math.round(total / Math.max(elapsedMs / 1000, Number.EPSILON)),
    targetRateAchieved: total / Math.max(elapsedMs / 1000, Number.EPSILON) >= requestsPerSecond,
    failFast: rejected === total && networkAttempts === 0,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/simulate-mongo-outage.mjs [--requests-per-second N] [--seconds N]");
      console.log("Runs a local-only fault-injection benchmark. It never contacts MongoDB or Atlas.");
      process.exit(0);
    }
    console.log(JSON.stringify(simulateMongoOutage(options), null, 2));
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
