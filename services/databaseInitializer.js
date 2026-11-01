const bcrypt = require("bcrypt");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const sequelize = require("../config/database");

const AdminUser = require("../models/AdminUser");
const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const DeityRule = require("../models/DeityRule");
const ActivityLog = require("../models/ActivityLog");
const UserPresence = require("../models/UserPresence");

const Notification = require("../models/Notification");
const NotificationRead = require("../models/NotificationRead");
const PushSubscription = require("../models/PushSubscription");
const Bulletin = require("../models/Bulletin");
const BhajanReport = require("../models/BhajanReport");
const SingerBookmark = require("../models/SingerBookmark");
const Singer = require("../models/Singer");
const SessionPermission = require("../models/SessionPermission");
const SessionMeta = require("../models/SessionMeta");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");

async function initializeSuperAdmin() {
  const superAdminCount = await AdminUser.count({
    where: { role: "super_admin" }
  });

  if (superAdminCount > 0) return;

  const username = process.env.SUPER_ADMIN_USER;
  const password = process.env.SUPER_ADMIN_PASS;
  const displayName = process.env.SUPER_ADMIN_DISPLAY_NAME || "Super Admin";

  if (!username || !password) {
    if (process.env.NODE_ENV === "test") {
      const testHash = await bcrypt.hash("testadmin123", 10);
      await AdminUser.create({
        username: "testadmin",
        display_name: "Test Admin",
        password_hash: testHash,
        role: "super_admin",
        is_active: true
      });
      console.log("✅ Test super admin account created.");
      return;
    }
    throw new Error("SUPER_ADMIN_USER and SUPER_ADMIN_PASS must be configured.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  await AdminUser.create({
    username: username.trim().toLowerCase(),
    google_email: process.env.SUPER_ADMIN_GOOGLE_EMAIL
      ? process.env.SUPER_ADMIN_GOOGLE_EMAIL.trim().toLowerCase()
      : null,
    display_name: displayName.trim(),
    password_hash: passwordHash,
    role: "super_admin",
    is_active: true
  });

  console.log("✅ Initial super admin account created.");
}

async function ensureMasterBhajanSchema() {
  try {
    const [columns] = await sequelize.query("PRAGMA table_info(master_bhajans)");
    if (columns && !columns.some((col) => col.name === "lyrics")) {
      await sequelize.query("ALTER TABLE master_bhajans ADD COLUMN lyrics TEXT");
    }
    if (columns && !columns.some((col) => col.name === "raga_notes")) {
      await sequelize.query("ALTER TABLE master_bhajans ADD COLUMN raga_notes TEXT");
    }
    if (columns && !columns.some((col) => col.name === "sheet_filename")) {
      await sequelize.query("ALTER TABLE master_bhajans ADD COLUMN sheet_filename VARCHAR(255)");
    }
    if (columns && !columns.some((col) => col.name === "is_active")) {
      await sequelize.query("ALTER TABLE master_bhajans ADD COLUMN is_active BOOLEAN DEFAULT 1");
    }
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_master_bhajans_is_active ON master_bhajans(is_active)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_master_bhajans_title_nocase ON master_bhajans(title COLLATE NOCASE)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_master_bhajans_deity ON master_bhajans(deity)"
    );
  } catch (err) {
    console.error("MasterBhajan schema check failed:", err.message);
  }
}

async function syncMasterBhajans() {
  try {
    const filePath = path.join(__dirname, "..", "master_bhajans.json");
    if (!fs.existsSync(filePath)) {
      console.log("ℹ️ master_bhajans.json not found, skipping Master Bhajan sync.");
      return;
    }

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS _app_meta (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT
      )
    `);

    const rawJson = fs.readFileSync(filePath, "utf8");
    const contentHash = crypto.createHash("sha256").update(rawJson).digest("hex");
    const data = JSON.parse(rawJson);

    const [metaRows] = await sequelize.query(
      "SELECT value FROM _app_meta WHERE key = 'master_bhajans_sha256' LIMIT 1"
    );
    const storedHash = metaRows && metaRows[0] ? metaRows[0].value : null;
    const currentActiveCount = await MasterBhajan.count({ where: { is_active: true } });

    if (storedHash === contentHash && currentActiveCount === data.length) {
      return;
    }

    const { Op } = require("sequelize");
    const validIds = new Set(data.map((item) => item.id));

    // 1. Deactivate all non-Prashanti Mandir bhajans
    const [deactivated] = await MasterBhajan.update(
      { is_active: false },
      {
        where: {
          id: { [Op.notIn]: Array.from(validIds) },
          is_active: true
        }
      }
    );
    if (deactivated > 0) {
      console.log(`📦 Archived ${deactivated} non-Prashanti Mandir bhajans.`);
    }

    // 2. Batch-upsert authoritative 1,024 Prashanti Mandir bhajans in safe parameter chunks
    const preparedRows = data.map((item) => {
      let deityClean = item.deity;
      if (deityClean) {
        const seenDeities = new Set();
        deityClean.split(/[,;&\/]+/).forEach((s) => {
          const t = s.trim();
          const l = t.toLowerCase();
          if (
            l === "anjaneya" ||
            l === "aanjaneya" ||
            l === "hanuman" ||
            l === "maruti" ||
            l === "maruthi"
          ) {
            seenDeities.add("Hanuman");
          } else if (
            l === "vittala" ||
            l === "vithhala" ||
            l === "vithala" ||
            l === "vitthala"
          ) {
            seenDeities.add("Vitthala");
          } else if (l === "devi" || l === "mata") {
            seenDeities.add("Mata");
          } else if (l === "sarva dharma" || l === "sarvadharma") {
            seenDeities.add("SarvaDharma");
          } else if (t) {
            seenDeities.add(t);
          }
        });
        deityClean = Array.from(seenDeities).join(", ");
      }
      return {
        id: item.id,
        title: item.title,
        deity: deityClean,
        level: item.level || null,
        tempo: item.tempo || null,
        raga: item.raga || null,
        raga_notes: item.raga_notes || null,
        shruti: item.shruti || null,
        shruti_female: item.shruti_female || null,
        language: item.language || null,
        lyrics: item.lyrics || null,
        sheet_filename: item.sheet_filename || null,
        is_active: true
      };
    });

    const CHUNK_SIZE = 70;
    const updateFields = [
      "title",
      "deity",
      "level",
      "tempo",
      "raga",
      "raga_notes",
      "shruti",
      "shruti_female",
      "language",
      "lyrics",
      "sheet_filename",
      "is_active"
    ];

    await sequelize.transaction(async (t) => {
      for (let i = 0; i < preparedRows.length; i += CHUNK_SIZE) {
        const chunk = preparedRows.slice(i, i + CHUNK_SIZE);
        await MasterBhajan.bulkCreate(chunk, {
          updateOnDuplicate: updateFields,
          transaction: t
        });
      }
      await sequelize.query(
        "INSERT INTO _app_meta (key, value) VALUES ('master_bhajans_sha256', :hash) ON CONFLICT(key) DO UPDATE SET value = :hash",
        { replacements: { hash: contentHash }, transaction: t }
      );
    });

    try {
      const { invalidateMasterCache } = require("./catalogCache");
      invalidateMasterCache();
    } catch (_) {}

    const activeCount = await MasterBhajan.count({ where: { is_active: true } });
    console.log(
      `✅ Master Bhajan Bank synchronized: ${activeCount} active Prashanti Mandir bhajans.`
    );
  } catch (error) {
    console.error("Error synchronizing master bhajans:", error);
  }
}

async function ensureSingerGenderColumn() {
  try {
    const [columns] = await sequelize.query("PRAGMA table_info(singer_dictionary)");
    if (!columns.some((column) => column.name === "gender")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN gender VARCHAR(20)");
    }
  } catch (err) {
    // Ignore if table info query fails
  }
}

async function ensureSingerPinColumn() {
  try {
    const [columns] = await sequelize.query("PRAGMA table_info(singer_dictionary)");
    if (!columns.some((column) => column.name === "pin")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN pin VARCHAR(255)");
    }
    if (!columns.some((column) => column.name === "pin_set_at")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN pin_set_at DATETIME");
    }
    if (!columns.some((column) => column.name === "last_login_at")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN last_login_at DATETIME");
    }
    if (!columns.some((column) => column.name === "auth_token")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN auth_token VARCHAR(255)");
    }
    if (!columns.some((column) => column.name === "preferred_scale")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN preferred_scale VARCHAR(50)");
    }
    if (!columns.some((column) => column.name === "failed_attempts")) {
      await sequelize.query(
        "ALTER TABLE singer_dictionary ADD COLUMN failed_attempts INTEGER DEFAULT 0"
      );
    }
    if (!columns.some((column) => column.name === "locked_until")) {
      await sequelize.query("ALTER TABLE singer_dictionary ADD COLUMN locked_until DATETIME");
    }
  } catch (err) {
    // Ignore if table info query fails
  }
}

async function initDeityRules() {
  try {
    const { VALID_DEITIES } = require("../config/constants");
    const defaultDeities = VALID_DEITIES || [
      "Ganesha",
      "Guru",
      "Mata",
      "SarvaDharma",
      "Sai",
      "Shiva",
      "Krishna",
      "Rama",
      "Narayana",
      "Vitthala",
      "Hanuman"
    ];

    const existing = await DeityRule.findAll({
      where: { session_date: "default" },
      attributes: ["deity_name"],
      raw: true
    });
    const existingSet = new Set(existing.map((r) => r.deity_name));
    const missing = defaultDeities.filter((d) => !existingSet.has(d));

    if (missing.length > 0) {
      await DeityRule.bulkCreate(
        missing.map((deity) => ({
          session_date: "default",
          deity_name: deity,
          min_required: 0,
          max_allowed: 2
        })),
        { ignoreDuplicates: true }
      );
    }
  } catch (error) {
    console.error("Error initializing deity rules:", error);
  }
}

async function migrateLegacySubmissions() {
  try {
    const count = await BhajanSubmission.count();
    if (count !== 0) return;

    const [oldData] = await sequelize.query("SELECT * FROM bhajan_submissions");
    if (!oldData || oldData.length === 0) return;

    const mappedData = oldData.map((row) => {
      const migratedRow = { ...row };
      delete migratedRow.id;
      return migratedRow;
    });

    await BhajanSubmission.bulkCreate(mappedData);
    console.log(`✅ Migrated ${oldData.length} records.`);
  } catch (error) {
    // Ignore if legacy table does not exist
  }
}

async function normalizeDeityNames() {
  try {
    await MasterBhajan.update({ deity: "SarvaDharma" }, { where: { deity: "Sarva dharma" } });
    await BhajanSubmission.update({ deity: "SarvaDharma" }, { where: { deity: "Sarva dharma" } });

    // Only scan rows containing legacy misspellings (excluding already-normalized exact 'Vitthala')
    const [mbRows] = await sequelize.query(`
      SELECT id, deity FROM master_bhajans
      WHERE deity IS NOT NULL
        AND deity != 'Vitthala'
        AND (LOWER(deity) LIKE '%vittala%' OR LOWER(deity) LIKE '%vithhala%' OR LOWER(deity) LIKE '%vithala%')
    `);
    for (const r of mbRows) {
      const parts = (r.deity || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const normalized = parts
        .map((p) => {
          const low = p.toLowerCase();
          if (low === "vittala" || low === "vithhala" || low === "vithala" || low === "vitthala") {
            return "Vitthala";
          }
          return p;
        })
        .join(", ");
      if (normalized !== r.deity) {
        await sequelize.query(`UPDATE master_bhajans SET deity = :deity WHERE id = :id`, {
          replacements: { deity: normalized, id: r.id }
        });
      }
    }

    await sequelize.query(`
      UPDATE bhajans_submitted_v2
      SET deity = 'Vitthala'
      WHERE LOWER(TRIM(deity)) IN ('vittala', 'vithhala', 'vithala')
    `);
  } catch (error) {
    console.error("Error normalizing deities:", error);
  }
}

async function ensureAdminUserColumns() {
  try {
    const [columns] = await sequelize.query("PRAGMA table_info(admin_users)");
    if (columns && !columns.some((col) => col.name === "title")) {
      await sequelize.query("ALTER TABLE admin_users ADD COLUMN title VARCHAR(255) DEFAULT ''");
    }
    if (columns && !columns.some((col) => col.name === "singer_id")) {
      await sequelize.query("ALTER TABLE admin_users ADD COLUMN singer_id INTEGER NULL");
    }
  } catch (err) {
    console.error("Column check failed for admin_users:", err.message);
  }
}

async function ensureActivityTables() {
  try {
    await sequelize.query("DROP TABLE IF EXISTS user_presence_backup");
    await sequelize.query("DROP TABLE IF EXISTS activity_logs_backup");
    await ActivityLog.sync();
    await UserPresence.sync();

    const [actCols] = await sequelize.query("PRAGMA table_info(activity_logs)");
    if (actCols && !actCols.some((col) => col.name === "session_id")) {
      await sequelize.query(
        "ALTER TABLE activity_logs ADD COLUMN session_id VARCHAR(255) DEFAULT ''"
      );
    }

    const [presCols] = await sequelize.query("PRAGMA table_info(user_presence)");
    if (presCols && !presCols.some((col) => col.name === "session_id")) {
      await sequelize.query(
        "ALTER TABLE user_presence ADD COLUMN session_id VARCHAR(255) DEFAULT ''"
      );
    }
  } catch (err) {
    console.error("Activity tables check failed:", err.message);
  }
}

async function ensureNotificationTables() {
  try {
    await Notification.sync();
    await NotificationRead.sync();
    await PushSubscription.sync();
    await Bulletin.sync();
    await BhajanReport.sync();
    await SingerBookmark.sync();
    await SessionAudio.sync();
    await SessionAudioTimestamp.sync();

    const [repCols] = await sequelize.query("PRAGMA table_info(bhajan_reports)");
    if (repCols && !repCols.some((col) => col.name === "singer_id")) {
      await sequelize.query("ALTER TABLE bhajan_reports ADD COLUMN singer_id INTEGER");
      await sequelize.query(
        "CREATE INDEX IF NOT EXISTS idx_bhajan_reports_singer_id ON bhajan_reports(singer_id)"
      );
    }

    console.log("✅ Notification, bulletin, report & singer bookmark tables ready.");
  } catch (err) {
    console.error("Notification tables check failed:", err.message);
  }
}

async function ensureDatabaseIndexes() {
  const indexStatements = [
    "CREATE INDEX IF NOT EXISTS idx_sub_session_date ON bhajans_submitted_v2(session_date)",
    "CREATE INDEX IF NOT EXISTS idx_sub_singer_name ON bhajans_submitted_v2(singer_name COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_sub_partner_name ON bhajans_submitted_v2(partner_name COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_sub_date_title ON bhajans_submitted_v2(session_date, title)",
    "CREATE INDEX IF NOT EXISTS idx_sub_title_nocase ON bhajans_submitted_v2(title COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_singers_name ON singer_dictionary(name COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_bhajan_reports_status_created ON bhajan_reports(status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_bhajan_reports_reporter_name ON bhajan_reports(reporter_name COLLATE NOCASE)",
    "CREATE INDEX IF NOT EXISTS idx_push_sub_device_id ON push_subscriptions(device_id)",
    "CREATE INDEX IF NOT EXISTS idx_push_sub_singer_enabled ON push_subscriptions(singer_id, enabled)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_target_created ON notifications(target_singer_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_notif_reads_device_notif ON notification_reads(device_id, notification_id)",
    "CREATE INDEX IF NOT EXISTS idx_bulletins_status_pin_pub ON bulletins(status, is_pinned, published_at)",
    "CREATE INDEX IF NOT EXISTS idx_activity_logs_session_created ON activity_logs(session_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_activity_logs_ip_created ON activity_logs(ip_address, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_activity_logs_username_created ON activity_logs(username, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen_at)",
    "CREATE INDEX IF NOT EXISTS idx_singer_bookmarks_singer ON singer_bookmarks(singer_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON Sessions(expires)"
  ];

  for (const sql of indexStatements) {
    try {
      await sequelize.query(sql);
    } catch (_) {
      // Safe if an optional table (e.g. Sessions before sync) does not yet exist
    }
  }
}

async function initializeDatabase() {
  try {
    await sequelize.sync();
    await ensureAdminUserColumns();
    await ensureSingerGenderColumn();
    await ensureSingerPinColumn();
    await ensureActivityTables();
    await ensureNotificationTables();
    await ensureMasterBhajanSchema();
    const { runDiwaliMigration } = require("./diwaliMigration");
    await runDiwaliMigration();
    await ensureDatabaseIndexes();

    await initializeSuperAdmin();
    await migrateLegacySubmissions();
    await syncMasterBhajans();
    await initDeityRules();
    await normalizeDeityNames();

    if (process.env.NODE_ENV !== "test") {
      const { startSessionScheduler } = require("./sessionScheduler");
      startSessionScheduler();

      const { startNightlyBackupScheduler } = require("./backupService");
      startNightlyBackupScheduler();
    }

    console.log("✅ Database initialization complete.");
  } catch (error) {
    console.error("Database initialization failed:", error);
    throw error;
  }
}

module.exports = {
  initializeDatabase
};
