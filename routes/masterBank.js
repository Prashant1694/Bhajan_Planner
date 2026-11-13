const express = require("express");
const router = express.Router();
const { requireLogin, requireApiLogin } = require("../middleware/auth");

const masterBankController = require("../controllers/masterBankController");
router.get("/master-bank", masterBankController.showMasterBank);
router.get("/api/master-bhajans/catalog.json", masterBankController.getCatalogJson);
router.get("/bhajan/:id", masterBankController.showBhajanDetails);
router.post("/api/add-master-bhajan", requireApiLogin, masterBankController.addMasterBhajan);
router.post(
  "/api/admin/update-master-bhajan/:id",
  requireApiLogin,
  masterBankController.updateMasterBhajan
);
router.post(
  "/api/admin/delete-master-bhajan/:id",
  requireApiLogin,
  masterBankController.deleteMasterBhajan
);
router.post("/api/admin/reconcile-bhajan", requireApiLogin, masterBankController.reconcileBhajan);
router.get("/admin/export-master", requireLogin, masterBankController.exportMaster);
router.get(
  "/admin/archived-master-bhajans",
  requireLogin,
  masterBankController.showArchivedMasterBank
);
module.exports = router;
