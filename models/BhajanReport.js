const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const BhajanReport = sequelize.define(
  "BhajanReport",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    ticket_code: {
      type: DataTypes.STRING(30),
      allowNull: false,
      unique: true
    },
    master_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    singer_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    report_type: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "bhajan"
      // "bhajan" | "general"
    },
    bhajan_title: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    categories: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: "[]"
      // Stored as JSON array: bhajan categories or general categories
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    suggested_correction: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    page_context: {
      type: DataTypes.STRING(200),
      allowNull: true
    },
    reporter_name: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    reporter_contact: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    visitor_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: "pending"
      // "pending" | "under_review" | "resolved" | "closed"
    },
    admin_response: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    admin_notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    reviewed_by: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    reviewed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    resolved_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    user_viewed_reply: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    }
  },
  {
    tableName: "bhajan_reports",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      { fields: ["ticket_code"] },
      { fields: ["status"] },
      { fields: ["visitor_id"] },
      { fields: ["master_id"] }
    ]
  }
);

module.exports = BhajanReport;
