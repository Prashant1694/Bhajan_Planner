const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SessionAudioTimestamp = sequelize.define(
  "SessionAudioTimestamp",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    session_audio_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: "session_audios",
        key: "id"
      },
      onDelete: "CASCADE"
    },
    submission_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: "bhajans_submitted_v2",
        key: "id"
      },
      onDelete: "SET NULL"
    },
    bhajan_title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    singer_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    deity: {
      type: DataTypes.STRING,
      allowNull: true
    },
    start_seconds: {
      type: DataTypes.INTEGER,
      allowNull: false // e.g. 185 (03:05)
    },
    end_seconds: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    order_index: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    tableName: "session_audio_timestamps",
    timestamps: false,
    indexes: [
      {
        fields: ["session_audio_id"]
      },
      {
        fields: ["submission_id"]
      },
      {
        fields: ["singer_name"]
      }
    ]
  }
);

// Define associations
const SessionAudio = require("./SessionAudio");
const BhajanSubmission = require("./BhajanSubmission");

SessionAudio.hasMany(SessionAudioTimestamp, {
  foreignKey: "session_audio_id",
  as: "timestamps",
  onDelete: "CASCADE"
});

SessionAudioTimestamp.belongsTo(SessionAudio, {
  foreignKey: "session_audio_id",
  as: "sessionAudio"
});

SessionAudioTimestamp.belongsTo(BhajanSubmission, {
  foreignKey: "submission_id",
  as: "submission"
});

module.exports = SessionAudioTimestamp;
