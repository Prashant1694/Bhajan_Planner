const { Sequelize } = require("sequelize");
const bcrypt = require("bcrypt");
const Singer = require("../models/Singer");
const BhajanSubmission = require("../models/BhajanSubmission");
const { timeSince, formatDateHuman } = require("../services/helpers");
const { invalidateSingerCache } = require("../services/catalogCache");

exports.showSingers = async (req, res) => {
  try {
    const [singers, stats] = await Promise.all([
      Singer.scope("withSecrets").findAll({
        order: [["name", "ASC"]],
        raw: true
      }),
      BhajanSubmission.findAll({
        attributes: [
          "singer_name",
          [Sequelize.fn("COUNT", Sequelize.col("id")), "total_sung"],
          [Sequelize.fn("MAX", Sequelize.col("session_date")), "last_sung"]
        ],
        group: ["singer_name"],
        raw: true
      })
    ]);

    const statsMap = new Map();
    stats.forEach((st) => {
      if (st.singer_name) {
        statsMap.set(st.singer_name.trim().toLowerCase(), {
          total_sung: parseInt(st.total_sung, 10) || 0,
          last_sung: st.last_sung
        });
      }
    });

    const existingNames = new Set(singers.map((s) => s.name.trim().toLowerCase()));
    const unrecordedSingers = [];

    stats.forEach((st) => {
      const lower = (st.singer_name || "").trim().toLowerCase();
      if (lower && !existingNames.has(lower)) {
        unrecordedSingers.push({
          id: null,
          name: st.singer_name.trim(),
          gender: null,
          pin: null,
          is_unrecorded: true,
          total_sung: parseInt(st.total_sung, 10) || 0,
          last_sung: st.last_sung
        });
      }
    });

    const allSingers = [
      ...singers.map((s) => {
        const lower = (s.name || "").trim().toLowerCase();
        const st = statsMap.get(lower) || { total_sung: 0, last_sung: null };
        return {
          ...s,
          has_pin: Boolean(s.pin),
          pin: undefined,
          total_sung: st.total_sung,
          last_sung: st.last_sung,
          lastSungHuman: st.last_sung ? timeSince(st.last_sung) : "Never",
          formattedDate: st.last_sung ? formatDateHuman(st.last_sung) : "No sessions"
        };
      }),
      ...unrecordedSingers.map((s) => ({
        ...s,
        has_pin: false,
        lastSungHuman: s.last_sung ? timeSince(s.last_sung) : "Never",
        formattedDate: s.last_sung ? formatDateHuman(s.last_sung) : "No sessions"
      }))
    ];

    allSingers.sort((a, b) => a.name.localeCompare(b.name));

    const totalSingers = allSingers.length;
    const maleCount = allSingers.filter((s) => (s.gender || "").toLowerCase() === "male").length;
    const femaleCount = allSingers.filter(
      (s) => (s.gender || "").toLowerCase() === "female"
    ).length;
    const missingGenderCount = allSingers.filter((s) => !s.gender).length;
    const pinProtectedCount = singers.filter((s) => Boolean(s.pin)).length;
    const activeSingersCount = allSingers.filter((s) => s.total_sung > 0).length;

    res.render("singers", {
      singers: allSingers,
      metrics: {
        total: totalSingers,
        male: maleCount,
        female: femaleCount,
        missingGender: missingGenderCount,
        pinProtected: pinProtectedCount,
        active: activeSingersCount
      },
      pageTitle: "Singers Directory",
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "singers",
      pinResetSuccess: req.query.pin_reset === "success",
      pinSetSuccess: req.query.pin_set === "success",
      csvImportedMessage: req.query.csv_imported || null,
      errorMessage: req.query.error || null
    });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] showSingers error:`, error);
    res.status(500).send("<h1>Error</h1><p>Failed to load singers directory.</p>");
  }
};

exports.showSingerDictionary = (req, res) => {
  res.redirect(301, "/admin/singers");
};

exports.addSinger = async (req, res) => {
  try {
    const { name, gender } = req.body;
    if (name && name.trim()) {
      const [singer] = await Singer.findOrCreate({
        where: { name: name.trim() },
        defaults: { gender: gender || null }
      });
      if (!singer.gender && gender) await singer.update({ gender });
      invalidateSingerCache();
    }
    res.redirect("/admin/singers");
  } catch (error) {
    console.error(`[Req ${req.id || ""}] addSinger error:`, error);
    res
      .status(500)
      .send(
        '<h1>Error adding singer</h1><p>Failed to add singer.</p><a href="/admin/singers">Back</a>'
      );
  }
};

exports.editSinger = async (req, res) => {
  try {
    const { name, gender } = req.body;
    if (name && name.trim()) {
      await Singer.update(
        { name: name.trim(), gender: gender || null },
        { where: { id: req.params.id } }
      );
      invalidateSingerCache();
    }
    res.redirect("/admin/singers");
  } catch (error) {
    console.error(`[Req ${req.id || ""}] editSinger error:`, error);
    res
      .status(500)
      .send(
        '<h1>Error editing singer</h1><p>Failed to edit singer.</p><a href="/admin/singers">Back</a>'
      );
  }
};

exports.deleteSinger = async (req, res) => {
  try {
    await Singer.destroy({ where: { id: req.params.id } });
    invalidateSingerCache();
    res.redirect("/admin/singers");
  } catch (error) {
    console.error(`[Req ${req.id || ""}] deleteSinger error:`, error);
    res
      .status(500)
      .send(
        '<h1>Error deleting singer</h1><p>Failed to delete singer.</p><a href="/admin/singers">Back</a>'
      );
  }
};

exports.resetSingerPin = async (req, res) => {
  try {
    const { id } = req.params;
    const singer = await Singer.findByPk(id);
    if (!singer) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(404).json({ error: "Singer not found" });
      }
      return res.redirect("/admin/singers?error=Singer+not+found");
    }
    await singer.update({
      pin: null,
      pin_set_at: null,
      failed_attempts: 0,
      locked_until: null
    });
    invalidateSingerCache();
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.json({ success: true, message: `PIN reset successfully for ${singer.name}` });
    }
    res.redirect("/admin/singers?pin_reset=success");
  } catch (error) {
    console.error(`[Req ${req.id || ""}] resetSingerPin error:`, error);
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(500).json({ error: "Failed to reset PIN." });
    }
    res.redirect("/admin/singers?error=Failed+to+reset+PIN");
  }
};

exports.setSingerPin = async (req, res) => {
  try {
    const { id } = req.params;
    const { pin } = req.body;
    const cleanPin = (pin || "").toString().trim();
    if (!/^\d{4}$/.test(cleanPin)) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(400).json({ error: "PIN must be exactly 4 numeric digits." });
      }
      return res.redirect("/admin/singers?error=PIN+must+be+exactly+4+numeric+digits");
    }
    const singer = await Singer.findByPk(id);
    if (!singer) {
      if (req.xhr || req.headers.accept?.includes("application/json")) {
        return res.status(404).json({ error: "Singer not found" });
      }
      return res.redirect("/admin/singers?error=Singer+not+found");
    }
    const hashed = await bcrypt.hash(cleanPin, 10);
    await singer.update({
      pin: hashed,
      pin_set_at: new Date(),
      failed_attempts: 0,
      locked_until: null
    });
    invalidateSingerCache();
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.json({ success: true, message: `PIN saved successfully for ${singer.name}` });
    }
    res.redirect("/admin/singers?pin_set=success");
  } catch (error) {
    console.error(`[Req ${req.id || ""}] setSingerPin error:`, error);
    if (req.xhr || req.headers.accept?.includes("application/json")) {
      return res.status(500).json({ error: "Failed to set PIN." });
    }
    res.redirect("/admin/singers?error=Failed+to+set+PIN");
  }
};

function sanitizeCsvCell(val) {
  let str = String(val === null || val === undefined ? "" : val).replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`;
  }
  return `"${str.replace(/"/g, '""')}"`;
}

exports.exportSingersCsv = async (req, res) => {
  try {
    const [singers, stats] = await Promise.all([
      Singer.scope("withSecrets").findAll({ order: [["name", "ASC"]], raw: true }),
      BhajanSubmission.findAll({
        attributes: [
          "singer_name",
          [Sequelize.fn("COUNT", Sequelize.col("id")), "total_sung"],
          [Sequelize.fn("MAX", Sequelize.col("session_date")), "last_sung"]
        ],
        group: ["singer_name"],
        raw: true
      })
    ]);
    const statsMap = new Map();
    stats.forEach((st) => {
      if (st.singer_name) {
        statsMap.set(st.singer_name.trim().toLowerCase(), {
          total_sung: parseInt(st.total_sung, 10) || 0,
          last_sung: st.last_sung || ""
        });
      }
    });

    const lines = ["Name,Gender,Preferred Scale,PIN Status,Total Sung,Last Sung"];
    singers.forEach((s) => {
      const st = statsMap.get((s.name || "").trim().toLowerCase()) || { total_sung: 0, last_sung: "" };
      lines.push(
        [
          sanitizeCsvCell(s.name),
          sanitizeCsvCell(s.gender || ""),
          sanitizeCsvCell(s.preferred_scale || ""),
          sanitizeCsvCell(s.pin ? "Protected" : "Not Set"),
          sanitizeCsvCell(st.total_sung),
          sanitizeCsvCell(st.last_sung)
        ].join(",")
      );
    });

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="singers-directory.csv"');
    res.send(lines.join("\r\n"));
  } catch (error) {
    console.error(`[Req ${req.id || ""}] exportSingersCsv error:`, error);
    res.status(500).send("Failed to export singers CSV.");
  }
};

exports.quickUpdateGender = async (req, res) => {
  try {
    const id = parseInt(req.body.id, 10);
    const genderRaw = String(req.body.gender || "").trim();
    const validGender = ["Male", "Female", "Other"].find(
      (g) => g.toLowerCase() === genderRaw.toLowerCase()
    );
    if (!id || !validGender) {
      return res.status(400).json({ error: "Valid singer id and gender required." });
    }
    const singer = await Singer.findByPk(id);
    if (!singer) {
      return res.status(404).json({ error: "Singer not found." });
    }
    await singer.update({ gender: validGender });
    invalidateSingerCache();
    res.json({ success: true, id, gender: validGender });
  } catch (error) {
    console.error(`[Req ${req.id || ""}] quickUpdateGender error:`, error);
    res.status(500).json({ error: "Failed to update singer gender." });
  }
};

exports.importSingersCsv = async (req, res) => {
  try {
    const rawCsv = String(req.body.csv_text || "").trim();
    if (!rawCsv) {
      return res.redirect("/admin/singers?error=Please+paste+CSV+rows+to+import");
    }

    const lines = rawCsv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let created = 0;
    let updated = 0;
    const VALID_GENDERS = new Map([
      ["male", "Male"],
      ["m", "Male"],
      ["female", "Female"],
      ["f", "Female"],
      ["other", "Other"]
    ]);

    for (let i = 0; i < Math.min(lines.length, 300); i++) {
      const line = lines[i];
      if (i === 0 && /^name\s*,/i.test(line)) continue;
      const parts = line.split(",").map((p) => p.replace(/^"|"$/g, "").trim());
      const name = (parts[0] || "").slice(0, 120);
      if (!name) continue;
      const genderMapped = VALID_GENDERS.get((parts[1] || "").toLowerCase()) || null;
      const preferredScale = (parts[2] || "").slice(0, 50) || null;

      const existing = await Singer.findOne({ where: { name } });
      if (existing) {
        const updates = {};
        if (!existing.gender && genderMapped) updates.gender = genderMapped;
        if (!existing.preferred_scale && preferredScale) updates.preferred_scale = preferredScale;
        if (Object.keys(updates).length > 0) {
          await existing.update(updates);
          updated++;
        }
      } else {
        await Singer.create({
          name,
          gender: genderMapped,
          preferred_scale: preferredScale
        });
        created++;
      }
    }

    invalidateSingerCache();
    res.redirect(`/admin/singers?csv_imported=${encodeURIComponent(`${created} added, ${updated} updated`)}`);
  } catch (error) {
    console.error(`[Req ${req.id || ""}] importSingersCsv error:`, error);
    res.redirect("/admin/singers?error=CSV+import+failed");
  }
};
