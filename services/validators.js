/**
 * Whitelist-based request validation schemas
 * Rejects unexpected keys and validates field formats
 */

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks whether a YYYY-MM-DD string represents an actual calendar date.
 */
function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== "string" || !DATE_REGEX.test(dateStr.trim())) return false;
  const [y, m, d] = dateStr.trim().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function validateKeys(body, allowedKeys) {
  const allowedSet = new Set(allowedKeys);
  const unexpected = Object.keys(body).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    return `Unexpected fields not allowed: ${unexpected.join(", ")}`;
  }
  return null;
}

/**
 * Validates bhajan submission payload
 */
function validateSubmitForm(body) {
  const allowedKeys = [
    "title",
    "bhajan_name",
    "singer_name",
    "partner_name",
    "deity",
    "scale",
    "custom_scale",
    "raag",
    "raga",
    "tempo",
    "speed",
    "session_date",
    "remarks",
    "lead_singer_id",
    "partner_singer_id",
    "master_id",
    "sheet_filename",
    "_csrf"
  ];

  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  const title = (body.title || body.bhajan_name || "").toString().trim();
  if (!title) {
    errors.push("Bhajan title is required.");
  } else if (title.length > 200) {
    errors.push("Bhajan title must not exceed 200 characters.");
  }

  const singerName = (body.singer_name || "").toString().trim();
  if (!singerName) {
    errors.push("Singer name is required.");
  } else if (singerName.length > 100) {
    errors.push("Singer name must not exceed 100 characters.");
  }

  const deity = (body.deity || "").toString().trim();
  if (!deity) {
    errors.push("Deity selection is required.");
  } else if (deity.length > 100) {
    errors.push("Deity name must not exceed 100 characters.");
  }

  const sessionDate = (body.session_date || "").toString().trim();
  if (!sessionDate || !DATE_REGEX.test(sessionDate)) {
    errors.push("Valid session date (YYYY-MM-DD) is required.");
  }

  const partnerName = (body.partner_name || "").toString().trim();
  if (partnerName && partnerName.length > 100) {
    errors.push("Partner singer name must not exceed 100 characters.");
  }

  const scale = (body.scale || body.custom_scale || "").toString().trim();
  if (scale && scale.length > 30) {
    errors.push("Scale pitch must not exceed 30 characters.");
  }

  const remarks = (body.remarks || "").toString().trim();
  if (remarks && remarks.length > 500) {
    errors.push("Remarks must not exceed 500 characters.");
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      title,
      singer_name: singerName,
      partner_name: partnerName || null,
      deity,
      session_date: sessionDate,
      scale: scale || null,
      raag: (body.raag || body.raga || "").toString().trim() || null,
      tempo: (body.tempo || body.speed || "").toString().trim() || null,
      remarks: remarks || null,
      lead_singer_id: body.lead_singer_id ? parseInt(body.lead_singer_id, 10) : null,
      partner_singer_id: body.partner_singer_id ? parseInt(body.partner_singer_id, 10) : null,
      master_id: body.master_id ? parseInt(body.master_id, 10) : null,
      sheet_filename: body.sheet_filename ? body.sheet_filename.toString().trim() : null
    }
  };
}

/**
 * Validates session copying payload
 */
function validateCopySession(body) {
  const allowedKeys = ["source_date", "target_date", "_csrf"];
  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  const sourceDate = (body.source_date || "").toString().trim();
  const targetDate = (body.target_date || "").toString().trim();

  if (!sourceDate || !DATE_REGEX.test(sourceDate)) {
    errors.push("Valid source session date (YYYY-MM-DD) is required.");
  }
  if (!targetDate || !DATE_REGEX.test(targetDate)) {
    errors.push("Valid target session date (YYYY-MM-DD) is required.");
  }
  if (sourceDate && targetDate && sourceDate === targetDate) {
    errors.push("Target date must be different from source date.");
  }

  return {
    valid: errors.length === 0,
    errors,
    data: { source_date: sourceDate, target_date: targetDate }
  };
}

/**
 * Validates session permission update
 */
function validateUpdatePermission(body) {
  const allowedKeys = ["date", "type", "description", "_csrf"];
  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  const date = (body.date || "").toString().trim();
  if (!date || !DATE_REGEX.test(date)) {
    errors.push("Valid session date (YYYY-MM-DD) is required.");
  }

  const validTypes = ["open", "restricted", "closed", "clear", "special", "festival"];
  const type = (body.type || "").toString().trim().toLowerCase();
  if (!validTypes.includes(type)) {
    errors.push(`Permission type must be one of: ${validTypes.join(", ")}.`);
  }

  const description = (body.description || "").toString().trim();
  if (description.length > 255) {
    errors.push("Description must not exceed 255 characters.");
  }

  return {
    valid: errors.length === 0,
    errors,
    data: { date, type, description: description || null }
  };
}

/**
 * Validates bhajan reorder payload
 */
function validateReorder(body) {
  const allowedKeys = ["orderData", "_csrf"];
  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  if (!Array.isArray(body.orderData) || body.orderData.length === 0) {
    errors.push("orderData must be a non-empty array of bhajan orders.");
    return { valid: false, errors, data: null };
  }

  const sanitized = [];
  for (let i = 0; i < body.orderData.length; i++) {
    const item = body.orderData[i];
    if (!item || typeof item !== "object") {
      errors.push(`Item at index ${i} is not a valid object.`);
      continue;
    }
    const id = parseInt(item.id, 10);
    const order = parseInt(item.order, 10);
    if (isNaN(id) || id <= 0) {
      errors.push(`Item at index ${i} has an invalid id.`);
    }
    if (isNaN(order) || order < 0) {
      errors.push(`Item at index ${i} has an invalid order index.`);
    }
    sanitized.push({ id, order });
  }

  return {
    valid: errors.length === 0,
    errors,
    data: sanitized
  };
}

/**
 * Validates session lock toggle
 */
function validateToggleLock(body) {
  const allowedKeys = ["date", "is_locked", "_csrf"];
  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  const date = (body.date || "").toString().trim();
  if (!date || !DATE_REGEX.test(date)) {
    errors.push("Valid session date (YYYY-MM-DD) is required.");
  }

  const isLocked =
    body.is_locked === true ||
    body.is_locked === "true" ||
    body.is_locked === 1 ||
    body.is_locked === "1";

  return {
    valid: errors.length === 0,
    errors,
    data: { date, is_locked: isLocked }
  };
}

/**
 * Validates admin bhajan submission edits.
 */
function validateAdminSubmissionEdit(body) {
  const allowedKeys = [
    "session_date",
    "singer_name",
    "partner_name",
    "title",
    "deity",
    "scale",
    "speed",
    "raga",
    "_csrf"
  ];
  const unexpectedErr = validateKeys(body, allowedKeys);
  const errors = [];
  if (unexpectedErr) errors.push(unexpectedErr);

  const sessionDate = (body.session_date || "").toString().trim();
  if (!isValidCalendarDate(sessionDate)) {
    errors.push("Valid session date (YYYY-MM-DD) is required.");
  }

  const singerName = (body.singer_name || "").toString().trim();
  if (!singerName) {
    errors.push("Lead singer name is required.");
  } else if (singerName.length > 100) {
    errors.push("Lead singer name must not exceed 100 characters.");
  }

  const partnerName = (body.partner_name || "").toString().trim();
  if (partnerName.length > 100) {
    errors.push("Partner singer name must not exceed 100 characters.");
  }

  const title = (body.title || "").toString().trim();
  if (!title) {
    errors.push("Bhajan title is required.");
  } else if (title.length > 200) {
    errors.push("Bhajan title must not exceed 200 characters.");
  }

  const deity = (body.deity || "").toString().trim();
  if (!deity) {
    errors.push("Deity is required.");
  } else if (deity.length > 100) {
    errors.push("Deity must not exceed 100 characters.");
  }

  const scale = (body.scale || "").toString().trim();
  if (scale.length > 30) {
    errors.push("Pitch / scale must not exceed 30 characters.");
  }

  const speed = (body.speed || "").toString().trim().toLowerCase();
  const validSpeeds = ["slow", "medium slow", "medium", "medium fast", "fast"];
  if (!validSpeeds.includes(speed)) {
    errors.push(`Speed must be one of: ${validSpeeds.join(", ")}.`);
  }

  const raga = (body.raga || "").toString().trim();
  if (raga.length > 100) {
    errors.push("Raag must not exceed 100 characters.");
  }

  return {
    valid: errors.length === 0,
    errors,
    data: {
      session_date: sessionDate,
      singer_name: singerName,
      partner_name: partnerName || null,
      title,
      deity,
      scale: scale || null,
      speed,
      raga: raga || null
    }
  };
}

module.exports = {
  isValidCalendarDate,
  validateSubmitForm,
  validateCopySession,
  validateUpdatePermission,
  validateReorder,
  validateToggleLock,
  validateAdminSubmissionEdit
};
