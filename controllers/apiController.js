const { Sequelize } = require("sequelize");
const BhajanSubmission = require("../models/BhajanSubmission");
const DeityRule = require("../models/DeityRule");
const UserPresence = require("../models/UserPresence");
const { getSectionName, resolveVisitorId } = require("../middleware/activityTracker");
const { getMasterCatalog, getSingersCatalog } = require("../services/catalogCache");

const {
  DEITY_ALIASES,
  DEITY_TITLE_MATCHERS
} = require("../config/constants");

exports.getMasterBhajans = async (req, res) => {
  try {
    const deity = req.params.deity;
    const aliases = DEITY_ALIASES[deity] || [deity];
    const titleMatcher = DEITY_TITLE_MATCHERS[deity];
    const lowerAliases = aliases.map((a) => a.toLowerCase().trim());

    const catalog = await getMasterCatalog();

    // Filter directly in memory (< 0.4ms vs full SQLite LIKE scan)
    const relevantBhajans = catalog.lightRows.filter((bhajan) => {
      const bDeityTokens = (bhajan.deity || "")
        .split(/[,;&/]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const hasDeity = bDeityTokens.some((d) => {
        if (lowerAliases.includes(d)) return true;
        if (lowerAliases.some((la) => d.includes(la) || la.includes(d))) return true;
        const tokenAliases = (DEITY_ALIASES[d] || []).map((x) => x.toLowerCase());
        return tokenAliases.some((ta) => lowerAliases.includes(ta));
      });
      return hasDeity || Boolean(titleMatcher && titleMatcher.test(bhajan.title));
    });

    res.json(relevantBhajans);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get master bhajans:`, error);
    res.status(500).json({ error: "Failed to retrieve bhajans." });
  }
};

exports.getBhajanLyrics = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid bhajan ID." });
    }
    const catalog = await getMasterCatalog();
    const item = catalog.fullById.get(id);
    if (!item || !item.is_active) {
      return res.status(404).json({ error: "Bhajan not found." });
    }
    res.set("Cache-Control", "public, max-age=300");
    return res.json({
      id: item.id,
      title: item.title,
      deity: item.deity,
      raga: item.raga,
      raga_notes: item.raga_notes,
      tempo: item.tempo,
      level: item.level,
      shruti: item.shruti,
      shruti_female: item.shruti_female,
      language: item.language,
      sheet_filename: item.sheet_filename,
      lyrics: item.lyrics || ""
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to get bhajan lyrics:`, error);
    res.status(500).json({ error: "Failed to load lyrics." });
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
      order: [["session_date", "DESC"]],
      raw: true
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
    const singersCatalog = await getSingersCatalog();

    let targetGender = gender ? gender.trim() : null;
    if (!targetGender && singer_name && singer_name.trim()) {
      const singerObj = singersCatalog.byLowerName.get(singer_name.trim().toLowerCase());
      if (singerObj && singerObj.gender) {
        targetGender = singerObj.gender;
      }
    }

    const validScaleCondition = {
      [Sequelize.Op.and]: [
        { [Sequelize.Op.ne]: null },
        { [Sequelize.Op.ne]: "" },
        { [Sequelize.Op.ne]: "Not specified" }
      ]
    };

    const prevSubPromise =
      singer_name && singer_name.trim()
        ? BhajanSubmission.findOne({
            where: {
              title: { [Sequelize.Op.like]: cleanTitle },
              singer_name: { [Sequelize.Op.like]: singer_name.trim() },
              scale: validScaleCondition
            },
            order: [
              ["created_at", "DESC"],
              ["session_date", "DESC"],
              ["id", "DESC"]
            ],
            attributes: ["scale"],
            raw: true
          })
        : Promise.resolve(null);

    let genderSubPromise = Promise.resolve([]);
    if (targetGender && ["Male", "Female"].includes(targetGender)) {
      const singerNamesList = singersCatalog.rows
        .filter((s) => s.gender === targetGender)
        .map((s) => s.name);

      genderSubPromise = BhajanSubmission.findAll({
        where: {
          title: { [Sequelize.Op.like]: cleanTitle },
          [Sequelize.Op.or]: [
            { gender: targetGender },
            ...(singerNamesList.length > 0
              ? [{ singer_name: { [Sequelize.Op.in]: singerNamesList } }]
              : [])
          ],
          scale: validScaleCondition
        },
        attributes: ["scale"],
        raw: true
      });
    }

    const [prevSubmission, genderSubmissions] = await Promise.all([
      prevSubPromise,
      genderSubPromise
    ]);

    const singerPreviousScale =
      prevSubmission && prevSubmission.scale ? prevSubmission.scale.trim() : null;

    let mostCommonGenderScale = null;
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
    const singersCatalog = await getSingersCatalog();
    const singers = singersCatalog.rows.map((s) => ({
      id: s.id,
      name: s.name,
      gender: s.gender || null
    }));
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
    let rules = await DeityRule.findAll({ where: { session_date: date }, raw: true });
    if (rules.length === 0 && date !== "default") {
      rules = await DeityRule.findAll({ where: { session_date: "default" }, raw: true });
    }
    rules.sort((a, b) => deityOrderKey(a.deity_name) - deityOrderKey(b.deity_name));
    res.json(rules);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Failed to load deity rules:`, error);
    res.status(500).json({ error: "Failed to load deity rules." });
  }
};

exports.recordHeartbeat = async (req, res) => {
  try {
    const sessionId = resolveVisitorId(req, res);
    if (!sessionId) return res.json({ success: false });

    const admin = req.session?.admin || null;
    const singer = req.session?.singer || null;
    const userType = admin
      ? admin.role === "super_admin"
        ? "super_admin"
        : "admin"
      : singer
        ? "singer"
        : "user";
    const adminId = admin ? admin.id : null;
    let username = "Guest User";
    if (admin) {
      const adminName = admin.display_name || admin.displayName || admin.username || "Admin";
      const adminTitleStr = admin.title ? ` (${admin.title})` : "";
      username = `${adminName}${adminTitleStr}`;
    } else if (singer && singer.name) {
      username = singer.name;
    }

    const pageUrl = req.body.page || "/";
    const section = getSectionName(pageUrl.split("?")[0]);

    await UserPresence.upsert({
      session_id: sessionId,
      admin_id: adminId,
      username,
      user_type: userType,
      current_page: pageUrl,
      last_section: section,
      ip_address: req.ip || req.socket?.remoteAddress || "127.0.0.1",
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
    const sessionId = req.cookies?.bp_vid || req.session?.visitorId;
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
