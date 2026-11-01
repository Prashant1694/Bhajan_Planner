const bcrypt = require("bcrypt");
const { OAuth2Client } = require("google-auth-library");
const AdminUser = require("../models/AdminUser");
const UserPresence = require("../models/UserPresence");
const { Op } = require("sequelize");
const { resolveSingerForAdmin } = require("../middleware/singerAuth");
const {
  safeJsonStringify,
  validatePasswordPolicy
} = require("../services/securityHelpers");
const { destroyAdminSessions } = require("../services/sessionManager");
const { invalidateAdminCache } = require("../middleware/auth");

const googleClient = new OAuth2Client();

async function createAdminSession(req, admin) {
  return new Promise((resolve, reject) => {
    const prevVisitorId = req.session?.visitorId;
    const prevSinger = req.session?.singer; // Preserve existing devotee singer session

    req.session.regenerate(async (regenErr) => {
      if (regenErr) {
        console.error("Admin session regeneration error:", regenErr);
        return reject(regenErr);
      }
      if (prevVisitorId) req.session.visitorId = prevVisitorId;

      const now = Date.now();
      req.session.adminUserId = admin.id;
      req.session.adminLastActive = now;

      req.session.admin = {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name,
        title: admin.title || "",
        displayName: admin.display_name,
        role: admin.role,
        singer_id: admin.singer_id
      };

      if (prevSinger) {
        req.session.singer = prevSinger;
      } else {
        try {
          const singer = await resolveSingerForAdmin(admin.id, admin.display_name, admin.username);
          if (singer) {
            req.session.singer = {
              id: singer.id,
              name: singer.name,
              gender: singer.gender,
              preferred_scale: singer.preferred_scale || null,
              pinVerifiedAt: now,
              lastSyncedAt: now,
              isAdminLinked: true
            };
          }
        } catch (linkErr) {
          console.error("Failed to auto-link singer profile for admin:", linkErr);
        }
      }

      try {
        const visitorId = req.session.visitorId;
        if (visitorId) {
          const userType = admin.role === "super_admin" ? "super_admin" : "admin";
          const titleStr = admin.title ? ` (${admin.title})` : "";
          await UserPresence.update(
            {
              user_type: userType,
              admin_id: admin.id,
              username: `${admin.display_name || admin.username}${titleStr}`,
              last_seen_at: new Date()
            },
            { where: { session_id: visitorId } }
          );
        }
      } catch (err) {
        console.error("Session presence upgrade error:", err.message);
      }

      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve();
      });
    });
  });
}

exports.showLogin = (req, res) => {
  if (req.session && req.session.adminUserId) {
    return res.redirect("/admin");
  }

  res.render("admin-login", {
    error: null,
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    showLoader: true
  });
};

exports.login = async (req, res) => {
  try {
    const username = (req.body.username || "").trim().toLowerCase();
    const password = req.body.password || "";

    const admin = await AdminUser.scope("withSecrets").findOne({
      where: { username }
    });

    if (!admin || !admin.is_active) {
      return res.status(401).render("admin-login", {
        error: "Invalid username or password.",
        username,
        googleClientId: process.env.GOOGLE_CLIENT_ID || null,
        showLoader: false
      });
    }

    const passwordMatches = await bcrypt.compare(password, admin.password_hash);
    if (!passwordMatches) {
      return res.status(401).render("admin-login", {
        error: "Invalid username or password.",
        username,
        googleClientId: process.env.GOOGLE_CLIENT_ID || null,
        showLoader: false
      });
    }

    await createAdminSession(req, admin);

    req.session.save((error) => {
      if (error) {
        console.error("Session save failed:", error);
        return res.status(500).render("admin-login", {
          error: "Login failed. Please try again.",
          username,
          googleClientId: process.env.GOOGLE_CLIENT_ID || null,
          showLoader: false
        });
      }

      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logging in...</title></head><body>
      <script>
        try {
          localStorage.setItem('bp_is_admin', 'true');
          localStorage.setItem('bp_admin_name', ${safeJsonStringify(admin.display_name || admin.username)});
          localStorage.setItem('bp_admin_role', ${safeJsonStringify(admin.role || "admin")});
        } catch(_) {}
        if (window.top && window.top !== window.self) {
          window.top.location.href = '/admin';
        } else {
          window.location.href = '/admin';
        }
      </script></body></html>`);
    });
  } catch (error) {
    console.error("Admin login failed:", error);
    res.status(500).render("admin-login", {
      error: "Login failed. Please try again.",
      googleClientId: process.env.GOOGLE_CLIENT_ID || null,
      showLoader: false
    });
  }
};

async function verifyGoogleCredential(credential) {
  if (!credential) {
    throw new Error("Google credential is required.");
  }

  if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Google Sign-In is not configured.");
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: credential,
    audience: process.env.GOOGLE_CLIENT_ID
  });

  const payload = ticket.getPayload();
  if (!payload || !payload.sub) {
    throw new Error("Google authentication failed.");
  }

  return payload;
}

exports.googleLogin = async (req, res) => {
  try {
    const credential = req.body.credential;

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Google credential is required."
      });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error("GOOGLE_CLIENT_ID is not configured.");
      return res.status(500).json({
        success: false,
        error: "Google Sign-In is not configured."
      });
    }

    const payload = await verifyGoogleCredential(credential);
    const googleSub = payload.sub;
    const googleEmail = (payload.email || "").trim().toLowerCase();

    let admin = await AdminUser.scope("withSecrets").findOne({
      where: { google_sub: googleSub }
    });

    if (!admin) {
      if (!payload.email_verified || !googleEmail) {
        return res.status(403).json({
          success: false,
          error: "This Google account is not authorized."
        });
      }

      const pendingAdmin = await AdminUser.scope("withSecrets").findOne({
        where: {
          google_email: googleEmail,
          google_sub: null,
          is_active: true
        }
      });

      if (!pendingAdmin) {
        return res.status(403).json({
          success: false,
          error: "This Google account is not authorized."
        });
      }

      pendingAdmin.google_sub = googleSub;
      await pendingAdmin.save();
      admin = pendingAdmin;
    }

    if (!admin.is_active) {
      return res.status(403).json({
        success: false,
        error: "This Google account is not authorized."
      });
    }

    await createAdminSession(req, admin);

    req.session.save((error) => {
      if (error) {
        console.error("Google session save failed:", error);
        return res.status(500).json({
          success: false,
          error: "Login failed. Please try again."
        });
      }

      res.json({
        success: true,
        redirect: "/admin"
      });
    });
  } catch (error) {
    console.error("Google login failed:", error);
    res.status(401).json({
      success: false,
      error: "Google authentication failed."
    });
  }
};

exports.logout = async (req, res) => {
  try {
    const visitorId = req.session?.visitorId;
    const adminId = req.session?.adminUserId;
    if (visitorId || adminId) {
      await UserPresence.update(
        { last_seen_at: new Date(0) },
        {
          where: {
            [Op.or]: [
              visitorId ? { session_id: visitorId } : null,
              adminId ? { admin_id: adminId } : null
            ].filter(Boolean)
          }
        }
      );
    }
  } catch (err) {
    console.error("Logout presence update failed:", err.message);
  }

  const sendLogoutHtml = () => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Logging out...</title></head><body>
    <script>
      try {
        localStorage.removeItem('bp_is_admin');
        localStorage.removeItem('bp_admin_name');
        localStorage.removeItem('bp_admin_role');
      } catch(_) {}
      if (window.top && window.top !== window.self) {
        window.top.location.href = '/?logged_out=' + Date.now();
      } else {
        window.location.href = '/?logged_out=' + Date.now();
      }
    </script>
    </body></html>`);
  };

  if (req.session) {
    // Preserve an independently PIN-verified 90-day devotee singer session if present
    const hasIndependentSinger =
      req.session.singer && !req.session.singer.isAdminLinked && req.session.singer.id;

    if (hasIndependentSinger) {
      delete req.session.admin;
      delete req.session.adminUserId;
      delete req.session.adminLastActive;
      delete req.session.recoveryAdminId;
      delete req.session.recoveryExpires;
      delete req.session.passwordRecovery;
      return req.session.save(() => sendLogoutHtml());
    }

    const cookieClearOpts = {
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    };

    req.session.destroy((err) => {
      if (err) console.error("Session destroy error on logout:", err);
      res.clearCookie("connect.sid", cookieClearOpts);
      res.clearCookie("ps_csrf", cookieClearOpts);
      res.clearCookie("ps_csrf_uid", cookieClearOpts);
      sendLogoutHtml();
    });
  } else {
    sendLogoutHtml();
  }
};

exports.showForgotPassword = (req, res) => {
  res.render("forgot-password", {
    error: null
  });
};

exports.checkForgotPassword = async (req, res) => {
  const username = (req.body.username || "").trim().toLowerCase();

  const admin = await AdminUser.scope("withSecrets").findOne({
    where: { username, is_active: true }
  });

  if (!admin || !admin.google_sub) {
    const superAdmin = await AdminUser.findOne({
      where: {
        role: "super_admin",
        is_active: true
      }
    });

    return res.render("forgot-password-contact", {
      superAdmin
    });
  }

  req.session.recoveryAdminId = admin.id;
  req.session.recoveryExpires = Date.now() + 10 * 60 * 1000;

  req.session.save(() => {
    res.redirect("/forgot-password/google");
  });
};

exports.showGoogleRecovery = async (req, res) => {
  const recoveryAdminId = req.session?.recoveryAdminId;
  const expires = req.session?.recoveryExpires;

  if (!recoveryAdminId || !expires || Date.now() > expires) {
    return res.redirect("/forgot-password");
  }

  const admin = await AdminUser.findByPk(recoveryAdminId);
  if (!admin || !admin.is_active) {
    return res.redirect("/forgot-password");
  }

  res.render("forgot-password-google", {
    admin,
    googleClientId: process.env.GOOGLE_CLIENT_ID
  });
};

exports.googleRecovery = async (req, res) => {
  try {
    const recoveryAdminId = req.session?.recoveryAdminId;
    const expires = req.session?.recoveryExpires;

    if (!recoveryAdminId || !expires || Date.now() > expires) {
      return res.status(401).json({
        success: false,
        error: "Recovery session expired. Please start over."
      });
    }

    const { credential } = req.body;
    const payload = await verifyGoogleCredential(credential);

    const admin = await AdminUser.scope("withSecrets").findByPk(recoveryAdminId);
    if (!admin || !admin.is_active) {
      return res.status(403).json({
        success: false,
        error: "Account recovery not available."
      });
    }

    if (!admin.google_sub || payload.sub !== admin.google_sub) {
      return res.status(403).json({
        success: false,
        error: "Incorrect Google account."
      });
    }

    req.session.passwordRecovery = {
      adminId: admin.id,
      expires: Date.now() + 5 * 60 * 1000
    };

    req.session.save(() => {
      res.json({
        success: true,
        redirect: "/forgot-password/reset"
      });
    });
  } catch (error) {
    console.error("Google recovery failed:", error);
    res.status(401).json({
      success: false,
      error: "Google verification failed."
    });
  }
};

exports.showPasswordReset = (req, res) => {
  const recovery = req.session.passwordRecovery;
  if (!recovery || recovery.expires < Date.now()) {
    return res.redirect("/forgot-password");
  }

  res.render("forgot-password-reset", {
    error: null
  });
};

exports.resetForgotPassword = async (req, res) => {
  const recovery = req.session.passwordRecovery;
  if (!recovery || recovery.expires < Date.now()) {
    return res.redirect("/forgot-password");
  }

  const { password, confirmPassword } = req.body;
  if (password !== confirmPassword) {
    return res.render("forgot-password-reset", {
      error: "Passwords do not match."
    });
  }

  const admin = await AdminUser.findByPk(recovery.adminId);
  if (!admin || !admin.is_active) {
    return res.redirect("/forgot-password");
  }

  const policyCheck = validatePasswordPolicy(password, admin.username);
  if (!policyCheck.isValid) {
    return res.render("forgot-password-reset", {
      error: policyCheck.message
    });
  }

  admin.password_hash = await bcrypt.hash(password, 12);
  await admin.save();

  await destroyAdminSessions(admin.id);
  invalidateAdminCache(admin.id);

  delete req.session.passwordRecovery;
  delete req.session.recoveryAdminId;
  delete req.session.recoveryExpires;

  req.session.save(() => {
    res.redirect("/admin-login");
  });
};
