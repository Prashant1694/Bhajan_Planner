const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const DiwaliSequence = sequelize.define(
  "DiwaliSequence",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    event_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    sequence_number: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    assigned_date: {
      type: DataTypes.STRING,
      allowNull: true
    },
    harmonium_player: {
      type: DataTypes.STRING,
      allowNull: true
    },
    tabla_player: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "Draft" // "Draft", "Finalized"
    },
    generated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    finalized_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    tableName: "diwali_sequences",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at"
  }
);

module.exports = DiwaliSequence;
