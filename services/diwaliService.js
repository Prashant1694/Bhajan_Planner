const { Op } = require("sequelize");
const sequelize = require("../config/database");
const {
  DiwaliEvent,
  DiwaliParticipant,
  DiwaliParticipantBhajan,
  DiwaliSequence,
  DiwaliSequenceEntry,
  MasterBhajan
} = require("../models/diwaliModels");


// Parse public identifiers strictly; avoid silently accepting malformed IDs.
function requirePositiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`Invalid ${label || "identifier"}.`);
  }
  return id;
}

// Persist a complete sequence ordering in bounded bulk statements rather than
// issuing one UPDATE per bhajan (which made large sequences appear to freeze).
async function persistSequenceOrder(sequenceId, orderedEntryIds, transaction, options = {}) {
  const existing = await DiwaliSequenceEntry.findAll({
    where: { sequence_id: sequenceId },
    attributes: ["id", "sequence_id", "participant_bhajan_id"],
    order: [["sequence_order", "ASC"]],
    transaction
  });
  const ids = orderedEntryIds.map((value) => requirePositiveId(value, "sequence entry"));
  if (new Set(ids).size !== ids.length) {
    throw new Error("The sequence order contains duplicate bhajan entries.");
  }
  const existingById = new Map(existing.map((entry) => [Number(entry.id), entry]));
  if (ids.length !== existing.length || ids.some((id) => !existingById.has(id))) {
    throw new Error("The sequence changed while you were editing it. Reload and try again.");
  }

  const updates = ids.map((id, index) => {
    const entry = existingById.get(id);
    return {
      id,
      sequence_id: sequenceId,
      participant_bhajan_id: entry.participant_bhajan_id,
      sequence_order: index + 1
    };
  });

  for (let offset = 0; offset < updates.length; offset += 150) {
    await DiwaliSequenceEntry.bulkCreate(updates.slice(offset, offset + 150), {
      updateOnDuplicate: options.updateSequenceId
        ? ["sequence_id", "sequence_order", "updated_at"]
        : ["sequence_order", "updated_at"],
      transaction
    });
  }
}

async function normalizeSequenceOrder(sequenceId, transaction) {
  const entries = await DiwaliSequenceEntry.findAll({
    where: { sequence_id: sequenceId },
    attributes: ["id", "participant_bhajan_id"],
    order: [["sequence_order", "ASC"], ["id", "ASC"]],
    transaction
  });
  const updates = entries.map((entry, index) => ({
    id: entry.id,
    sequence_id: sequenceId,
    participant_bhajan_id: entry.participant_bhajan_id,
    sequence_order: index + 1
  }));
  for (let offset = 0; offset < updates.length; offset += 150) {
    await DiwaliSequenceEntry.bulkCreate(updates.slice(offset, offset + 150), {
      updateOnDuplicate: ["sequence_order", "updated_at"],
      transaction
    });
  }
}

async function normalizeSequencesAfterBhajanRemoval(bhajanIds, transaction) {
  if (!bhajanIds.length) return;
  const assignments = await DiwaliSequenceEntry.findAll({
    where: { participant_bhajan_id: { [Op.in]: bhajanIds } },
    attributes: ["sequence_id"],
    transaction
  });
  const sequenceIds = [...new Set(assignments.map((row) => Number(row.sequence_id)))];
  await DiwaliSequenceEntry.destroy({
    where: { participant_bhajan_id: { [Op.in]: bhajanIds } },
    transaction
  });
  for (const sequenceId of sequenceIds) {
    await normalizeSequenceOrder(sequenceId, transaction);
  }
}

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
    const participant = await DiwaliParticipant.findByPk(participantId, { transaction: t });
    if (!participant) throw new Error("Participant not found.");

    const submittedIds = validBhajans
      .filter((bhajan) => bhajan.id !== undefined && bhajan.id !== null && bhajan.id !== "")
      .map((bhajan) => requirePositiveId(bhajan.id, "bhajan"));
    if (new Set(submittedIds).size !== submittedIds.length) {
      throw new Error("The same existing bhajan was submitted more than once.");
    }

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

    if (submittedIds.some((id) => !existingMap.has(id))) {
      throw new Error("One or more selected bhajans no longer belong to this participant. Reload and try again.");
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
      await normalizeSequencesAfterBhajanRemoval(removedIds, t);
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

  const generatedSequences = sequences.filter((sequence) => sequence.sequence_type !== "Manual").length;
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
  const K = requirePositiveId(numSequences, "number of sequences");
  if (K < 2 || K > 50) {
    throw new Error("Choose between 2 and 50 sequences.");
  }

  const requestedCategories = options.categories === undefined
    ? ["Gents", "Ladies"]
    : options.categories;
  if (!Array.isArray(requestedCategories)) {
    throw new Error("Select at least one valid category.");
  }
  const categories = [...new Set(requestedCategories)];
  if (
    categories.length === 0 ||
    categories.some((category) => !["Gents", "Ladies"].includes(category))
  ) {
    throw new Error("Select at least one valid category (Gents or Ladies).");
  }

  const event = await DiwaliEvent.findByPk(eventId);
  if (!event) throw new Error("Diwali event not found.");

  const participants = await DiwaliParticipant.findAll({
    where: { event_id: eventId },
    include: [{ model: DiwaliParticipantBhajan, as: "bhajans" }],
    order: [["id", "ASC"]]
  });

  const gentsParticipants = participants.filter((p) => p.gender === "Gents");
  const ladiesParticipants = participants.filter((p) => p.gender === "Ladies");
  const sequenceBuckets = Array.from({ length: K }, (_, index) => ({
    sequenceNumber: index + 1,
    gentsBhajans: [],
    ladiesBhajans: [],
    allEntries: []
  }));

  let totalBhajansAssigned = 0;
  let multiBhajanPairsCount = 0;
  let successfullySpreadCount = 0;
  let unavoidableConcentrationCount = 0;
  let tieCursor = 0;

  function distributeCategory(participantList, categoryKey) {
    const activeParticipants = participantList
      .filter((participant) => participant.bhajans?.length)
      .sort((a, b) => b.bhajans.length - a.bhajans.length || Number(a.id) - Number(b.id));

    const sequenceCounts = new Array(K).fill(0);
    const sequenceDeityCounts = Array.from({ length: K }, () => new Map());

    for (const participant of activeParticipants) {
      const usage = new Map();
      const bhajans = [...participant.bhajans].sort(
        (a, b) => Number(a.original_order || 0) - Number(b.original_order || 0) || Number(a.id) - Number(b.id)
      );
      if (bhajans.length > 1) multiBhajanPairsCount++;

      for (const bhajan of bhajans) {
        const rotatedIndices = Array.from({ length: K }, (_, offset) => (tieCursor + offset) % K);
        let bestSequenceIndex = rotatedIndices[0];
        let bestPairUsage = Infinity;
        let bestSequenceLoad = Infinity;
        let bestDeityUsage = Infinity;

        for (const index of rotatedIndices) {
          const pairUsage = usage.get(index) || 0;
          const deityKey = String(bhajan.deity || "").trim().toLowerCase();
          const deityUsage = sequenceDeityCounts[index].get(deityKey) || 0;
          const better =
            pairUsage < bestPairUsage ||
            (pairUsage === bestPairUsage && sequenceCounts[index] < bestSequenceLoad) ||
            (pairUsage === bestPairUsage &&
              sequenceCounts[index] === bestSequenceLoad &&
              deityUsage < bestDeityUsage);

          if (better) {
            bestSequenceIndex = index;
            bestPairUsage = pairUsage;
            bestSequenceLoad = sequenceCounts[index];
            bestDeityUsage = deityUsage;
          }
        }

        usage.set(bestSequenceIndex, (usage.get(bestSequenceIndex) || 0) + 1);
        sequenceCounts[bestSequenceIndex]++;
        const deityKey = String(bhajan.deity || "").trim().toLowerCase();
        if (deityKey) {
          sequenceDeityCounts[bestSequenceIndex].set(
            deityKey,
            (sequenceDeityCounts[bestSequenceIndex].get(deityKey) || 0) + 1
          );
        }

        sequenceBuckets[bestSequenceIndex][
          categoryKey === "Gents" ? "gentsBhajans" : "ladiesBhajans"
        ].push(bhajan);
        totalBhajansAssigned++;
        tieCursor = (bestSequenceIndex + 1) % K;
      }

      if (bhajans.length > 1) {
        if (usage.size === Math.min(bhajans.length, K)) successfullySpreadCount++;
        else unavoidableConcentrationCount++;
      }
    }
  }

  if (categories.includes("Gents")) distributeCategory(gentsParticipants, "Gents");
  if (categories.includes("Ladies")) distributeCategory(ladiesParticipants, "Ladies");

  if (totalBhajansAssigned === 0) {
    throw new Error("No bhajans were found in the selected categories for this Diwali event.");
  }

  function reorderAvoidingAdjacent(list) {
    if (list.length <= 2) return list;
    const remaining = [...list];
    const result = [remaining.shift()];
    while (remaining.length) {
      const lastParticipantId = result[result.length - 1].participant_id;
      let index = remaining.findIndex((bhajan) => bhajan.participant_id !== lastParticipantId);
      if (index === -1) index = 0;
      result.push(remaining.splice(index, 1)[0]);
    }
    return result;
  }

  for (const bucket of sequenceBuckets) {
    bucket.gentsBhajans = reorderAvoidingAdjacent(bucket.gentsBhajans);
    bucket.ladiesBhajans = reorderAvoidingAdjacent(bucket.ladiesBhajans);
    bucket.allEntries = [...bucket.gentsBhajans, ...bucket.ladiesBhajans];
  }

  const transaction = await sequelize.transaction();
  try {
    const previousSequences = await DiwaliSequence.findAll({
      where: { event_id: eventId, sequence_type: "Auto" },
      attributes: ["id"],
      transaction
    });
    const previousIds = previousSequences.map((sequence) => sequence.id);
    if (previousIds.length) {
      await DiwaliSequenceEntry.destroy({
        where: { sequence_id: { [Op.in]: previousIds } },
        transaction
      });
      await DiwaliSequence.destroy({
        where: { id: { [Op.in]: previousIds }, event_id: eventId, sequence_type: "Auto" },
        transaction
      });
    }

    const createdSequences = [];
    for (const bucket of sequenceBuckets) {
      const sequence = await DiwaliSequence.create({
        event_id: eventId,
        sequence_number: bucket.sequenceNumber,
        sequence_type: "Auto",
        status: "Draft",
        generated_at: new Date()
      }, { transaction });
      createdSequences.push(sequence);
    }

    const entriesToCreate = [];
    for (let index = 0; index < sequenceBuckets.length; index++) {
      let order = 1;
      for (const bhajan of sequenceBuckets[index].allEntries) {
        entriesToCreate.push({
          sequence_id: createdSequences[index].id,
          participant_bhajan_id: bhajan.id,
          sequence_order: order++
        });
      }
    }

    for (let offset = 0; offset < entriesToCreate.length; offset += 200) {
      await DiwaliSequenceEntry.bulkCreate(entriesToCreate.slice(offset, offset + 200), {
        transaction,
        validate: true
      });
    }

    await transaction.commit();

    const fairnessSummary = {
      numSequences: K,
      totalBhajans: totalBhajansAssigned,
      totalPairs: participants.length,
      multiBhajanPairs: multiBhajanPairsCount,
      successfullySpread: successfullySpreadCount,
      unavoidableConcentration: unavoidableConcentrationCount,
      sequences: sequenceBuckets.map((bucket) => ({
        sequenceNumber: bucket.sequenceNumber,
        gentsCount: bucket.gentsBhajans.length,
        ladiesCount: bucket.ladiesBhajans.length,
        totalCount: bucket.allEntries.length
      }))
    };

    return { sequences: createdSequences, fairnessSummary };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function deleteSequence(eventId, sequenceId) {
  const id = Number.parseInt(sequenceId, 10);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid sequence selected.");

  const t = await sequelize.transaction();
  try {
    const sequence = await DiwaliSequence.findOne({
      where: { id, event_id: eventId },
      transaction: t
    });
    if (!sequence) throw new Error("Sequence not found for the selected Diwali event.");

    await DiwaliSequenceEntry.destroy({
      where: { sequence_id: sequence.id },
      transaction: t
    });
    await sequence.destroy({ transaction: t });

    await t.commit();
    return {
      deleted: true,
      sequenceNumber: sequence.sequence_number,
      sequenceType: sequence.sequence_type || "Auto"
    };
  } catch (error) {
    await t.rollback();
    throw error;
  }
}

async function getFullSequences(eventId) {
  const sequences = await DiwaliSequence.findAll({
    where: { event_id: eventId },
    order: [["sequence_type", "ASC"], ["sequence_number", "ASC"]],
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

async function updateSequenceEntriesOrder(sequenceId, orderedEntryIds, eventId) {
  const id = requirePositiveId(sequenceId, "sequence");
  if (!Array.isArray(orderedEntryIds)) throw new Error("A valid sequence order is required.");
  const transaction = await sequelize.transaction();
  try {
    const sequence = await DiwaliSequence.findOne({
      where: { id, ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) },
      transaction
    });
    if (!sequence) throw new Error("Sequence not found for the selected Diwali event.");
    await persistSequenceOrder(id, orderedEntryIds, transaction);
    await transaction.commit();
    return true;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function moveEntryToAnotherSequence(entryId, targetSequenceId, targetOrder, eventId) {
  const sourceEntryId = requirePositiveId(entryId, "sequence entry");
  const destinationId = requirePositiveId(targetSequenceId, "target sequence");
  const transaction = await sequelize.transaction();
  try {
    const entry = await DiwaliSequenceEntry.findByPk(sourceEntryId, { transaction });
    if (!entry) throw new Error("Sequence entry not found.");

    const sourceSequence = await DiwaliSequence.findByPk(entry.sequence_id, { transaction });
    const targetSequence = await DiwaliSequence.findByPk(destinationId, { transaction });
    if (!sourceSequence || !targetSequence) throw new Error("Source or target sequence no longer exists.");
    if (eventId && (Number(sourceSequence.event_id) !== Number(eventId) ||
      Number(targetSequence.event_id) !== Number(eventId))) {
      throw new Error("Sequences can only be edited within the selected Diwali event.");
    }
    if (sourceSequence.sequence_type !== targetSequence.sequence_type) {
      throw new Error("Bhajans can only be moved between sequences of the same type.");
    }

    const sourceEntries = await DiwaliSequenceEntry.findAll({
      where: { sequence_id: sourceSequence.id },
      order: [["sequence_order", "ASC"], ["id", "ASC"]],
      transaction
    });
    const sourceIds = sourceEntries.map((item) => Number(item.id));
    if (!sourceIds.includes(sourceEntryId)) throw new Error("The selected bhajan is no longer in its source sequence.");

    if (Number(sourceSequence.id) === Number(targetSequence.id)) {
      const requested = Number(targetOrder);
      const bounded = Number.isInteger(requested) && requested > 0
        ? Math.min(requested, sourceIds.length)
        : sourceIds.length;
      const nextIds = sourceIds.filter((id) => id !== sourceEntryId);
      nextIds.splice(Math.max(0, bounded - 1), 0, sourceEntryId);
      await persistSequenceOrder(sourceSequence.id, nextIds, transaction);
    } else {
      const targetEntries = await DiwaliSequenceEntry.findAll({
        where: { sequence_id: targetSequence.id },
        order: [["sequence_order", "ASC"], ["id", "ASC"]],
        transaction
      });
      const targetIds = targetEntries.map((item) => Number(item.id));
      const requested = Number(targetOrder);
      const insertAt = Number.isInteger(requested) && requested > 0
        ? Math.min(requested - 1, targetIds.length)
        : targetIds.length;
      targetIds.splice(insertAt, 0, sourceEntryId);

      // Move the entry and compact the source order in one transaction.
      entry.sequence_id = targetSequence.id;
      entry.sequence_order = insertAt + 1;
      await entry.save({ transaction });

      const sourceNextIds = sourceIds.filter((id) => id !== sourceEntryId);
      await persistSequenceOrder(sourceSequence.id, sourceNextIds, transaction);
      await persistSequenceOrder(targetSequence.id, targetIds, transaction, { updateSequenceId: true });
    }

    await transaction.commit();
    return true;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function getManualSequencePool(eventId) {
  const [usedRows] = await sequelize.query(
    `SELECT DISTINCT entry.participant_bhajan_id
       FROM diwali_sequence_entries AS entry
       INNER JOIN diwali_sequences AS sequence ON sequence.id = entry.sequence_id
      WHERE sequence.event_id = :eventId AND sequence.sequence_type = 'Manual'`,
    { replacements: { eventId } }
  );
  const usedIds = usedRows.map((row) => row.participant_bhajan_id);
  return DiwaliParticipantBhajan.findAll({
    where: {
      event_id: eventId,
      ...(usedIds.length ? { id: { [Op.notIn]: usedIds } } : {})
    },
    include: [{ model: DiwaliParticipant, as: "participant" }],
    order: [["original_order", "ASC"], ["id", "ASC"]]
  });
}

async function createManualSequence(eventId) {
  const id = requirePositiveId(eventId, "event");
  const transaction = await sequelize.transaction();
  try {
    const event = await DiwaliEvent.findByPk(id, { transaction });
    if (!event) throw new Error("Diwali event not found.");
    const lastManual = await DiwaliSequence.max("sequence_number", {
      where: { event_id: id, sequence_type: "Manual" },
      transaction
    });
    const sequence = await DiwaliSequence.create({
      event_id: id,
      sequence_number: Number(lastManual || 0) + 1,
      sequence_type: "Manual",
      status: "Draft",
      generated_at: new Date()
    }, { transaction });
    await transaction.commit();
    return sequence;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function addBhajansToManualSequence(sequenceId, participantBhajanIds, eventId) {
  const id = requirePositiveId(sequenceId, "manual sequence");
  const ids = [...new Set((participantBhajanIds || []).map((value) => requirePositiveId(value, "bhajan")))];
  if (!ids.length) throw new Error("Select at least one bhajan from the available pool.");
  if (ids.length > 500) throw new Error("Add no more than 500 bhajans at a time.");

  const transaction = await sequelize.transaction();
  try {
    const sequence = await DiwaliSequence.findOne({
      where: { id, sequence_type: "Manual", ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) },
      transaction
    });
    if (!sequence) throw new Error("Manual sequence not found for the selected Diwali event.");

    const bhajans = await DiwaliParticipantBhajan.findAll({
      where: { id: { [Op.in]: ids }, event_id: sequence.event_id },
      attributes: ["id"],
      transaction
    });
    if (bhajans.length !== ids.length) {
      throw new Error("One or more selected bhajans do not belong to this Diwali event.");
    }

    const alreadyAssigned = await DiwaliSequenceEntry.findAll({
      where: { participant_bhajan_id: { [Op.in]: ids } },
      include: [{
        model: DiwaliSequence,
        as: "sequence",
        where: { event_id: sequence.event_id, sequence_type: "Manual" },
        attributes: []
      }],
      transaction
    });
    if (alreadyAssigned.length) {
      throw new Error("One or more selected bhajans are already included in a manual sequence.");
    }

    const lastOrder = await DiwaliSequenceEntry.max("sequence_order", {
      where: { sequence_id: sequence.id },
      transaction
    });
    await DiwaliSequenceEntry.bulkCreate(
      ids.map((bhajanId, index) => ({
        sequence_id: sequence.id,
        participant_bhajan_id: bhajanId,
        sequence_order: Number(lastOrder || 0) + index + 1
      })),
      { transaction, validate: true }
    );
    await transaction.commit();
    return ids.length;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function removeBhajanFromManualSequence(sequenceId, entryId, eventId) {
  const id = requirePositiveId(sequenceId, "manual sequence");
  const rowId = requirePositiveId(entryId, "sequence entry");
  const transaction = await sequelize.transaction();
  try {
    const sequence = await DiwaliSequence.findOne({
      where: { id, sequence_type: "Manual", ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) },
      transaction
    });
    if (!sequence) throw new Error("Manual sequence not found for the selected Diwali event.");
    const entry = await DiwaliSequenceEntry.findOne({
      where: { id: rowId, sequence_id: id },
      transaction
    });
    if (!entry) throw new Error("Bhajan entry not found in this manual sequence.");
    await entry.destroy({ transaction });
    await normalizeSequenceOrder(id, transaction);
    await transaction.commit();
    return true;
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function assignSequenceDate(sequenceId, assignedDate, eventId) {
  const id = requirePositiveId(sequenceId, "sequence");
  const date = assignedDate == null ? "" : String(assignedDate).trim();
  if (date && !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) {
    throw new Error("Enter a valid session date.");
  }
  const seq = await DiwaliSequence.findOne({
    where: { id, ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) }
  });
  if (!seq) throw new Error("Sequence not found for the selected Diwali event.");
  seq.assigned_date = date || null;
  await seq.save();
  return seq;
}

async function assignSequenceMusicians(sequenceId, harmoniumPlayer, tablaPlayer, eventId) {
  const id = requirePositiveId(sequenceId, "sequence");
  const seq = await DiwaliSequence.findOne({
    where: { id, ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) }
  });
  if (!seq) throw new Error("Sequence not found for the selected Diwali event.");

  const harmonium = String(harmoniumPlayer || "").trim();
  const tabla = String(tablaPlayer || "").trim();
  if (!harmonium || !tabla) {
    throw new Error("Assign both a harmonium player and a tabla player for this session.");
  }
  if (harmonium.length > 255 || tabla.length > 255) {
    throw new Error("Player names must be 255 characters or fewer.");
  }

  seq.harmonium_player = harmonium;
  seq.tabla_player = tabla;
  await seq.save();
  return seq;
}

async function finalizeSequence(sequenceId, eventId) {
  const id = requirePositiveId(sequenceId, "sequence");
  const seq = await DiwaliSequence.findOne({
    where: { id, ...(eventId ? { event_id: requirePositiveId(eventId, "event") } : {}) }
  });
  if (!seq) throw new Error("Sequence not found for the selected Diwali event.");
  if (!String(seq.harmonium_player || "").trim() || !String(seq.tabla_player || "").trim()) {
    throw new Error("Assign both a harmonium player and a tabla player before finalizing this session.");
  }
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
  deleteSequence,
  getFullSequences,
  getSingleSequence,
  updateSequenceEntriesOrder,
  moveEntryToAnotherSequence,
  getManualSequencePool,
  createManualSequence,
  addBhajanToManualSequence,
  addBhajansToManualSequence,
  removeBhajanFromManualSequence,
  assignSequenceDate,
  assignSequenceMusicians,
  finalizeSequence
};
