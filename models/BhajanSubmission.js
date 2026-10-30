const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const BhajanSubmission = sequelize.define(
  "BhajanSubmission",
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
    singer_name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: true
    },
    partner_name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false
    },
    deity: {
      type: DataTypes.STRING,
      allowNull: false
    },
    scale: {
      type: DataTypes.STRING,
      allowNull: true
    },
    speed: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: "Medium"
    },
    list_order: { type: DataTypes.INTEGER, defaultValue: 0 },
    raga: { type: DataTypes.STRING, allowNull: true },
    level: { type: DataTypes.STRING, allowNull: true },
    language: { type: DataTypes.STRING, allowNull: true },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    }
  },
  {
    tableName: "bhajans_submitted_v2", // Changed to bypass SQLite's locked constraints
    timestamps: false
  }
);
module.exports = BhajanSubmission;
