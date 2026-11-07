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
  // Each selected bhajan has at most one sequence assignment per Diwali event.
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
