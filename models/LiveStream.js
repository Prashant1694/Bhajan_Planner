const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const LiveStream = sequelize.define(
  "LiveStream",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "offline"
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "Live Bhajan Session"
    },
    session_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    bitrate_kbps: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 320
    },
    access_mode: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "public"
    },
    current_submission_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    current_bhajan_title: {
      type: DataTypes.STRING,
      allowNull: true
    },
    current_singer_name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    current_master_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    started_by_admin_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    started_by_name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    ended_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    peak_listeners: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
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
    tableName: "live_streams",
    timestamps: false,
    indexes: [
      { fields: ["status"] },
      { fields: ["started_at"] }
    ]
  }
);

module.exports = LiveStream;
