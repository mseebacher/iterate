import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool as NeonPool, neonConfig } from "@neondatabase/serverless";
import type { PoolConfig as NeonPoolConfig } from "@neondatabase/serverless";
import { Client as PgClient } from "pg";
import { env } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import * as schema from "./schema.ts";

// ---------------------------------------------------------------------------
// Neon WebSocket configuration (only used when Hyperdrive is unavailable)
// ---------------------------------------------------------------------------
neonConfig.webSocketConstructor = WebSocket;
neonConfig.pipelineConnect = false;
neonConfig.useSecureWebSocket = !env.DATABASE_URL?.includes("localhost");
neonConfig.wsProxy = (host, port) =>
  host === "localhost"
    ? `localhost:${env.LOCAL_DOCKER_NEON_PROXY_PORT}/v2?address=${host}:${port}`
    : `${host}/v2?address=${host}:${port}`;

// ---------------------------------------------------------------------------
// Transient error detection & retry logic
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 100;

/** Postgres SQLSTATE codes that indicate transient/retryable failures. */
const TRANSIENT_PG_CODES = new Set([
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "57P01", // admin_shutdown
  "53300", // too_many_connections
]);

/**
 * Determines if a query error is transient and safe to retry.
 * Covers connection drops, WebSocket failures, TCP resets, and Postgres transient SQLSTATE codes.
 * Also walks the `cause` chain (e.g. DrizzleQueryError wrapping a DatabaseError).
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  for (
    let current: unknown = err;
    current instanceof Error;
    current = (current as { cause?: unknown }).cause
  ) {
    const msg = current.message;

    if (msg.includes("Connection terminated")) return true;
    if (msg.includes("connection timeout")) return true;
    if (msg.includes("ECONNRESET")) return true;
    if (msg.includes("ECONNREFUSED")) return true;
    if (msg.includes("socket hang up")) return true;
    if (msg.includes("WebSocket")) return true;
    if (msg.includes("fetch failed")) return true;

    const code = (current as { code?: string }).code;
    if (typeof code === "string" && TRANSIENT_PG_CODES.has(code)) return true;
  }

  return false;
}

/** Retry-aware wrapper around a query function. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!isTransientError(err) || attempt === MAX_RETRIES) {
        throw lastError;
      }

      const delay = BASE_DELAY_MS * 2 ** attempt;
      logger.warn(
        `Retrying transient DB error (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError.message}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

// ---------------------------------------------------------------------------
// Retry Pool wrapper (Neon fallback only)
// ---------------------------------------------------------------------------

/**
 * Neon Pool with automatic retry on transient failures.
 * Used as fallback when Hyperdrive is unavailable (local dev, DurableObjects).
 */
class RetryNeonPool extends NeonPool {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pool.query has many overloads
  async query(...args: any[]): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- super.query typing mismatch
    return withRetry(() => (super.query as any)(...args));
  }
}

// ---------------------------------------------------------------------------
// DB client factories
// ---------------------------------------------------------------------------

/**
 * Creates a drizzle DB instance.
 * Prefers Hyperdrive binding (TCP via pg driver) when available,
 * falls back to Neon WebSocket driver with DATABASE_URL.
 */
export const getDb = async () => {
  // Hyperdrive exposes a connectionString on the binding at runtime.
  // env.HYPERDRIVE is typed via alchemy — it's the Cloudflare Hyperdrive binding.
  const hyperdrive = (env as Record<string, unknown>).HYPERDRIVE as
    | { connectionString: string }
    | undefined;

  if (hyperdrive?.connectionString) {
    // Hyperdrive manages connection pooling server-side — use a plain Client
    // per request (Cloudflare's recommended pattern) to avoid double-pooling.
    const client = new PgClient({ connectionString: hyperdrive.connectionString });
    await client.connect();
    return drizzlePg({ client, schema, casing: "snake_case" });
  }

  // Fallback: Neon WebSocket driver (local dev, or if Hyperdrive not bound)
  const pool = new RetryNeonPool({
    connectionString: env.DATABASE_URL,
    max: 3,
  } as NeonPoolConfig);
  return drizzleNeon({ client: pool, schema, casing: "snake_case" });
};

/** Accepts any env-like object with DATABASE_URL (used by DurableObjects).
 *  DOs inherit all worker bindings at runtime, so HYPERDRIVE is available
 *  when deployed — prefer it over the Neon WS fallback. */
export const getDbWithEnv = async (envParam: {
  DATABASE_URL: string;
  HYPERDRIVE?: { connectionString: string };
}) => {
  if (envParam.HYPERDRIVE?.connectionString) {
    const client = new PgClient({ connectionString: envParam.HYPERDRIVE.connectionString });
    await client.connect();
    return drizzlePg({ client, schema, casing: "snake_case" });
  }

  const pool = new RetryNeonPool({
    connectionString: envParam.DATABASE_URL,
    max: 3,
  } as NeonPoolConfig);
  return drizzleNeon({ client: pool, schema, casing: "snake_case" });
};

export type DB = Awaited<ReturnType<typeof getDb>>;
