const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const sequelize = require("../config/database");

const AdminUser = require("../models/AdminUser");
const BhajanSubmission = require("../models/BhajanSubmission");
const MasterBhajan = require("../models/MasterBhajan");
const DeityRule = require("../models/DeityRule");
const ActivityLog = require("../models/ActivityLog");
const UserPresence = require("../models/UserPresence");

// New models for notification + bulletin system
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

    const { Op } = require("sequelize");
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const validIds = new Set(data.map((item) => item.id));

    // 1. Instantly deactivate all non-Prashanti Mandir bhajans
    // This safely filters the active catalog to the 1,024 PMB bhajans while preserving historical references
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

    // 2. Synchronize / upsert authoritative 1,024 Prashanti Mandir bhajans
    await sequelize.transaction(async (t) => {
      for (const item of data) {
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
        await MasterBhajan.upsert(
          {
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
          },
          { transaction: t }
        );
      }
    });

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

    for (const deity of defaultDeities) {
      await DeityRule.findOrCreate({
        where: { session_date: "default", deity_name: deity },
        defaults: {
          session_date: "default",
          deity_name: deity,
          min_required: 0,
          max_allowed: 2
        }
      });
    }
    console.log("✅ Deity rules verified for all deities including Narayana.");
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

    // Normalize Vittala / Vithhala / Vithala -> Vitthala
    const [mbRows] = await sequelize.query(`
      SELECT id, deity FROM master_bhajans 
      WHERE LOWER(deity) LIKE '%vitt%' OR LOWER(deity) LIKE '%vith%'
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

    const [subRows] = await sequelize.query(`
      SELECT id, deity FROM bhajans_submitted_v2 
      WHERE LOWER(deity) LIKE '%vitt%' OR LOWER(deity) LIKE '%vith%'
    `);
    for (const r of subRows) {
      const low = (r.deity || "").toLowerCase().trim();
      if (low === "vittala" || low === "vithhala" || low === "vithala") {
        await sequelize.query(`UPDATE bhajans_submitted_v2 SET deity = 'Vitthala' WHERE id = :id`, {
          replacements: { id: r.id }
        });
      }
    }
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

    // Double check session_id column in activity_logs
    const [actCols] = await sequelize.query("PRAGMA table_info(activity_logs)");
    if (actCols && !actCols.some((col) => col.name === "session_id")) {
      await sequelize.query(
        "ALTER TABLE activity_logs ADD COLUMN session_id VARCHAR(255) DEFAULT ''"
      );
    }

    // Double check session_id column in user_presence
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
    // These sync() calls only CREATE tables if they don't exist.
    // They will NOT alter or drop existing tables.
    await Notification.sync();
    await NotificationRead.sync();
    await PushSubscription.sync();
    await Bulletin.sync();
    await BhajanReport.sync();
    await SingerBookmark.sync();
    await SessionAudio.sync();
    await SessionAudioTimestamp.sync();

    // Check singer_id column in bhajan_reports
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
  try {
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_sub_session_date ON bhajans_submitted_v2(session_date)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_sub_singer_name ON bhajans_submitted_v2(singer_name)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_sub_partner_name ON bhajans_submitted_v2(partner_name)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_sub_date_title ON bhajans_submitted_v2(session_date, title)"
    );
    await sequelize.query("CREATE INDEX IF NOT EXISTS idx_singers_name ON singer_dictionary(name)");
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_bhajan_reports_status_created ON bhajan_reports(status, created_at)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_activity_logs_session_created ON activity_logs(session_id, created_at)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_activity_logs_ip_created ON activity_logs(ip_address, created_at)"
    );
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_user_presence_last_seen ON user_presence(last_seen_at)"
    );
  } catch (err) {
    console.error("Index creation notice:", err.message);
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
    await ensureDatabaseIndexes();
    const { runDiwaliMigration } = require("./diwaliMigration");
    await runDiwaliMigration();

    await initializeSuperAdmin();
    await migrateLegacySubmissions();
    await ensureMasterBhajanSchema();
    await syncMasterBhajans();
    await initDeityRules();
    await normalizeDeityNames();

    if (process.env.NODE_ENV !== "test") {
      // Start session lifecycle scheduler for automatic notifications
      const { startSessionScheduler } = require("./sessionScheduler");
      startSessionScheduler();

      // Start nightly database backup scheduler
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
