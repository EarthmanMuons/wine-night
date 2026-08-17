import { DurableObject } from "cloudflare:workers";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS daily_counts (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
`;

// Matches the room TTL: no reason to keep usage history longer than the rooms it describes.
const RETENTION_DAYS = 90;

/**
 * Single global counter of rooms created, bucketed by day. Aggregate counts only,
 * never room codes, themes, or any other room-identifying detail.
 */
export class SiteStats extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(SCHEMA);
  }

  recordRoomCreated() {
    const day = new Date().toISOString().slice(0, 10);
    this.sql.exec(
      `INSERT INTO daily_counts (day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1`,
      day,
    );
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    this.sql.exec("DELETE FROM daily_counts WHERE day < ?", cutoff);
  }

  getStats() {
    const rows = this.sql.exec("SELECT day, count FROM daily_counts ORDER BY day ASC").toArray() as {
      day: string;
      count: number;
    }[];
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return { total, daily: rows };
  }
}
