const { Sequelize, Op } = require("sequelize");
const sequelize = require("../config/database");
const {
  DiwaliEvent,
  DiwaliParticipant,
  DiwaliParticipantBhajan,
  DiwaliSequence,
  DiwaliSequenceEntry,
  MasterBhajan
} = require("../models/diwaliModels");

// ============================================================
// 1. EVENT MANAGEMENT
// ============================================================

async function getOrCreateDefaultEvent() {
  let activeEvent = await DiwaliEvent.findOne({
    where: { status: "Active" },
    order: [["year", "DESC"]]
  });

  if (!activeEvent) {
    activeEvent = await DiwaliEvent.findOne({
      order: [["year", "DESC"]]
    });
  }

  if (!activeEvent) {
    const currentYear = new Date().getFullYear();
    activeEvent = await DiwaliEvent.create({
      year: currentYear,
      name: `Diwali ${currentYear}`,
      status: "Active"
    });
  }

  return activeEvent;
}

async function getAllEvents() {
  return await DiwaliEvent.findAll({
    order: [["year", "DESC"]]
  });
}

async function getEventById(id) {
  return await DiwaliEvent.findByPk(id);
}

async function createEvent({ year, name, status }) {
  const existing = await DiwaliEvent.findOne({ where: { year } });
  if (existing) {
    throw new Error(`Diwali event for year ${year} already exists.`);
  }

  return await DiwaliEvent.create({
    year: parseInt(year, 10),
    name: (name || `Diwali ${year}`).trim(),
    status: status || "Active"
  });
}

async function updateEvent(id, { name, status }) {
  const event = await DiwaliEvent.findByPk(id);
  if (!event) throw new Error("Event not found");

  if (name) event.name = name.trim();
  if (status) event.status = status;
  await event.save();
  return event;
}

// ============================================================
// 2. PARTICIPANTS & BHAJANS MANAGEMENT
// ============================================================

async function createParticipantWithBhajans({
  event_id,
  lead_name,
  partner_name,
  gender,
  remarks,
  bhajans
}) {
  const cleanLead = (lead_name || "").trim();
  const cleanPartner = (partner_name || "").trim();
  const cleanGender = (gender || "").trim();

  if (!cleanLead) throw new Error("Lead Singer Name is required.");
  if (!cleanPartner) throw new Error("Partner Name is required.");
  if (!cleanGender || !["Gents", "Ladies"].includes(cleanGender)) {
    throw new Error("Gender must be 'Gents' or 'Ladies'.");
  }

  if (!bhajans || !Array.isArray(bhajans) || bhajans.length === 0) {
    throw new Error("At least one bhajan is required.");
  }

  const validBhajans = bhajans.filter((b) => (b.bhajan_title || "").trim().length > 0);
  if (validBhajans.length === 0) {
    throw new Error("Please enter at least one valid bhajan title.");
  }

  // Ensure event_id is valid
  let resolvedEventId = event_id ? parseInt(event_id, 10) : null;
  if (!resolvedEventId || isNaN(resolvedEventId)) {
    const defaultEvent = await getOrCreateDefaultEvent();
    resolvedEventId = defaultEvent.id;
  } else {
    const ev = await DiwaliEvent.findByPk(resolvedEventId);
    if (!ev) {
      const defaultEvent = await getOrCreateDefaultEvent();
      resolvedEventId = defaultEvent.id;
    }
  }

  const t = await sequelize.transaction();
  try {
    const participant = await DiwaliParticipant.create(
      {
        event_id: resolvedEventId,
        lead_name: cleanLead,
        partner_name: cleanPartner,
        gender: cleanGender,
        remarks: (remarks || "").trim()
      },
      { transaction: t }
    );

    let order = 1;
    for (const b of validBhajans) {
      const title = (b.bhajan_title || "").trim();

      // Safely validate master_bhajan_id against MasterBhajan table
      let masterId = null;
      if (
        b.master_bhajan_id &&
        !isNaN(parseInt(b.master_bhajan_id, 10)) &&
        parseInt(b.master_bhajan_id, 10) > 0
      ) {
        const parsed = parseInt(b.master_bhajan_id, 10);
        const check = await MasterBhajan.findByPk(parsed, {
          transaction: t,
          attributes: ["id"]
        });
        if (check) masterId = check.id;
      }

      if (!masterId && title) {
        const found = await MasterBhajan.findOne({
          where: sequelize.where(
            sequelize.fn("LOWER", sequelize.col("title")),
            title.toLowerCase()
          ),
          transaction: t,
          attributes: ["id"]
        });
        if (found) masterId = found.id;
      }

      await DiwaliParticipantBhajan.create(
        {
          participant_id: participant.id,
          event_id: resolvedEventId,
          master_bhajan_id: masterId,
          bhajan_title: title,
          scale: (b.scale || "").trim(),
          tabla: (b.tabla || "").trim(),
          shruti: (b.shruti || "").trim(),
          deity: (b.deity || "").trim(),
          remarks: (b.remarks || "").trim(),
          original_order: order++
        },
        { transaction: t }
      );
    }

    await t.commit();
    return participant;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

async function getParticipantById(id) {
  return await DiwaliParticipant.findByPk(id, {
    include: [
      {
        model: DiwaliParticipantBhajan,
        as: "bhajans",
        order: [["original_order", "ASC"]]
      },
      { model: DiwaliEvent, as: "event" }
    ]
  });
}

async function updateParticipantWithBhajans(
  participantId,
  { lead_name, partner_name, gender, remarks, bhajans }
) {
  const cleanLead = (lead_name || "").trim();
  const cleanPartner = (partner_name || "").trim();
  const cleanGender = (gender || "").trim();

  if (!cleanLead) throw new Error("Lead Singer Name is required.");
  if (!cleanPartner) throw new Error("Partner Name is required.");
  if (!cleanGender || !["Gents", "Ladies"].includes(cleanGender)) {
    throw new Error("Gender must be 'Gents' or 'Ladies'.");
  }

  const participant = await DiwaliParticipant.findByPk(participantId);
  if (!participant) throw new Error("Participant not found.");

  if (!bhajans || !Array.isArray(bhajans)) {
    throw new Error("At least one valid bhajan is required.");
  }

  const validBhajans = bhajans.filter((b) => (b.bhajan_title || "").trim().length > 0);
  if (validBhajans.length === 0) {
    throw new Error("At least one valid bhajan is required.");
  }

  const t = await sequelize.transaction();
  try {
    participant.lead_name = cleanLead;
    participant.partner_name = cleanPartner;
    participant.gender = cleanGender;
    participant.remarks = (remarks || "").trim();
    await participant.save({ transaction: t });

    // Fetch existing bhajans to update in-place (preserving IDs and sequence entries)
    const existingBhajans = await DiwaliParticipantBhajan.findAll({
      where: { participant_id: participant.id },
      transaction: t
    });
    const existingMap = new Map();
    for (const eb of existingBhajans) {
      existingMap.set(eb.id, eb);
    }

    let order = 1;
    for (const b of validBhajans) {
      const title = (b.bhajan_title || "").trim();

      // Safely validate master_bhajan_id against MasterBhajan table
      let masterId = null;
      if (
        b.master_bhajan_id &&
        !isNaN(parseInt(b.master_bhajan_id, 10)) &&
        parseInt(b.master_bhajan_id, 10) > 0
      ) {
        const parsed = parseInt(b.master_bhajan_id, 10);
        const check = await MasterBhajan.findByPk(parsed, {
          transaction: t,
          attributes: ["id"]
        });
        if (check) masterId = check.id;
      }

      if (!masterId && title) {
        const found = await MasterBhajan.findOne({
          where: sequelize.where(
            sequelize.fn("LOWER", sequelize.col("title")),
            title.toLowerCase()
          ),
          transaction: t,
          attributes: ["id"]
        });
        if (found) masterId = found.id;
      }

      const bhajanId = b.id ? parseInt(b.id, 10) : null;
      if (bhajanId && existingMap.has(bhajanId)) {
        // Update existing bhajan record in-place to preserve primary key & sequence linkage
        const existingRecord = existingMap.get(bhajanId);
        existingRecord.master_bhajan_id = masterId;
        existingRecord.bhajan_title = title;
        existingRecord.scale = (b.scale || "").trim();
        existingRecord.tabla = (b.tabla || "").trim();
        existingRecord.shruti = (b.shruti || "").trim();
        existingRecord.deity = (b.deity || "").trim();
        existingRecord.remarks = (b.remarks || "").trim();
        existingRecord.original_order = order++;
        await existingRecord.save({ transaction: t });
        existingMap.delete(bhajanId);
      } else {
        // Insert new bhajan
        await DiwaliParticipantBhajan.create(
          {
            participant_id: participant.id,
            event_id: participant.event_id,
            master_bhajan_id: masterId,
            bhajan_title: title,
            scale: (b.scale || "").trim(),
            tabla: (b.tabla || "").trim(),
            shruti: (b.shruti || "").trim(),
            deity: (b.deity || "").trim(),
            remarks: (b.remarks || "").trim(),
            original_order: order++
          },
          { transaction: t }
        );
      }
    }

    // Remove any bhajans deleted by user in the edit modal
    const removedIds = Array.from(existingMap.keys());
    if (removedIds.length > 0) {
      // Clean up sequence entries first to avoid SQLite foreign key constraints
      await DiwaliSequenceEntry.destroy({
        where: { participant_bhajan_id: removedIds },
        transaction: t
      });
      await DiwaliParticipantBhajan.destroy({
        where: { id: removedIds },
        transaction: t
      });
    }

    await t.commit();
    return participant;
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

async function deleteParticipant(id) {
  const participant = await DiwaliParticipant.findByPk(id);
  if (!participant) throw new Error("Participant not found.");

  const t = await sequelize.transaction();
  try {
    const bhajans = await DiwaliParticipantBhajan.findAll({
      where: { participant_id: id },
      attributes: ["id"],
      transaction: t
    });
    const bhajanIds = bhajans.map((b) => b.id);

    if (bhajanIds.length > 0) {
      await DiwaliSequenceEntry.destroy({
        where: { participant_bhajan_id: bhajanIds },
        transaction: t
      });
      await DiwaliParticipantBhajan.destroy({
        where: { id: bhajanIds },
        transaction: t
      });
    }

    await participant.destroy({ transaction: t });
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function deleteBhajan(bhajanId) {
  const bhajan = await DiwaliParticipantBhajan.findByPk(bhajanId);
  if (!bhajan) throw new Error("Bhajan not found.");

  // Check if participant has other bhajans
  const count = await DiwaliParticipantBhajan.count({
    where: { participant_id: bhajan.participant_id }
  });
  if (count <= 1) {
    throw new Error("A participant must have at least one bhajan. Delete the participant instead.");
  }

  const t = await sequelize.transaction();
  try {
    await DiwaliSequenceEntry.destroy({
      where: { participant_bhajan_id: bhajanId },
      transaction: t
    });
    await bhajan.destroy({ transaction: t });
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function getParticipantsAndBhajans(eventId, filters = {}) {
  const whereEvent = { event_id: eventId };
  if (filters.gender && ["Gents", "Ladies"].includes(filters.gender)) {
    whereEvent.gender = filters.gender;
  }

  const participants = await DiwaliParticipant.findAll({
    where: whereEvent,
    include: [
      {
        model: DiwaliParticipantBhajan,
        as: "bhajans"
      }
    ],
    order: [
      ["gender", "ASC"],
      ["lead_name", "ASC"],
      [{ model: DiwaliParticipantBhajan, as: "bhajans" }, "original_order", "ASC"]
    ]
  });

  return participants;
}

// Flat row representation for tables & exports
async function getFlatBhajanRows(eventId, filters = {}) {
  const participantWhere = { event_id: eventId };
  if (filters.gender && ["Gents", "Ladies"].includes(filters.gender)) {
    participantWhere.gender = filters.gender;
  }

  const bhajans = await DiwaliParticipantBhajan.findAll({
    where: { event_id: eventId },
    include: [
      {
        model: DiwaliParticipant,
        as: "participant",
        where: participantWhere
      }
    ],
    order: [
      [{ model: DiwaliParticipant, as: "participant" }, "gender", "ASC"],
      [{ model: DiwaliParticipant, as: "participant" }, "lead_name", "ASC"],
      ["original_order", "ASC"]
    ]
  });

  let filtered = bhajans;

  if (filters.search) {
    const q = filters.search.toLowerCase().trim();
    filtered = filtered.filter((b) => {
      const p = b.participant;
      return (
        (p?.lead_name && p.lead_name.toLowerCase().includes(q)) ||
        (p?.partner_name && p.partner_name.toLowerCase().includes(q)) ||
        (b.bhajan_title && b.bhajan_title.toLowerCase().includes(q)) ||
        (b.deity && b.deity.toLowerCase().includes(q)) ||
        (b.scale && b.scale.toLowerCase().includes(q)) ||
        (b.tabla && b.tabla.toLowerCase().includes(q)) ||
        (b.shruti && b.shruti.toLowerCase().includes(q)) ||
        (b.remarks && b.remarks.toLowerCase().includes(q))
      );
    });
  }

  if (filters.deity) {
    const d = filters.deity.toLowerCase().trim();
    filtered = filtered.filter((b) => (b.deity || "").toLowerCase() === d);
  }

  if (filters.scale) {
    const s = filters.scale.toLowerCase().trim();
    filtered = filtered.filter((b) => (b.scale || "").toLowerCase() === s);
  }

  return filtered;
}

async function getStats(eventId) {
  const participants = await DiwaliParticipant.findAll({
    where: { event_id: eventId },
    include: [{ model: DiwaliParticipantBhajan, as: "bhajans" }]
  });

  const totalPairs = participants.length;
  let totalBhajans = 0;
  let gentsPairs = 0;
  let gentsBhajans = 0;
  let ladiesPairs = 0;
  let ladiesBhajans = 0;

  for (const p of participants) {
    const bCount = p.bhajans ? p.bhajans.length : 0;
    totalBhajans += bCount;
    if (p.gender === "Gents") {
      gentsPairs++;
      gentsBhajans += bCount;
    } else if (p.gender === "Ladies") {
      ladiesPairs++;
      ladiesBhajans += bCount;
    }
  }

  const sequences = await DiwaliSequence.findAll({
    where: { event_id: eventId },
    order: [["sequence_number", "ASC"]]
  });

  const generatedSequences = sequences.length;
  let sequenceStatus = "Not Generated";
  if (generatedSequences > 0) {
    const isFinalized = sequences.every((s) => s.status === "Finalized");
    sequenceStatus = isFinalized ? "Finalized" : "Draft";
  }

  return {
    totalPairs,
    totalBhajans,
    gentsPairs,
    gentsBhajans,
    ladiesPairs,
    ladiesBhajans,
    generatedSequences,
    sequenceStatus
  };
}

// ============================================================
// 3. FAIR DISTRIBUTION SEQUENCE GENERATOR
// ============================================================

/**
 * Distributes selected bhajans into numSequences using a balanced, fair algorithm:
 * - Every selected bhajan appears exactly once. No duplicates, none lost.
 * - Sequence sizes balanced (e.g. 100 over 4 = 25 each; 101 over 4 = 25, 25, 25, 26).
 * - Multi-bhajans for the same pair are spread across different sequences.
 * - Same pair is not placed immediately adjacent to itself in any sequence.
 * - Gents and Ladies balanced independently.
 */
async function generateFairSequences(eventId, numSequences, options = {}) {
  const K = parseInt(numSequences, 10);
  if (isNaN(K) || K < 2) {
    throw new Error("Number of sequences must be at least 2.");
  }

  const categories = options.categories || ["Gents", "Ladies"];

  // 1. Fetch all participants and bhajans for the event
  const participants = await DiwaliParticipant.findAll({
    where: { event_id: eventId },
    include: [{ model: DiwaliParticipantBhajan, as: "bhajans" }]
  });

  if (participants.length === 0) {
    throw new Error("No Diwali participants found for this event.");
  }

  // Split into categories
  const gentsParticipants = participants.filter((p) => p.gender === "Gents");
  const ladiesParticipants = participants.filter((p) => p.gender === "Ladies");

  // Buckets for each sequence: sequenceIndex (0..K-1)
  const sequenceBuckets = Array.from({ length: K }, (_, idx) => ({
    sequenceNumber: idx + 1,
    gentsBhajans: [],
    ladiesBhajans: [],
    allEntries: []
  }));

  // Track fairness metrics
  let totalBhajansAssigned = 0;
  let multiBhajanPairsCount = 0;
  let successfullySpreadCount = 0;
  let unavoidableConcentrationCount = 0;

  function distributeCategory(participantList, categoryKey) {
    const activeParticipants = participantList.filter((p) => p.bhajans && p.bhajans.length > 0);
    // Sort pairs by bhajan count descending (pairs with most bhajans placed first)
    activeParticipants.sort((a, b) => b.bhajans.length - a.bhajans.length);

    // Track which sequences contain each participant
    const pairSequenceUsage = new Map(); // participantId -> Map(seqIdx -> count)

    // Sequence load tracker for this category
    const seqCounts = new Array(K).fill(0);
    const seqDeityCounts = Array.from({ length: K }, () => new Map());

    for (const p of activeParticipants) {
      const bhajans = [...p.bhajans];
      const m = bhajans.length;
      if (m > 1) multiBhajanPairsCount++;

      pairSequenceUsage.set(p.id, new Map());
      const usage = pairSequenceUsage.get(p.id);

      let distinctSeqsForPair = 0;

      for (const bhajan of bhajans) {
        // Choose best sequence for this bhajan:
        // 1. Minimum occurrences of this participant in sequence
        // 2. Minimum total category load in sequence
        // 3. Minimum occurrence of this bhajan's deity in sequence
        let bestSeqIdx = -1;
        let minPairOccurrences = Infinity;
        let minSeqLoad = Infinity;
        let minDeityOccurrences = Infinity;

        // Shuffle indices slightly for symmetry breaking when counts are tied
        const candidateIndices = Array.from({ length: K }, (_, i) => i).sort(
          () => Math.random() - 0.5
        );

        for (const idx of candidateIndices) {
          const pairOccur = usage.get(idx) || 0;
          const load = seqCounts[idx];
          const deity = (bhajan.deity || "").toLowerCase();
          const deityOccur = seqDeityCounts[idx].get(deity) || 0;

          if (
            pairOccur < minPairOccurrences ||
            (pairOccur === minPairOccurrences && load < minSeqLoad) ||
            (pairOccur === minPairOccurrences &&
              load === minSeqLoad &&
              deityOccur < minDeityOccurrences)
          ) {
            bestSeqIdx = idx;
            minPairOccurrences = pairOccur;
            minSeqLoad = load;
            minDeityOccurrences = deityOccur;
          }
        }

        // Assign to bestSeqIdx
        usage.set(bestSeqIdx, (usage.get(bestSeqIdx) || 0) + 1);
        seqCounts[bestSeqIdx]++;
        if (bhajan.deity) {
          const dKey = bhajan.deity.toLowerCase();
          seqDeityCounts[bestSeqIdx].set(dKey, (seqDeityCounts[bestSeqIdx].get(dKey) || 0) + 1);
        }

        bhajan.participant = p;
        if (categoryKey === "Gents") {
          sequenceBuckets[bestSeqIdx].gentsBhajans.push(bhajan);
        } else {
          sequenceBuckets[bestSeqIdx].ladiesBhajans.push(bhajan);
        }
        totalBhajansAssigned++;
      }

      distinctSeqsForPair = usage.size;
      if (m > 1) {
        if (distinctSeqsForPair === Math.min(m, K)) {
          successfullySpreadCount++;
        } else {
          unavoidableConcentrationCount++;
        }
      }
    }
  }

  if (categories.includes("Gents")) {
    distributeCategory(gentsParticipants, "Gents");
  }
  if (categories.includes("Ladies")) {
    distributeCategory(ladiesParticipants, "Ladies");
  }

  // Intra-sequence anti-adjacency ordering:
  // Prevent same pair from appearing consecutively in sequence
  function reorderAvoidingAdjacent(list) {
    if (list.length <= 2) return list;
    const result = [];
    const pool = [...list];

    // Pick first item
    result.push(pool.shift());

    while (pool.length > 0) {
      const lastParticipantId = result[result.length - 1].participant_id;
      // Find candidate with different participant_id
      let candidateIdx = pool.findIndex((b) => b.participant_id !== lastParticipantId);
      if (candidateIdx === -1) {
        // Unavoidable: all remaining items belong to same participant
        candidateIdx = 0;
      }
      result.push(pool.splice(candidateIdx, 1)[0]);
    }
    return result;
  }

  for (const bucket of sequenceBuckets) {
    bucket.gentsBhajans = reorderAvoidingAdjacent(bucket.gentsBhajans);
    bucket.ladiesBhajans = reorderAvoidingAdjacent(bucket.ladiesBhajans);
    // Combine for overall sequence: Gents first, then Ladies (standard satsang sequence)
    bucket.allEntries = [...bucket.gentsBhajans, ...bucket.ladiesBhajans];
  }

  // 4. Persist to Database Transactionally
  const t = await sequelize.transaction();
  try {
    // Delete existing sequences for this event
    await DiwaliSequence.destroy({
      where: { event_id: eventId },
      transaction: t
    });

    const createdSequences = [];
    for (let i = 0; i < K; i++) {
      const bucket = sequenceBuckets[i];
      const seq = await DiwaliSequence.create(
        {
          event_id: eventId,
          sequence_number: i + 1,
          status: "Draft",
          generated_at: new Date()
        },
        { transaction: t }
      );

      let order = 1;
      for (const bhajan of bucket.allEntries) {
        await DiwaliSequenceEntry.create(
          {
            sequence_id: seq.id,
            participant_bhajan_id: bhajan.id,
            sequence_order: order++
          },
          { transaction: t }
        );
      }

      createdSequences.push(seq);
    }

    await t.commit();

    // Prepare fairness summary
    const fairnessSummary = {
      numSequences: K,
      totalBhajans: totalBhajansAssigned,
      totalPairs: participants.length,
      multiBhajanPairs: multiBhajanPairsCount,
      successfullySpread: successfullySpreadCount,
      unavoidableConcentration: unavoidableConcentrationCount,
      sequences: sequenceBuckets.map((b) => ({
        sequenceNumber: b.sequenceNumber,
        gentsCount: b.gentsBhajans.length,
        ladiesCount: b.ladiesBhajans.length,
        totalCount: b.allEntries.length
      }))
    };

    return {
      sequences: createdSequences,
      fairnessSummary
    };
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

// ============================================================
// 4. SEQUENCE EDITOR & MANAGEMENT
// ============================================================

async function getFullSequences(eventId) {
  const sequences = await DiwaliSequence.findAll({
    where: { event_id: eventId },
    order: [["sequence_number", "ASC"]],
    include: [
      {
        model: DiwaliSequenceEntry,
        as: "entries",
        include: [
          {
            model: DiwaliParticipantBhajan,
            as: "participantBhajan",
            include: [
              {
                model: DiwaliParticipant,
                as: "participant"
              }
            ]
          }
        ]
      }
    ]
  });

  // Sort entries by sequence_order in JavaScript
  sequences.forEach((seq) => {
    if (seq.entries) {
      seq.entries.sort((a, b) => a.sequence_order - b.sequence_order);
    }
  });

  return sequences;
}

async function getSingleSequence(sequenceId) {
  const seq = await DiwaliSequence.findByPk(sequenceId, {
    include: [
      {
        model: DiwaliSequenceEntry,
        as: "entries",
        include: [
          {
            model: DiwaliParticipantBhajan,
            as: "participantBhajan",
            include: [{ model: DiwaliParticipant, as: "participant" }]
          }
        ]
      },
      { model: DiwaliEvent, as: "event" }
    ]
  });

  if (seq && seq.entries) {
    seq.entries.sort((a, b) => a.sequence_order - b.sequence_order);
  }

  return seq;
}

async function updateSequenceEntriesOrder(sequenceId, orderedEntryIds) {
  const t = await sequelize.transaction();
  try {
    for (let i = 0; i < orderedEntryIds.length; i++) {
      const entryId = parseInt(orderedEntryIds[i], 10);
      await DiwaliSequenceEntry.update(
        { sequence_order: i + 1 },
        { where: { id: entryId, sequence_id: sequenceId }, transaction: t }
      );
    }
    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function moveEntryToAnotherSequence(entryId, targetSequenceId, targetOrder) {
  const entry = await DiwaliSequenceEntry.findByPk(entryId);
  if (!entry) throw new Error("Sequence entry not found");

  const targetSeq = await DiwaliSequence.findByPk(targetSequenceId);
  if (!targetSeq) throw new Error("Target sequence not found");

  const t = await sequelize.transaction();
  try {
    const oldSequenceId = entry.sequence_id;

    // Get max order in target sequence
    const maxOrder = await DiwaliSequenceEntry.max("sequence_order", {
      where: { sequence_id: targetSequenceId },
      transaction: t
    });

    const newOrder = targetOrder ? parseInt(targetOrder, 10) : (maxOrder || 0) + 1;

    entry.sequence_id = targetSequenceId;
    entry.sequence_order = newOrder;
    await entry.save({ transaction: t });

    // Normalize old sequence orders
    const remainingInOld = await DiwaliSequenceEntry.findAll({
      where: { sequence_id: oldSequenceId },
      order: [["sequence_order", "ASC"]],
      transaction: t
    });
    for (let i = 0; i < remainingInOld.length; i++) {
      remainingInOld[i].sequence_order = i + 1;
      await remainingInOld[i].save({ transaction: t });
    }

    await t.commit();
    return true;
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function assignSequenceDate(sequenceId, assignedDate) {
  const seq = await DiwaliSequence.findByPk(sequenceId);
  if (!seq) throw new Error("Sequence not found");

  seq.assigned_date = assignedDate ? assignedDate.trim() : null;
  await seq.save();
  return seq;
}

async function finalizeSequence(sequenceId) {
  const seq = await DiwaliSequence.findByPk(sequenceId);
  if (!seq) throw new Error("Sequence not found");

  seq.status = "Finalized";
  seq.finalized_at = new Date();
  await seq.save();
  return seq;
}

module.exports = {
  getOrCreateDefaultEvent,
  getAllEvents,
  getEventById,
  createEvent,
  updateEvent,
  createParticipantWithBhajans,
  getParticipantById,
  updateParticipantWithBhajans,
  deleteParticipant,
  deleteBhajan,
  getParticipantsAndBhajans,
  getFlatBhajanRows,
  getStats,
  generateFairSequences,
  getFullSequences,
  getSingleSequence,
  updateSequenceEntriesOrder,
  moveEntryToAnotherSequence,
  assignSequenceDate,
  finalizeSequence
};
