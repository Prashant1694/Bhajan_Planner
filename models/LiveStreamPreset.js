const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const LiveStreamPreset = sequelize.define(
  "LiveStreamPreset",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true
    },
    config_json: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    created_by_admin_id: {
      type: DataTypes.INTEGER,
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
    tableName: "live_stream_presets",
    timestamps: false
  }
);

module.exports = LiveStreamPreset;
