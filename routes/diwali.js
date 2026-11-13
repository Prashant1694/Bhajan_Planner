const express = require("express");
const router = express.Router();
const multer = require("multer");
const diwaliController = require("../controllers/diwaliController");
const {
  requireLogin,
  requireSuperAdmin,
  requireApiLogin,
  requireApiSuperAdmin
} = require("../middleware/auth");

const path = require("path");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext === ".xlsx" || ext === ".xls") {
      cb(null, true);
    } else {
      cb(new Error("Only Excel spreadsheets (.xlsx, .xls) are allowed."));
    }
  }
});

// Diwali module is strictly restricted to Super Admins only
router.use("/admin/diwali", requireLogin, requireSuperAdmin);

// Diwali Main Dashboard
router.get("/admin/diwali", requireSuperAdmin, diwaliController.dashboard);

// Participant Entry Form
router.get("/admin/diwali/entry", requireLogin, diwaliController.showEntryForm);
router.post("/admin/diwali/entry", requireLogin, diwaliController.createParticipant);

// Participant Edit & Delete
router.get("/admin/diwali/participant/:id", requireLogin, diwaliController.getParticipantJson);
router.post(
  "/admin/diwali/participant/update/:id",
  requireLogin,
  diwaliController.updateParticipant
);
router.post(
  "/admin/diwali/participant/delete/:id",
  requireLogin,
  diwaliController.deleteParticipant
);
router.post("/admin/diwali/bhajan/delete/:id", requireLogin, diwaliController.deleteBhajan);

// Event Management
router.post("/admin/diwali/event/create", requireLogin, diwaliController.createEvent);

// Import Workflow
router.get("/admin/diwali/import", requireLogin, diwaliController.showImport);
router.post(
  "/admin/diwali/import/preview",
  requireLogin,
  upload.single("file"),
  diwaliController.previewImport
);
router.post("/admin/diwali/import/confirm", requireLogin, diwaliController.confirmImport);

// Yearly Data Export (Independent of sequence generation)
router.get("/admin/diwali/export/yearly", requireLogin, diwaliController.exportYearly);

// Sequence Generation & Management
router.post("/admin/diwali/sequence/generate", requireLogin, diwaliController.makeSequence);
router.post("/admin/diwali/sequence/delete/:id", requireLogin, diwaliController.deleteSequence);
router.get("/admin/diwali/csrf-token", requireLogin, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ csrfToken: res.locals.csrfToken || (typeof req.csrfToken === "function" ? req.csrfToken() : "") });
});
router.get("/admin/diwali/sequence/editor", requireLogin, diwaliController.showSequenceEditor);
router.post("/admin/diwali/sequence/manual/create", requireLogin, diwaliController.createManualSequence);
router.post("/admin/diwali/sequence/manual/add-bhajans", requireLogin, diwaliController.addManualBhajans);
router.post("/admin/diwali/sequence/manual/remove-bhajan", requireLogin, diwaliController.removeManualBhajan);
router.post("/admin/diwali/sequence/save-order", requireLogin, diwaliController.saveSequenceOrder);
router.post("/admin/diwali/sequence/move-entry", requireLogin, diwaliController.moveSequenceEntry);
router.post("/admin/diwali/sequence/assign-date", requireLogin, diwaliController.assignDate);
router.post("/admin/diwali/sequence/assign-period", requireLogin, diwaliController.assignSequencePeriod);
router.post("/admin/diwali/sequence/assign-musicians", requireLogin, diwaliController.assignMusicians);
router.post("/admin/diwali/sequence/finalize/:id", requireLogin, diwaliController.finalizeSequence);

// Sequence Export
router.get("/admin/diwali/export/sequence", requireLogin, diwaliController.exportSequence);

// Master Bhajan Bank Autocomplete Search API
router.get("/admin/diwali/api/search-master", requireLogin, diwaliController.searchMasterBhajans);

module.exports = router;
