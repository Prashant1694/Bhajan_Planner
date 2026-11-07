const DiwaliEvent = require("./DiwaliEvent");
const DiwaliParticipant = require("./DiwaliParticipant");
const DiwaliParticipantBhajan = require("./DiwaliParticipantBhajan");
const DiwaliSequence = require("./DiwaliSequence");
const DiwaliSequenceEntry = require("./DiwaliSequenceEntry");
const MasterBhajan = require("./MasterBhajan");

// Setup associations once
if (!DiwaliEvent.associations.participants) {
  DiwaliEvent.hasMany(DiwaliParticipant, {
    foreignKey: "event_id",
    as: "participants",
    onDelete: "CASCADE"
  });
  DiwaliParticipant.belongsTo(DiwaliEvent, {
    foreignKey: "event_id",
    as: "event"
  });

  DiwaliEvent.hasMany(DiwaliParticipantBhajan, {
    foreignKey: "event_id",
    as: "bhajans",
    onDelete: "CASCADE"
  });
  DiwaliParticipantBhajan.belongsTo(DiwaliEvent, {
    foreignKey: "event_id",
    as: "event"
  });

  DiwaliParticipant.hasMany(DiwaliParticipantBhajan, {
    foreignKey: "participant_id",
    as: "bhajans",
    onDelete: "CASCADE"
  });
  DiwaliParticipantBhajan.belongsTo(DiwaliParticipant, {
    foreignKey: "participant_id",
    as: "participant"
  });

  DiwaliParticipantBhajan.belongsTo(MasterBhajan, {
    foreignKey: "master_bhajan_id",
    as: "masterBhajan"
  });

  DiwaliEvent.hasMany(DiwaliSequence, {
    foreignKey: "event_id",
    as: "sequences",
    onDelete: "CASCADE"
  });
  DiwaliSequence.belongsTo(DiwaliEvent, {
    foreignKey: "event_id",
    as: "event"
  });

  DiwaliSequence.hasMany(DiwaliSequenceEntry, {
    foreignKey: "sequence_id",
    as: "entries",
    onDelete: "CASCADE"
  });
  DiwaliSequenceEntry.belongsTo(DiwaliSequence, {
    foreignKey: "sequence_id",
    as: "sequence"
  });

  DiwaliSequenceEntry.belongsTo(DiwaliParticipantBhajan, {
    foreignKey: "participant_bhajan_id",
    as: "participantBhajan"
  });
  // A selected bhajan may appear once in the automatic plan and once in a
  // separate manual curation. Keep this association one-to-many.
  DiwaliParticipantBhajan.hasMany(DiwaliSequenceEntry, {
    foreignKey: "participant_bhajan_id",
    as: "sequenceEntries",
    onDelete: "CASCADE"
  });
}

module.exports = {
  DiwaliEvent,
  DiwaliParticipant,
  DiwaliParticipantBhajan,
  DiwaliSequence,
  DiwaliSequenceEntry,
  MasterBhajan
};
