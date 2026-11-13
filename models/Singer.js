const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Singer = sequelize.define(
  "Singer",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false, unique: true },
    gender: { type: DataTypes.STRING, allowNull: true },
    pin: { type: DataTypes.STRING, allowNull: true },
    pin_set_at: { type: DataTypes.DATE, allowNull: true },
    last_login_at: { type: DataTypes.DATE, allowNull: true },
    preferred_scale: { type: DataTypes.STRING, allowNull: true },
    auth_token: { type: DataTypes.STRING, allowNull: true },
    failed_attempts: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
    locked_until: { type: DataTypes.DATE, allowNull: true },
    unavailable_dates: { type: DataTypes.TEXT, allowNull: true }
  },
  {
    tableName: "singer_dictionary",
    timestamps: false,
    defaultScope: {
      attributes: { exclude: ["pin", "auth_token"] }
    },
    scopes: {
      withSecrets: {
        attributes: { include: ["pin", "auth_token"] }
      }
    }
  }
);

module.exports = Singer;
