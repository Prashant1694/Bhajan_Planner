const { Sequelize } = require("sequelize");
const path = require("path");
const os = require("os");

const storagePath =
  process.env.DB_PATH ||
  (process.env.NODE_ENV === "test"
    ? path.join(os.tmpdir(), `bhajan-test-${process.pid}.db`)
    : path.join(__dirname, "..", "bhajans.db"));

if (process.env.NODE_ENV === "production" && !process.env.DB_PATH) {
  console.warn(
    "⚠️  [Database] WARNING: DB_PATH is not set in production. Mount a persistent volume (e.g. DB_PATH=/data/bhajans.db) so 90-day sessions, PINs, and submissions survive container restarts."
  );
}

const sequelize = new Sequelize({
  dialect: "sqlite",
  storage: storagePath,
  logging: false,
  // SQLite supports a single concurrent writer. A single pooled connection
  // prevents this process from racing its own transactions; WAL + busy_timeout
  // handle readers and other processes that briefly hold the database lock.
  pool: {
    max: 1,
    min: 0,
    acquire: 60000,
    idle: 10000,
    afterCreate: (conn, done) => {
      // Set the per-connection wait policy before changing journal mode. This
      // also avoids simultaneous new connections racing on PRAGMA journal_mode.
      conn.run("PRAGMA busy_timeout = 30000;", (err1) => {
        if (err1) return done(err1);
        conn.run("PRAGMA journal_mode = WAL;", (err2) => {
          if (err2) return done(err2);
          conn.run("PRAGMA foreign_keys = ON;", (err3) => {
            if (err3) return done(err3);
            conn.run("PRAGMA synchronous = NORMAL;", (err4) => {
              if (err4) return done(err4);
              conn.run("PRAGMA cache_size = -20000;", (err5) => {
                if (err5) return done(err5);
                conn.run("PRAGMA temp_store = MEMORY;", done);
              });
            });
          });
        });
      });
    }
  },
  // Busy/locked errors can still occur when another process (e.g. a one-off
  // maintenance task) writes to the same SQLite file. Retry with backoff.
  retry: {
    max: 5,
    match: [/SQLITE_BUSY/, /SQLITE_LOCKED/],
    backoffBase: 250,
    backoffExponent: 1.5
  }
});

module.exports = sequelize;
