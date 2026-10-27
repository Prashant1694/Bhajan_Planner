const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
const Singer = require("../models/Singer");
const BhajanSubmission = require("../models/BhajanSubmission");
const BhajanReport = require("../models/BhajanReport");
const MasterBhajan = require("../models/MasterBhajan");
const SingerBookmark = require("../models/SingerBookmark");
const AdminUser = require("../models/AdminUser");
const SessionAudio = require("../models/SessionAudio");
const SessionAudioTimestamp = require("../models/SessionAudioTimestamp");
const { NINETY_DAYS_MS, resolveSingerForAdmin } = require("../middleware/singerAuth");
const { getLocalDateStr } = require("../services/helpers");
const { safeRedirect, DUMMY_BCRYPT_HASH } = require("../services/securityHelpers");

const MAX_SINGER_PIN_FAILURES = 5;
const SINGER_LOCKOUT_MS = 15 * 60 * 1000; // 15-minute temporary lockout

/**
 * Show the devotee login page
 */
exports.showLoginPage = async (req, res) => {
  try {
    const singers = await Singer.scope("withSecrets").findAll({
      order: [["name", "ASC"]],
      attributes: ["id", "name", "gender", "pin"]
    });

    const redirectUrl = safeRedirect(req.query.redirect, "/submit-form");
    const isExpired = req.query.expired === "true";

    res.render("singer-login", {
      pageTitle: "Singer Verification | Bhajan Planner",
      singers: singers.map((s) => ({
        id: s.id,
        name: s.name,
        gender: s.gender,
        hasPin: Boolean(s.pin)
      })),
      redirectUrl,
      isExpired,
      pageCSS: null,
      pageJS: null
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error loading singer login page:`, error);
    res.status(500).send("Unable to load singer verification page.");
  }
};

/**
 * Check if selected singer already has a PIN
 */
exports.checkSingerPinStatus = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid singer ID" });
    }
    const singer = await Singer.scope("withSecrets").findByPk(id);
    if (!singer) {
      return res.status(404).json({ error: "Singer not found" });
    }
    res.json({
      hasPin: Boolean(singer.pin),
      name: singer.name,
      gender: singer.gender
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] checkSingerPinStatus error:`, error);
    res.status(500).json({ error: "Failed to check PIN status." });
  }
};

/**
 * Singer authentication handler with database-backed lockout,
 * constant-time dummy bcrypt path, and coordinator-issued claim protection.
 */
exports.login = async (req, res) => {
  try {
    const { singer_id, pin, redirect } = req.body;

    if (!singer_id) {
      return res.status(400).json({ error: "Please select your name from the list." });
    }

    const numericSingerId = parseInt(singer_id, 10);
    if (isNaN(numericSingerId) || numericSingerId <= 0) {
      return res.status(400).json({ error: "Invalid singer selection." });
    }

    const cleanPin = (pin || "").toString().trim();
    if (!/^\d{4}$/.test(cleanPin)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid 4-digit numeric PIN (e.g. 1234)." });
    }

    // Query singer with secrets for authentication
    const singer = await Singer.scope("withSecrets").findByPk(numericSingerId);

    // Constant-time execution path if singer not found or not yet claimed with a PIN
    if (!singer || !singer.pin) {
      await bcrypt.compare(cleanPin, DUMMY_BCRYPT_HASH);
      if (!singer) {
        return res.status(404).json({ error: "Singer record not found." });
      }
      // Coordinator-set first-time claim policy:
      // Devotees cannot self-claim names with arbitrary PINs; a coordinator or admin must issue the initial PIN.
      return res.status(403).json({
        error:
          "This singer profile has not been assigned a PIN yet. Please contact a coordinator or admin to issue your initial PIN."
      });
    }

    // Check database-backed temporary lockout
    const now = Date.now();
    if (singer.locked_until && new Date(singer.locked_until).getTime() > now) {
      const remainingSec = Math.ceil((new Date(singer.locked_until).getTime() - now) / 1000);
      const mins = Math.ceil(remainingSec / 60);
      return res.status(429).json({
        error: `Account is temporarily locked due to 5 consecutive incorrect PIN attempts. Please wait ${mins} minute${mins === 1 ? "" : "s"} or contact a coordinator.`
      });
    }

    // Constant-time PIN verification
    const isMatch = await bcrypt.compare(cleanPin, singer.pin);
    if (!isMatch) {
      const nextFailures = (singer.failed_attempts || 0) + 1;
      if (nextFailures >= MAX_SINGER_PIN_FAILURES) {
        await singer.update({
          failed_attempts: nextFailures,
          locked_until: new Date(Date.now() + SINGER_LOCKOUT_MS)
        });
        return res.status(429).json({
          error:
            "Account is now temporarily locked for 15 minutes due to 5 consecutive incorrect PIN attempts. Please contact a coordinator if you forgot your PIN."
        });
      }

      await singer.update({ failed_attempts: nextFailures });
      const remaining = MAX_SINGER_PIN_FAILURES - nextFailures;
      return res.status(403).json({
        error: `Incorrect 4-digit PIN for ${singer.name}. (${remaining} attempt${remaining === 1 ? "" : "s"} remaining before temporary lock)`
      });
    }

    // Success: clear failed attempts and update last login
    await singer.update({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: new Date()
    });

    const existingVisitorId = req.session?.visitorId;
    const existingAdmin = req.session?.admin;
    const existingAdminUserId = req.session?.adminUserId;
    const validatedRedirect = safeRedirect(redirect, "/submit-form");

    // Regenerate session to eliminate session fixation risks
    req.session.regenerate((err) => {
      if (err) {
        console.error(`[Req ${req.id || ""}] Session regeneration failed:`, err);
        return res.status(500).json({ error: "Login failed. Please try again." });
      }

      if (existingVisitorId) req.session.visitorId = existingVisitorId;
      if (existingAdmin) req.session.admin = existingAdmin;
      if (existingAdminUserId) req.session.adminUserId = existingAdminUserId;

      req.session.singer = {
        id: singer.id,
        name: singer.name,
        gender: singer.gender,
        preferred_scale: singer.preferred_scale || null,
        pinVerifiedAt: Date.now()
      };

      if (existingAdminUserId) {
        AdminUser.update({ singer_id: singer.id }, { where: { id: existingAdminUserId } }).catch(
          () => {}
        );
      }

      req.session.save(() => {
        res.json({
          success: true,
          redirect: validatedRedirect,
          singer: req.session.singer,
          showIntro: false
        });
      });
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Singer login error:`, error);
    res.status(500).json({ error: "Authentication failed. Please try again." });
  }
};

/**
 * Render the full devotee hub (dashboard)
 */
exports.showHubPage = async (req, res) => {
  try {
    const singerSession = req.session.singer;
    const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));

    const embedParam = req.query._embed === "1" ? "&_embed=1" : "";

    if (!singerSession && !isAdmin) {
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/my-hub")}${embedParam}`);
    }

    if (!singerSession && isAdmin) {
      const adminId = req.session.adminUserId || req.session.admin?.id;
      const displayName = req.session.admin?.display_name || req.session.admin?.displayName;
      const username = req.session.admin?.username;
      const resolved = await resolveSingerForAdmin(adminId, displayName, username);
      if (resolved) {
        req.session.singer = {
          id: resolved.id,
          name: resolved.name,
          gender: resolved.gender,
          preferred_scale: resolved.preferred_scale || null,
          pinVerifiedAt: Date.now(),
          isAdminLinked: true
        };
      }
    }

    if (!req.session.singer) {
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/my-hub")}${embedParam}`);
    }

    const singer = await Singer.findByPk(req.session.singer.id);
    if (!singer) {
      delete req.session.singer;
      return res.redirect(`/singer/login?redirect=${encodeURIComponent("/my-hub")}${embedParam}`);
    }

    const todayStr = getLocalDateStr(new Date());

    const upcomingSubmissions = await BhajanSubmission.findAll({
      where: {
        session_date: { [Op.gte]: todayStr },
        [Op.or]: [{ singer_name: singer.name }, { partner_name: singer.name }]
      },
      order: [
        ["session_date", "ASC"],
        ["created_at", "ASC"]
      ],
      limit: 10
    });

    const pastSubmissions = await BhajanSubmission.findAll({
      where: {
        session_date: { [Op.lt]: todayStr },
        [Op.or]: [{ singer_name: singer.name }, { partner_name: singer.name }]
      },
      order: [["session_date", "DESC"]],
      limit: 30
    });

    // Fetch published audio recordings / timestamps for this singer (both lead and partner bhajans)
    try {
      const pastSubIds = pastSubmissions.map((s) => s.id).filter(Boolean);
      const orConditions = [{ singer_name: singer.name }];
      if (pastSubIds.length > 0) {
        orConditions.push({ submission_id: { [Op.in]: pastSubIds } });
      }

      const singerTimestamps = await SessionAudioTimestamp.findAll({
        where: { [Op.or]: orConditions },
        include: [
          {
            model: SessionAudio,
            as: "sessionAudio",
            where: { is_published: true }
          }
        ]
      });

      const audioMap = new Map();
      singerTimestamps.forEach((st) => {
        if (st.submission_id) audioMap.set(`sub_${st.submission_id}`, st);
        if (st.sessionAudio && st.sessionAudio.session_date && st.bhajan_title) {
          audioMap.set(
            `${st.sessionAudio.session_date}_${st.bhajan_title.trim().toLowerCase()}`,
            st
          );
        }
      });

      pastSubmissions.forEach((sub) => {
        const matched =
          (sub.id && audioMap.get(`sub_${sub.id}`)) ||
          audioMap.get(`${sub.session_date}_${(sub.title || "").trim().toLowerCase()}`);
        if (matched) {
          sub.setDataValue("audioTimestamp", matched);
        }
      });
    } catch (audioErr) {
      console.warn("Could not load singer audio timestamps:", audioErr.message);
    }

    const myBookmarks = await SingerBookmark.findAll({
      where: { singer_id: singer.id },
      include: [{ model: MasterBhajan, as: "masterBhajan" }],
      order: [["created_at", "DESC"]]
    });

    const myReports = await BhajanReport.findAll({
      where: {
        [Op.or]: [
          { singer_id: singer.id },
          { reporter_name: singer.name },
          { visitor_id: `singer_${singer.id}` }
        ]
      },
      order: [["created_at", "DESC"]],
      limit: 15
    });

    let allSingers = [];
    if (isAdmin) {
      allSingers = await Singer.findAll({
        attributes: ["id", "name", "gender"],
        order: [["name", "ASC"]]
      });
    }

    const verifiedAt = req.session?.singer?.pinVerifiedAt || Date.now();
    const elapsedMs = Math.max(0, Date.now() - verifiedAt);
    const daysRemaining = Math.max(
      1,
      Math.ceil((NINETY_DAYS_MS - elapsedMs) / (24 * 60 * 60 * 1000))
    );

    const deitySummary = {};
    pastSubmissions.forEach((sub) => {
      const d = sub.deity || "Other";
      deitySummary[d] = (deitySummary[d] || 0) + 1;
    });

    const showWelcome = req.query.welcome === "true";

    res.render("singer-hub", {
      pageTitle: `${singer.name} | Singer Hub`,
      singer,
      isAdmin,
      allSingers,
      upcomingSubmissions,
      pastSubmissions,
      pastHistory: pastSubmissions,
      songbook: myBookmarks,
      bookmarks: myBookmarks,
      reports: myReports,
      myReports,
      myReportsCount: myReports.length,
      deitySummary,
      daysRemaining,
      showWelcome,
      todayStr,
      pageCSS: "singer-hub.css",
      pageJS: "singer-hub.js"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] Error loading singer hub:`, error);
    res.status(500).send("Unable to load Singer Hub at this time.");
  }
};
exports.showHub = exports.showHubPage;

/**
 * Devotee Logout (Preserves admin session if logged in)
 */
exports.logout = (req, res) => {
  if (req.session) {
    delete req.session.singer;
    req.session.save(() => {
      res.redirect(safeRedirect(req.query.redirect, "/submit-form"));
    });
  } else {
    res.redirect("/submit-form");
  }
};

/**
 * Admin: Switch or link active Singer profile in session
 */
exports.adminSwitchSinger = async (req, res) => {
  try {
    const isAdmin = Boolean(req.session && (req.session.admin || req.session.adminUserId));
    if (!isAdmin) {
      return res.status(403).json({ error: "Unauthorized: Admin access required." });
    }

    const { singer_id, save_permanent } = req.body;
    if (!singer_id) {
      return res.status(400).json({ error: "Singer ID is required." });
    }

    const singer = await Singer.findByPk(singer_id);
    if (!singer) {
      return res.status(404).json({ error: "Singer record not found." });
    }

    req.session.singer = {
      id: singer.id,
      name: singer.name,
      gender: singer.gender,
      preferred_scale: singer.preferred_scale || null,
      pinVerifiedAt: Date.now(),
      isAdminLinked: true
    };

    if (save_permanent) {
      const adminId = req.session.adminUserId || req.session.admin?.id;
      if (adminId) {
        await AdminUser.update({ singer_id: singer.id }, { where: { id: adminId } });
      }
    }

    req.session.save(() => {
      res.json({
        success: true,
        message: `Switched active singer to ${singer.name}`,
        singer: req.session.singer
      });
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] adminSwitchSinger error:`, error);
    res.status(500).json({ error: "Failed to switch singer profile." });
  }
};

/**
 * Change 4-digit PIN
 */
exports.changePin = async (req, res) => {
  try {
    const singerSession = req.session.singer;
    if (!singerSession) {
      return res.status(401).json({ error: "Session expired. Please log in again." });
    }

    const { current_pin, new_pin } = req.body;
    const cleanCurrent = (current_pin || "").toString().trim();
    const cleanNew = (new_pin || "").toString().trim();

    if (!/^\d{4}$/.test(cleanNew)) {
      return res.status(400).json({ error: "New PIN must be exactly 4 digits." });
    }

    const singer = await Singer.scope("withSecrets").findByPk(singerSession.id);
    if (!singer) {
      return res.status(404).json({ error: "Singer not found." });
    }

    if (singer.pin) {
      const isMatch = await bcrypt.compare(cleanCurrent, singer.pin);
      if (!isMatch) {
        return res.status(403).json({ error: "Incorrect current 4-digit PIN." });
      }
    }

    const hashed = await bcrypt.hash(cleanNew, 10);
    await singer.update({
      pin: hashed,
      pin_set_at: new Date()
    });

    req.session.singer.pinVerifiedAt = Date.now();

    res.json({ success: true, message: "Your 4-digit PIN has been updated successfully." });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] changePin error:`, error);
    res.status(500).json({ error: "Failed to update PIN." });
  }
};

/**
 * Check if a bhajan is in current singer's songbook
 */
exports.checkSongbookStatus = async (req, res) => {
  try {
    const singerId = req.session?.singer?.id;
    const { masterId } = req.params;

    if (!singerId) {
      return res.json({ loggedIn: false, bookmarked: false });
    }

    const bookmark = await SingerBookmark.findOne({
      where: { singer_id: singerId, master_id: masterId }
    });

    res.json({
      loggedIn: true,
      bookmarked: Boolean(bookmark),
      bookmark: bookmark || null
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] checkSongbookStatus error:`, error);
    res.status(500).json({ error: "Failed to check songbook status." });
  }
};

/**
 * Toggle bookmark in personal songbook
 */
exports.toggleSongbook = async (req, res) => {
  try {
    const singerId = req.session.singer.id;
    const { master_id, custom_scale, notes } = req.body;

    if (!master_id) {
      return res.status(400).json({ error: "Master Bhajan ID is required." });
    }

    const master = await MasterBhajan.findByPk(master_id);
    if (!master) {
      return res.status(404).json({ error: "Bhajan not found." });
    }

    const existing = await SingerBookmark.findOne({
      where: { singer_id: singerId, master_id }
    });

    if (existing) {
      await existing.destroy();
      return res.json({
        success: true,
        bookmarked: false,
        message: `"${master.title}" removed from your Songbook.`
      });
    }

    const bookmark = await SingerBookmark.create({
      singer_id: singerId,
      master_id,
      custom_scale: custom_scale ? custom_scale.trim() : null,
      notes: notes ? notes.trim() : null
    });

    res.json({
      success: true,
      bookmarked: true,
      bookmark,
      message: `"${master.title}" saved to your Songbook!`
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] toggleSongbook error:`, error);
    res.status(500).json({ error: "Failed to update songbook." });
  }
};

/**
 * Update scale or notes in personal songbook
 */
exports.updateSongbookDetails = async (req, res) => {
  try {
    const singerId = req.session.singer.id;
    const { master_id, custom_scale, notes } = req.body;

    const bookmark = await SingerBookmark.findOne({
      where: { singer_id: singerId, master_id }
    });

    if (!bookmark) {
      return res.status(404).json({ error: "Songbook entry not found." });
    }

    await bookmark.update({
      custom_scale: custom_scale !== undefined ? custom_scale.trim() : bookmark.custom_scale,
      notes: notes !== undefined ? notes.trim() : bookmark.notes
    });

    res.json({
      success: true,
      bookmark,
      message: "Personal scale and practice notes saved!"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] updateSongbookDetails error:`, error);
    res.status(500).json({ error: "Failed to update songbook details." });
  }
};

/**
 * Get full personal songbook list
 */
exports.getSongbookList = async (req, res) => {
  try {
    const singerId = req.session.singer.id;
    const bookmarks = await SingerBookmark.findAll({
      where: { singer_id: singerId },
      include: [{ model: MasterBhajan, as: "masterBhajan" }],
      order: [["created_at", "DESC"]]
    });

    res.json({ success: true, bookmarks });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] getSongbookList error:`, error);
    res.status(500).json({ error: "Failed to load songbook." });
  }
};

/**
 * Update singer preferred pitch / default vocal scale
 */
exports.updatePreferredScale = async (req, res) => {
  try {
    const singerId = req.session?.singer?.id;
    const { preferred_scale } = req.body;
    if (!singerId) return res.status(401).json({ error: "Unauthorized" });

    const singer = await Singer.findByPk(singerId);
    if (!singer) return res.status(404).json({ error: "Singer not found" });

    const cleanScale = preferred_scale ? preferred_scale.trim() : null;
    await singer.update({ preferred_scale: cleanScale });

    if (req.session?.singer) {
      req.session.singer.preferred_scale = cleanScale;
    }

    res.json({
      success: true,
      preferred_scale: cleanScale,
      message: "Default singing pitch saved!"
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] updatePreferredScale error:`, error);
    res.status(500).json({ error: "Failed to update preferred scale." });
  }
};
