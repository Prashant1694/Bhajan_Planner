const express = require("express");
const router = express.Router();

const plannerController = require("../controllers/plannerController");
const { bhajanSubmitLimit } = require("../middleware/security");
const { requireApiLogin } = require("../middleware/auth");

router.get("/submit-form", plannerController.showSubmitForm);
router.get("/session-link", plannerController.sessionLink);
router.post("/submit-form", bhajanSubmitLimit, plannerController.submitForm);
// Public Live Program Plan & WhatsApp Share View
router.get("/plan-view", plannerController.planView);
router.post("/submit", requireApiLogin, plannerController.submitApi);
router.get("/plan/:session_date", plannerController.getPlan);

module.exports = router;
