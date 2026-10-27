const MasterBhajan = require("../models/MasterBhajan");
const { Sequelize } = require("sequelize");
const BhajanSubmission = require("../models/BhajanSubmission");
const Singer = require("../models/Singer");
const DeityRule = require("../models/DeityRule");

const {
  DEITY_ALIASES,
  DEITY_TITLE_MATCHERS,
  DEITY_TITLE_SEARCH_TERMS
} = require("../config/constants");

exports.getMasterBhajans = async (req, res) => {
  try {
    const deity = req.params.deity;
    const aliases = DEITY_ALIASES[deity] || [deity];
    const titleMatcher = DEITY_TITLE_MATCHERS[deity];
    const titleSearchTerms = DEITY_TITLE_SEARCH_TERMS[deity] || [];

    // Match exact deity or multi-deity substring (e.g. "Devi, Guru")
    const deityLikeConditions = aliases.map((a) => ({
      deity: { [Sequelize.Op.like]: `%${a}%` }
    }));

    const orConditions = [{ deity: { [Sequelize.Op.in]: aliases } }, ...deityLikeConditions];

    if (titleMatcher && titleSearchTerms.length > 0) {
      orConditions.push(
        ...titleSearchTerms.map((term) => ({
          title: { [Sequelize.Op.like]: `%${term}%` }
        }))
      );
    }

    const bhajans = await MasterBhajan.findAll({
      where: {
        is_active: true,
        [Sequelize.Op.or]: orConditions
      }
    });

    // Deduplicate by ID and verify deity match or title match before returning to UI
    const lowerAliases = aliases.map((a) => a.toLowerCase());
    const seenIds = new Set();
    const relevantBhajans = bhajans
      .filter((bhajan) => {
        const bDeityTokens = (bhajan.deity || "").split(/[,;&\/]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        const hasDeity = bDeityTokens.some((d) => {
          if (lowerAliases.includes(d)) return true;
          const tokenAliases = (DEITY_ALIASES[d] || []).map((x) => x.toLowerCase());
          return tokenAliases.some((ta) => lowerAliases.includes(ta));
        });
        return hasDeity || (titleMatcher && titleMatcher.test(bhajan.title));
      })
      .filter((bhajan) => {
        if (seenIds.has(bhajan.id)) return false;
        seenIds.add(bhajan.id);
        return true;
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    res.json(relevantBhajans);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get master bhajans:`, error);
    res.status(500).json({ error: "Failed to retrieve bhajans." });
  }
};

exports.checkCooldown = async (req, res) => {
  try {
    const { title } = req.query;
    if (!title) return res.json(null);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentSubmission = await BhajanSubmission.findOne({
      where: {
        title: { [Sequelize.Op.like]: title },
        session_date: { [Sequelize.Op.gte]: thirtyDaysAgo.toISOString().split("T")[0] }
      },
      order: [["session_date", "DESC"]]
    });

    res.json(recentSubmission);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to check cooldown:`, error);
    res.status(500).json({ error: "Failed to check bhajan cool-down status." });
  }
};

exports.getScaleSuggestions = async (req, res) => {
  try {
    const { title, singer_name, gender } = req.query;
    if (!title || !title.trim()) {
      return res.json({ singerPreviousScale: null, mostCommonGenderScale: null });
    }

    const cleanTitle = title.trim();
    let singerPreviousScale = null;
    let mostCommonGenderScale = null;

    // Feature 1: Singer's Previous Scale
    if (singer_name && singer_name.trim()) {
      const cleanSinger = singer_name.trim();
      const prevSubmission = await BhajanSubmission.findOne({
        where: {
          title: { [Sequelize.Op.like]: cleanTitle },
          singer_name: { [Sequelize.Op.like]: cleanSinger },
          scale: {
            [Sequelize.Op.and]: [
              { [Sequelize.Op.ne]: null },
              { [Sequelize.Op.ne]: "" },
              { [Sequelize.Op.ne]: "Not specified" }
            ]
          }
        },
        order: [
          ["created_at", "DESC"],
          ["session_date", "DESC"],
          ["id", "DESC"]
        ]
      });

      if (prevSubmission && prevSubmission.scale) {
        singerPreviousScale = prevSubmission.scale.trim();
      }
    }

    // Feature 2: Most Common Scale by Gender
    let targetGender = gender ? gender.trim() : null;
    if (!targetGender && singer_name && singer_name.trim()) {
      const singerObj = await Singer.findOne({
        where: { name: { [Sequelize.Op.like]: singer_name.trim() } }
      });
      if (singerObj && singerObj.gender) {
        targetGender = singerObj.gender;
      }
    }

    if (targetGender && ["Male", "Female"].includes(targetGender)) {
      const sameGenderSingers = await Singer.findAll({
        where: { gender: targetGender },
        attributes: ["name"],
        raw: true
      });
      const singerNamesList = sameGenderSingers.map((s) => s.name);

      const genderSubmissions = await BhajanSubmission.findAll({
        where: {
          title: { [Sequelize.Op.like]: cleanTitle },
          [Sequelize.Op.or]: [
            { gender: targetGender },
            { singer_name: { [Sequelize.Op.in]: singerNamesList } }
          ],
          scale: {
            [Sequelize.Op.and]: [
              { [Sequelize.Op.ne]: null },
              { [Sequelize.Op.ne]: "" },
              { [Sequelize.Op.ne]: "Not specified" }
            ]
          }
        },
        attributes: ["scale"]
      });

      if (genderSubmissions && genderSubmissions.length > 0) {
        const counts = {};
        let maxCount = 0;
        let topScale = null;

        for (const sub of genderSubmissions) {
          const s = (sub.scale || "").trim();
          if (s && s !== "Not specified") {
            counts[s] = (counts[s] || 0) + 1;
            if (counts[s] > maxCount) {
              maxCount = counts[s];
              topScale = s;
            }
          }
        }

        if (topScale) {
          mostCommonGenderScale = {
            gender: targetGender,
            scale: topScale
          };
        }
      }
    }

    res.json({
      singerPreviousScale,
      mostCommonGenderScale
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get scale suggestions:`, error);
    res.status(500).json({ error: "Failed to retrieve scale suggestions." });
  }
};

exports.getSingers = async (req, res) => {
  try {
    const singers = await Singer.findAll({
      attributes: ["id", "name", "gender"],
      order: [["name", "ASC"]]
    });
    res.json(singers);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to load singers:`, error);
    res.status(500).json({ error: "Failed to load singers list." });
  }
};

exports.getDeityRules = async (req, res) => {
  try {
    const { deityOrderKey } = require("../services/helpers");
    const date = req.query.date || "default";
    let rules = await DeityRule.findAll({ where: { session_date: date } });
    if (rules.length === 0 && date !== "default") {
      rules = await DeityRule.findAll({ where: { session_date: "default" } });
    }
    const plainRules = rules.map((r) => r.toJSON ? r.toJSON() : r);
    plainRules.sort((a, b) => deityOrderKey(a.deity_name) - deityOrderKey(b.deity_name));
    res.json(plainRules);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to load deity rules:`, error);
    res.status(500).json({ error: "Failed to load deity rules." });
  }
};

const UserPresence = require("../models/UserPresence");
const ActivityLog = require("../models/ActivityLog");
const { getSectionName } = require("../middleware/activityTracker");

exports.recordHeartbeat = async (req, res) => {
  try {
    const sessionId = req.session?.visitorId;
    if (!sessionId) return res.json({ success: false });

    const admin = req.session.admin || null;
    const userType = admin ? (admin.role === "super_admin" ? "super_admin" : "admin") : "user";
    const adminId = admin ? admin.id : null;
    const adminName = admin
      ? admin.display_name || admin.displayName || admin.username || "Admin"
      : "Guest User";
    const adminTitleStr = admin && admin.title ? ` (${admin.title})` : "";
    const username = admin ? `${adminName}${adminTitleStr}` : "Guest User";
    const pageUrl = req.body.page || "/";
    const section = getSectionName(pageUrl.split("?")[0]);
    const duration = parseInt(req.body.duration || 0, 10);

    await UserPresence.upsert({
      session_id: sessionId,
      admin_id: adminId,
      username: username,
      user_type: userType,
      current_page: pageUrl,
      last_section: section,
      ip_address: req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "127.0.0.1",
      last_seen_at: new Date()
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Record heartbeat error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

exports.recordOffline = async (req, res) => {
  try {
    const sessionId = req.session?.visitorId;
    if (sessionId) {
      await UserPresence.update(
        { last_seen_at: new Date(0) },
        { where: { session_id: sessionId } }
      );
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Record offline error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
