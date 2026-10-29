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
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000,
    afterCreate: (conn, done) => {
      conn.run("PRAGMA journal_mode = WAL;", (err1) => {
        if (err1) return done(err1);
        conn.run("PRAGMA busy_timeout = 5000;", (err2) => {
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
  retry: {
    max: 3
  }
});

module.exports = sequelize;
