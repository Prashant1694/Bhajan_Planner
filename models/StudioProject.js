const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const StudioProject = sequelize.define(
  "StudioProject",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    project_uid: {
      type: DataTypes.STRING(96),
      allowNull: false,
      unique: true
    },
    session_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    title: {
      type: DataTypes.STRING(160),
      allowNull: false,
      defaultValue: "Bhajan Studio Session"
    },
    sample_rate: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 48000
    },
    bit_depth: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 24
    },
    channel_config: {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: "dual_mono_split"
    },
    duration_seconds: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0
    },
    local_files_json: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    r2_keys_json: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    project_state_json: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    publication_status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "draft"
    },
    checksum_sha256: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    updated_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    tableName: "studio_projects",
    timestamps: false
  }
);

module.exports = StudioProject;
