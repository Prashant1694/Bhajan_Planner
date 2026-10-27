const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SessionAudio = sequelize.define(
  "SessionAudio",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    session_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "Full Session Recording"
    },
    audio_url: {
      type: DataTypes.STRING,
      allowNull: false
    },
    storage_key: {
      type: DataTypes.STRING,
      allowNull: true // Cloudflare R2 object key (e.g. "recordings/2026-10-22.mp3")
    },
    duration_seconds: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    },
    file_size_bytes: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    is_published: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    tableName: "session_audios",
    timestamps: false,
    indexes: [
      {
        fields: ["session_date"]
      }
    ]
  }
);

module.exports = SessionAudio;
