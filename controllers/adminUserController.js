const bcrypt = require("bcrypt");
const AdminUser = require("../models/AdminUser");
const adminUserService = require("../services/adminUserService");

const Singer = require("../models/Singer");

exports.listAdmins = async (req, res) => {
  try {
    const admins = await AdminUser.findAll({
      include: [{ model: Singer, as: "singer", required: false }],
      order: [
        ["role", "ASC"],
        ["display_name", "ASC"]
      ]
    });

    res.render("admin-users", {
      admins,
      pageTitle: "Admin Management",
      currentAdmin: req.session.admin,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  } catch (error) {
    res.status(500).send(error.message);
  }
};
exports.showCreateForm = async (req, res) => {
  try {
    const singers = await Singer.findAll({ order: [["name", "ASC"]] });
    res.render("admin-user-form", {
      pageTitle: "Create Administrator",
      admin: null,
      singers,
      error: null,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  } catch (err) {
    res.render("admin-user-form", {
      pageTitle: "Create Administrator",
      admin: null,
      singers: [],
      error: err.message,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  }
};
exports.createAdmin = async (req, res) => {
  try {
    await adminUserService.createAdmin(req.body);
    res.redirect("/admin/admin-users");
  } catch (error) {
    const singers = await Singer.findAll({ order: [["name", "ASC"]] }).catch(() => []);
    res.render("admin-user-form", {
      pageTitle: "Create Administrator",
      admin: null,
      singers,
      error: error.message,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  }
};

exports.showEditForm = async (req, res) => {
  try {
    const admin = await adminUserService.findById(req.params.id);
    const singers = await Singer.findAll({ order: [["name", "ASC"]] });
    res.render("admin-user-form", {
      pageTitle: "Edit Administrator",
      admin,
      singers,
      error: null,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  } catch (error) {
    res.status(404).send(error.message);
  }
};
exports.updateAdmin = async (req, res) => {
  try {
    await adminUserService.updateAdmin(req.params.id, req.body);

    res.redirect("/admin/admin-users");
  } catch (error) {
    const admin = await adminUserService.findById(req.params.id);

    res.render("admin-user-form", {
      admin,
      error: error.message
    });
  }
};
exports.deleteAdmin = async (req, res) => {
  try {
    await adminUserService.deleteAdmin(
      req.session.adminUserId,

      req.params.id
    );

    res.redirect("/admin/admin-users");
  } catch (error) {
    res.status(400).send(error.message);
  }
};
exports.toggleActive = async (req, res) => {
  try {
    await adminUserService.toggleActive(req.session.adminUserId, req.params.id);

    res.redirect("/admin/admin-users");
  } catch (error) {
    res.status(400).send(error.message);
  }
};
exports.showResetPasswordForm = async (req, res) => {
  try {
    const admin = await adminUserService.findById(req.params.id);

    res.render("admin-reset-password", {
      pageTitle: "Reset Password",
      admin,
      error: null,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  } catch (error) {
    res.status(404).send(error.message);
  }
};
exports.resetPassword = async (req, res) => {
  try {
    await adminUserService.resetPassword(req.params.id, req.body.password);

    res.redirect("/admin/admin-users");
  } catch (error) {
    const admin = await adminUserService.findById(req.params.id);

    res.render("admin-reset-password", {
      pageTitle: "Reset Password",
      admin,
      error: error.message,
      isAdminPage: true,
      pageCSS: "admin.css",
      page: "admin-users"
    });
  }
};
