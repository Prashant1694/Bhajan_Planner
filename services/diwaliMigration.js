const sequelize = require("../config/database");

/**
 * Explicit migration for Diwali Bhajan Management module.
 * Creates only the new Diwali-specific tables and indexes.
 * Does NOT alter or drop any existing tables.
 */
async function runDiwaliMigration() {
  try {
    // 1. diwali_events
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS diwali_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        year INTEGER NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'Active',
        created_at DATETIME,
        updated_at DATETIME
      );
    `);

    // 2. diwali_participants
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS diwali_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        lead_name VARCHAR(255) NOT NULL,
        partner_name VARCHAR(255) NOT NULL,
        gender VARCHAR(50) NOT NULL,
        remarks TEXT,
        created_at DATETIME,
        updated_at DATETIME,
        FOREIGN KEY (event_id) REFERENCES diwali_events(id) ON DELETE CASCADE
      );
    `);

    // 3. diwali_participant_bhajans
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS diwali_participant_bhajans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        participant_id INTEGER NOT NULL,
        event_id INTEGER NOT NULL,
        master_bhajan_id INTEGER,
        bhajan_title VARCHAR(255) NOT NULL,
        scale VARCHAR(50),
        tabla VARCHAR(50),
        shruti VARCHAR(50),
        deity VARCHAR(100),
        remarks TEXT,
        original_order INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME,
        updated_at DATETIME,
        FOREIGN KEY (participant_id) REFERENCES diwali_participants(id) ON DELETE CASCADE,
        FOREIGN KEY (event_id) REFERENCES diwali_events(id) ON DELETE CASCADE,
        FOREIGN KEY (master_bhajan_id) REFERENCES master_bhajans(id) ON DELETE SET NULL
      );
    `);

    // 4. diwali_sequences
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS diwali_sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        sequence_number INTEGER NOT NULL,
        assigned_date VARCHAR(50),
        status VARCHAR(50) NOT NULL DEFAULT 'Draft',
        generated_at DATETIME,
        finalized_at DATETIME,
        created_at DATETIME,
        updated_at DATETIME,
        FOREIGN KEY (event_id) REFERENCES diwali_events(id) ON DELETE CASCADE
      );
    `);

    // 4a. Add per-sequence instrumentalist assignments to existing databases.
    const [sequenceColumns] = await sequelize.query("PRAGMA table_info(diwali_sequences)");
    if (!sequenceColumns.some((column) => column.name === "harmonium_player")) {
      await sequelize.query("ALTER TABLE diwali_sequences ADD COLUMN harmonium_player VARCHAR(255)");
    }
    if (!sequenceColumns.some((column) => column.name === "tabla_player")) {
      await sequelize.query("ALTER TABLE diwali_sequences ADD COLUMN tabla_player VARCHAR(255)");
    }

    // 4b. Distinguish automatic and manually curated Diwali sequences.
    const [sequenceTypeColumns] = await sequelize.query("PRAGMA table_info(diwali_sequences)");
    if (!sequenceTypeColumns.some((column) => column.name === "sequence_type")) {
      await sequelize.query(
        "ALTER TABLE diwali_sequences ADD COLUMN sequence_type VARCHAR(20) NOT NULL DEFAULT 'Auto'"
      );
    }
    await sequelize.query(
      "CREATE INDEX IF NOT EXISTS idx_diwali_sequences_event_type ON diwali_sequences(event_id, sequence_type)"
    );

    // 5. diwali_sequence_entries
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS diwali_sequence_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sequence_id INTEGER NOT NULL,
        participant_bhajan_id INTEGER NOT NULL,
        sequence_order INTEGER NOT NULL,
        created_at DATETIME,
        updated_at DATETIME,
        FOREIGN KEY (sequence_id) REFERENCES diwali_sequences(id) ON DELETE CASCADE,
        FOREIGN KEY (participant_bhajan_id) REFERENCES diwali_participant_bhajans(id) ON DELETE CASCADE
      );
    `);

    // Each participant bhajan may belong to exactly one sequence across the event,
    // regardless of whether that sequence is automatic or manually curated.
    // Older releases allowed auto/manual duplicates; keep the manual assignment first
    // because it represents an explicit curation, then keep the earliest remaining row.
    await sequelize.query(`
      DELETE FROM diwali_sequence_entries
      WHERE id IN (
        SELECT id FROM (
          SELECT entry.id,
                 ROW_NUMBER() OVER (
                   PARTITION BY entry.participant_bhajan_id
                   ORDER BY CASE WHEN sequence.sequence_type = 'Manual' THEN 0 ELSE 1 END,
                            sequence.id ASC,
                            entry.sequence_order ASC,
                            entry.id ASC
                 ) AS assignment_rank
          FROM diwali_sequence_entries AS entry
          INNER JOIN diwali_sequences AS sequence ON sequence.id = entry.sequence_id
        ) AS ranked_assignments
        WHERE assignment_rank > 1
      )
    `);

    // Compact sequence positions after removing legacy duplicate assignments.
    await sequelize.query(`
      WITH ranked_entries AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY sequence_id
                 ORDER BY sequence_order ASC, id ASC
               ) AS next_order
        FROM diwali_sequence_entries
      )
      UPDATE diwali_sequence_entries
         SET sequence_order = (
           SELECT next_order FROM ranked_entries
            WHERE ranked_entries.id = diwali_sequence_entries.id
         )
       WHERE id IN (SELECT id FROM ranked_entries)
    `);

    // Recreate after any legacy table rebuild, which drops table indexes.
    await sequelize.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_diwali_sequence_entries_bhajan_unique
       ON diwali_sequence_entries(participant_bhajan_id)`
    );

    // 6. Explicit Indexes
    const [entryIndexes] = await sequelize.query("PRAGMA index_list('diwali_sequence_entries')");
    let hasLegacyUniqueConstraint = false;
    for (const index of entryIndexes || []) {
      if (!index.unique || index.origin === "pk") continue;
      const safeName = String(index.name || "").replace(/"/g, '""');
      const [indexColumns] = await sequelize.query(`PRAGMA index_info("${safeName}")`);
      if (indexColumns.length === 1 && indexColumns[0].name === "participant_bhajan_id") {
        if (index.origin === "u") {
          hasLegacyUniqueConstraint = true;
        } else {
          await sequelize.query(`DROP INDEX IF EXISTS "${safeName}"`);
        }
      }
    }

    // SQLite cannot drop a table-level UNIQUE auto-index. Rebuild this
    // Diwali-only join table when one exists, preserving every saved entry.
    if (hasLegacyUniqueConstraint) {
      await sequelize.transaction(async (transaction) => {
        await sequelize.query(`
          CREATE TABLE diwali_sequence_entries_rebuild (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sequence_id INTEGER NOT NULL,
            participant_bhajan_id INTEGER NOT NULL,
            sequence_order INTEGER NOT NULL,
            created_at DATETIME,
            updated_at DATETIME,
            FOREIGN KEY (sequence_id) REFERENCES diwali_sequences(id) ON DELETE CASCADE,
            FOREIGN KEY (participant_bhajan_id) REFERENCES diwali_participant_bhajans(id) ON DELETE CASCADE
          )
        `, { transaction });
        await sequelize.query(`
          INSERT INTO diwali_sequence_entries_rebuild
            (id, sequence_id, participant_bhajan_id, sequence_order, created_at, updated_at)
          SELECT id, sequence_id, participant_bhajan_id, sequence_order, created_at, updated_at
          FROM diwali_sequence_entries
        `, { transaction });
        await sequelize.query("DROP TABLE diwali_sequence_entries", { transaction });
        await sequelize.query(
          "ALTER TABLE diwali_sequence_entries_rebuild RENAME TO diwali_sequence_entries",
          { transaction }
        );
      });
    }

    // 6. Explicit Indexes
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_participants_event_id ON diwali_participants(event_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_participants_gender ON diwali_participants(gender);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_bhajans_participant_id ON diwali_participant_bhajans(participant_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_bhajans_event_id ON diwali_participant_bhajans(event_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_bhajans_master_id ON diwali_participant_bhajans(master_bhajan_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_sequences_event_id ON diwali_sequences(event_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_seq_entries_seq_id ON diwali_sequence_entries(sequence_id);`
    );
    await sequelize.query(
      `CREATE INDEX IF NOT EXISTS idx_diwali_seq_entries_bhajan_id ON diwali_sequence_entries(participant_bhajan_id);`
    );

    console.log("✅ Diwali tables & indexes created successfully.");
  } catch (error) {
    console.error("❌ Error running Diwali migration:", error);
    throw error;
  }
}

module.exports = {
  runDiwaliMigration
};
