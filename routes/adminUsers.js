const express = require("express");
const router = express.Router();

const adminUserController = require("../controllers/adminUserController");

const { requireLogin, requireSuperAdmin } = require("../middleware/auth");

router.get("/admin/users", requireLogin, requireSuperAdmin, (req, res) => res.redirect("/admin/admin-users"));

router.use("/admin/admin-users", requireLogin, requireSuperAdmin);

router.get("/admin/admin-users", adminUserController.listAdmins);
router.get("/admin/admin-users/new", adminUserController.showCreateForm);
router.post("/admin/admin-users", adminUserController.createAdmin);
router.get("/admin/admin-users/:id/edit", adminUserController.showEditForm);
router.post("/admin/admin-users/:id", adminUserController.updateAdmin);
router.post("/admin/admin-users/:id/delete", adminUserController.deleteAdmin);
router.post("/admin/admin-users/:id/toggle-active", adminUserController.toggleActive);
router.get("/admin/admin-users/:id/reset-password", adminUserController.showResetPasswordForm);
router.post("/admin/admin-users/:id/reset-password", adminUserController.resetPassword);

module.exports = router;
