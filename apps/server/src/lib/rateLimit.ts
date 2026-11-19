import { ErrorCode } from "@embed-assistant/protocol";
import type { Sql } from "../db/pool.js";
import { ApiError } from "./errors.js";

/**
 * Fixed-window counters in Postgres: correct across any number of server
 * instances without adding Redis. One UPSERT per check.
 */
export class RateLimiter {
  constructor(private readonly sql: Sql) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
    const rows = await this.sql<{ count: number }[]>`
      INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
      RETURNING count`;
    const count = rows[0]?.count ?? 1;
    if (count > limit) {
      const retryAfter = Math.ceil((windowStart.getTime() + windowSeconds * 1000 - now) / 1000);
      throw new ApiError(ErrorCode.RateLimited, "too many requests, slow down", { limit, windowSeconds }, retryAfter);
    }
  }

  /** Delete expired windows; called periodically. */
  async sweep(): Promise<void> {
    await this.sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  }
}

/** Tokens used today (UTC) by a widget's runs. */
export async function tokensUsedToday(sql: Sql, tenantId: string, widgetId: string): Promise<number> {
  const rows = await sql<{ total: string | null }[]>`
    SELECT sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) AS total
    FROM runs
    WHERE tenant_id = ${tenantId} AND widget_id = ${widgetId}
      AND created_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`;
  return Number(rows[0]?.total ?? 0);
}
