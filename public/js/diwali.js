/**
 * DIWALI BHAJANS MODULE - FRONTEND LOGIC
 */

// ============================================================
// SCALE & GENDER CALCULATION HELPERS
// ============================================================
function femaleFallbackShruti(maleShruti) {
  const match = String(maleShruti || "")
    .trim()
    .match(/^(1|1\.5|2|2\.5|3|4|4\.5|5|5\.5|6|6\.5|7)\s*([pPmM])?$/i);
  if (!match) return maleShruti || "";
  const values = ["1", "1.5", "2", "2.5", "3", "4", "4.5", "5", "5.5", "6", "6.5", "7"];
  let pitch = values.indexOf(match[1]);
  if (pitch === -1) return maleShruti || "";
  const suffix = (match[2] || "").toUpperCase();
  if (suffix === "M") pitch = (pitch + 5) % 12;
  const femalePitch = (pitch - 5 + 12) % 12;
  return `${values[femalePitch]}P`;
}

function getScaleForGender(bhajan, gender) {
  if (!bhajan) return "";
  const isFemale = gender === "Ladies" || gender === "Female";
  const rawFemale = String(bhajan.shruti_female || "").trim();
  const rawMale = String(bhajan.shruti || "").trim();
  const cleanFemale = rawFemale === "#N/A" || !rawFemale ? "" : rawFemale;
  const cleanMale = rawMale === "#N/A" || !rawMale ? "" : rawMale;

  if (isFemale) {
    if (cleanFemale) return cleanFemale;
    if (cleanMale) return femaleFallbackShruti(cleanMale);
    return "";
  }
  return cleanMale;
}

function getCurrentGender(scopeElement) {
  // Check modal first if inside modal
  const modalGender = document.getElementById("editGender");
  if (modalGender && scopeElement && scopeElement.closest("#modalEditParticipant")) {
    return modalGender.value || "Gents";
  }
  // Check entry form radio
  const radio = document.querySelector('input[name="gender"]:checked');
  if (radio) return radio.value;
  return "Gents";
}

function initDiwaliModule() {
  initTabs();
  initTableFilters();
  initAutocomplete();
  initBhajanRepeater();
  initModals();
  initGenderChangeListeners();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initDiwaliModule);
} else {
  initDiwaliModule();
}

// ============================================================
// 1. TABS MANAGEMENT
// ============================================================
function initTabs() {
  const tabs = document.querySelectorAll(".diwali-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      const target = tab.dataset.tab;
      document.querySelectorAll(".diwali-tab-content").forEach((c) => {
        c.style.display = c.id === `tab-${target}` ? "block" : "none";
      });
    });
  });
}

// ============================================================
// 2. CLIENT-SIDE TABLE FILTERING & SEARCH
// ============================================================
function initTableFilters() {
  const searchInput = document.getElementById("diwaliTableSearch");
  const deityFilter = document.getElementById("diwaliDeityFilter");
  const scaleFilter = document.getElementById("diwaliScaleFilter");

  if (!searchInput && !deityFilter && !scaleFilter) return;

  function applyFilters() {
    const q = (searchInput?.value || "").toLowerCase().trim();
    const selectedDeity = (deityFilter?.value || "").toLowerCase().trim();
    const selectedScale = (scaleFilter?.value || "").toLowerCase().trim();

    const activeTable =
      document.querySelector(".diwali-tab-content[style*='block'] .diwali-table tbody") ||
      document.querySelector(".diwali-table tbody");

    if (!activeTable) return;

    const rows = activeTable.querySelectorAll("tr");
    rows.forEach((row) => {
      const text = row.textContent.toLowerCase();
      const deityAttr = (row.dataset.deity || "").toLowerCase();
      const scaleAttr = (row.dataset.scale || "").toLowerCase();

      const matchSearch = !q || text.includes(q);
      const matchDeity = !selectedDeity || deityAttr === selectedDeity;
      const matchScale = !selectedScale || scaleAttr === selectedScale;

      row.style.display = matchSearch && matchDeity && matchScale ? "" : "none";
    });
  }

  if (searchInput) searchInput.addEventListener("input", applyFilters);
  if (deityFilter) deityFilter.addEventListener("change", applyFilters);
  if (scaleFilter) scaleFilter.addEventListener("change", applyFilters);
}

// ============================================================
// 3. MASTER BHAJAN BANK AUTOCOMPLETE WITH GENDER SCALE
// ============================================================
function initAutocomplete(scopeElement = document) {
  const inputs = scopeElement.querySelectorAll(".bhajan-autocomplete-input");
  inputs.forEach((input) => {
    if (input.dataset.autocompleteInitialized) return;
    input.dataset.autocompleteInitialized = "true";

    const container = input.closest(".autocomplete-container");
    const dropdown = container ? container.querySelector(".autocomplete-dropdown") : null;
    if (!dropdown) return;

    let debounceTimer = null;

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const card = input.closest(".bhajan-item-card") || input.closest(".modal-bhajan-item");
      if (card) {
        const masterIdInput = card.querySelector(".bhajan-master-id, .edit-master-id");
        if (masterIdInput) masterIdInput.value = "";
        card._selectedMasterBhajan = null;
      }

      const q = input.value.trim();
      if (q.length < 2) {
        dropdown.style.display = "none";
        dropdown.innerHTML = "";
        return;
      }

      debounceTimer = setTimeout(async () => {
        try {
          const currentGender = getCurrentGender(input);
          const res = await fetch(
            `/admin/diwali/api/search-master?q=${encodeURIComponent(q)}&gender=${encodeURIComponent(currentGender)}`
          );
          const data = await res.json();
          renderSuggestions(data, input, dropdown, currentGender);
        } catch (err) {
          console.error("Autocomplete search error:", err);
        }
      }, 200);
    });

    // Auto-fetch on change/blur if user typed exact title
    input.addEventListener("change", async () => {
      const title = input.value.trim();
      const card = input.closest(".bhajan-item-card") || input.closest(".modal-bhajan-item");
      if (!card || !title) return;
      if (
        card._selectedMasterBhajan &&
        card._selectedMasterBhajan.title.toLowerCase() === title.toLowerCase()
      ) {
        return;
      }

      try {
        const currentGender = getCurrentGender(input);
        const res = await fetch(
          `/admin/diwali/api/search-master?q=${encodeURIComponent(title)}&gender=${encodeURIComponent(currentGender)}`
        );
        const data = await res.json();
        if (data && data.length > 0) {
          const exact = data.find((x) => x.title.toLowerCase() === title.toLowerCase()) || data[0];
          if (exact) {
            card._selectedMasterBhajan = exact;
            const masterIdInput = card.querySelector(".bhajan-master-id, .edit-master-id");
            const deityInput = card.querySelector(".bhajan-deity-input, .edit-bhajan-deity");
            const scaleInput = card.querySelector(".bhajan-scale-input, .edit-bhajan-scale");

            if (masterIdInput) masterIdInput.value = exact.id;
            if (deityInput && !deityInput.value) deityInput.value = exact.deity || "";

            const finalScale =
              exact.genderScale || getScaleForGender(exact, currentGender) || exact.shruti || "";
            if (scaleInput && !scaleInput.value) {
              scaleInput.value = finalScale;
              scaleInput.style.borderColor = "var(--diwali-gold)";
              setTimeout(() => {
                scaleInput.style.borderColor = "";
              }, 1500);
            }
          }
        }
      } catch (err) {
        console.error("Auto-fetch on change error:", err);
      }
    });

    // Close when clicking outside
    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });
  });
}

function renderSuggestions(bhajans, input, dropdown, currentGender) {
  if (!bhajans || bhajans.length === 0) {
    dropdown.innerHTML = `<div style="padding:10px;color:var(--text-light);font-size:13px;">No matching master bhajans found (custom title will be saved)</div>`;
    dropdown.style.display = "block";
    return;
  }

  dropdown.innerHTML = "";
  bhajans.forEach((b) => {
    const item = document.createElement("div");
    item.className = "autocomplete-item";

    const resolvedScale = b.genderScale || getScaleForGender(b, currentGender) || b.shruti || "";
    const scaleHint = resolvedScale
      ? ` &bull; Scale: <strong>${escapeHtml(resolvedScale)}</strong>`
      : "";

    item.innerHTML = `
      <div>
        <strong>${escapeHtml(b.title)}</strong>
        <div style="font-size:11.5px; color:var(--text-light); margin-top:2px;">
          ${escapeHtml(b.deity || "Bhajan")}${scaleHint}
        </div>
      </div>
      <span class="autocomplete-deity">${escapeHtml(b.deity || "")}</span>
    `;

    item.addEventListener("click", () => {
      input.value = b.title;
      dropdown.style.display = "none";

      const card = input.closest(".bhajan-item-card") || input.closest(".modal-bhajan-item");
      if (card) {
        card._selectedMasterBhajan = b; // cache for dynamic gender switching

        const masterIdInput = card.querySelector(".bhajan-master-id, .edit-master-id");
        const deityInput = card.querySelector(".bhajan-deity-input, .edit-bhajan-deity");
        const scaleInput = card.querySelector(".bhajan-scale-input, .edit-bhajan-scale");

        if (masterIdInput) masterIdInput.value = b.id;
        if (deityInput) deityInput.value = b.deity || "";

        // Auto-fetch scale based on gender, and remain completely editable
        const finalScale = b.genderScale || getScaleForGender(b, currentGender) || b.shruti || "";
        if (scaleInput) {
          scaleInput.value = finalScale;
          // Visual highlight
          scaleInput.style.borderColor = "var(--diwali-gold)";
          setTimeout(() => {
            scaleInput.style.borderColor = "";
          }, 1500);
        }
      }
    });

    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

// Re-evaluate scale when gender changes
function initGenderChangeListeners() {
  const genderRadios = document.querySelectorAll('input[name="gender"]');
  genderRadios.forEach((r) => {
    r.addEventListener("change", () => {
      const newGender = r.value;
      updateAllCardScales(newGender);
    });
  });

  const editGenderSelect = document.getElementById("editGender");
  if (editGenderSelect) {
    editGenderSelect.addEventListener("change", () => {
      const newGender = editGenderSelect.value;
      updateAllCardScales(newGender, document.getElementById("modalEditParticipant"));
    });
  }
}

function updateAllCardScales(newGender, scope = document) {
  const cards = scope.querySelectorAll(".bhajan-item-card, .modal-bhajan-item");
  cards.forEach((card) => {
    if (card._selectedMasterBhajan) {
      const newScale = getScaleForGender(card._selectedMasterBhajan, newGender);
      const scaleInput = card.querySelector(".bhajan-scale-input, .edit-bhajan-scale");
      const shrutiInput = card.querySelector(".bhajan-shruti-input, .edit-bhajan-shruti");

      if (newScale && scaleInput) {
        scaleInput.value = newScale;
        scaleInput.style.borderColor = "var(--diwali-gold)";
        setTimeout(() => {
          scaleInput.style.borderColor = "";
        }, 1500);
      }
    }
  });
}

// ============================================================
// 4. DYNAMIC BHAJAN REPEATER (FOR ENTRY FORM)
// ============================================================
function initBhajanRepeater() {
  const btnAdd = document.getElementById("btnAddAnotherBhajan");
  const container = document.getElementById("bhajanRepeaterContainer");

  if (!btnAdd || !container) return;

  btnAdd.addEventListener("click", () => {
    const currentCards = container.querySelectorAll(".bhajan-item-card");
    const newIdx = currentCards.length + 1;

    const newCard = document.createElement("div");
    newCard.className = "bhajan-item-card";
    newCard.innerHTML = `
      <div class="bhajan-card-header">
        <span class="bhajan-num-badge">Bhajan #${newIdx}</span>
        <button type="button" class="btn-remove-bhajan" onclick="removeBhajanCard(this)">✕ Remove</button>
      </div>
      <div class="bhajan-card-content">
        <div class="diwali-field-group bhajan-field-title">
          <label class="diwali-field-label">Bhajan Title <span class="req-star">*</span></label>
          <div class="autocomplete-container">
            <input type="text" name="bhajan_title" required class="diwali-input-text bhajan-autocomplete-input" placeholder="Search Master Bhajan bank or type title..." autocomplete="off">
            <input type="hidden" name="master_bhajan_id" class="bhajan-master-id" value="">
            <div class="autocomplete-dropdown"></div>
          </div>
        </div>
        <div class="bhajan-meta-grid">
          <div class="diwali-field-group">
            <label class="diwali-field-label">Deity</label>
            <input type="text" name="deity" class="diwali-input-text bhajan-deity-input" placeholder="e.g. Ganesha, Krishna, Shiva...">
          </div>
          <div class="diwali-field-group">
            <label class="diwali-field-label">Scale <span class="field-hint-tag">Auto-filled</span></label>
            <input type="text" name="scale" class="diwali-input-text bhajan-scale-input" placeholder="e.g. C#">
          </div>
          <div class="diwali-field-group">
            <label class="diwali-field-label">Tabla Shruti</label>
            <input type="text" name="tabla" class="diwali-input-text bhajan-tabla-input" placeholder="e.g. 1.5, 2...">
          </div>
        </div>
        <div class="diwali-field-group bhajan-field-remarks">
          <label class="diwali-field-label">Bhajan Remarks</label>
          <input type="text" name="bhajan_remarks" class="diwali-input-text" placeholder="Audition comments or notes...">
        </div>
      </div>
    `;

    container.appendChild(newCard);
    initAutocomplete(newCard);
    updateCardNumbers();
  });
}

function removeBhajanCard(btn) {
  const container = document.getElementById("bhajanRepeaterContainer");
  if (!container) return;
  const cards = container.querySelectorAll(".bhajan-item-card");
  if (cards.length <= 1) {
    alert("At least one bhajan is required for each participant.");
    return;
  }
  btn.closest(".bhajan-item-card").remove();
  updateCardNumbers();
}

function updateCardNumbers() {
  const container = document.getElementById("bhajanRepeaterContainer");
  if (!container) return;
  const cards = container.querySelectorAll(".bhajan-item-card");
  cards.forEach((card, idx) => {
    const badge = card.querySelector(".bhajan-num-badge");
    if (badge) badge.textContent = `Bhajan #${idx + 1}`;
  });
}

// ============================================================
// 5. SAFE MODAL CONTROLS (NO CONFLICTS WITH OTHER SCRIPTS)
// ============================================================
function diwaliOpenModal(modalId) {
  const m = document.getElementById(modalId);
  if (m) m.style.display = "flex";
}

function diwaliCloseModal(modalId) {
  if (modalId) {
    const m = document.getElementById(modalId);
    if (m) {
      m.style.display = "none";
      return;
    }
  }
  // If no specific modal given, close all diwali modals
  document.querySelectorAll(".diwali-modal-overlay").forEach((overlay) => {
    overlay.style.display = "none";
  });
}

function initModals() {
  // Close modals on clicking backdrop
  document.querySelectorAll(".diwali-modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        overlay.style.display = "none";
      }
    });
  });
}

// Year switch
function onDiwaliYearChange(select) {
  const yr = select.value;
  if (yr) {
    window.location.href = `/admin/diwali?year=${yr}`;
  }
}

// Export Yearly Data modal action
function triggerYearlyExport() {
  const format = document.querySelector("input[name='exportFormat']:checked")?.value || "excel";
  const category = document.querySelector("input[name='exportCategory']:checked")?.value || "Both";

  diwaliCloseModal("modalExportYearly");

  if (format === "both") {
    window.location.href = `/admin/diwali/export/yearly?format=excel&category=${category}`;
    setTimeout(() => {
      window.location.href = `/admin/diwali/export/yearly?format=pdf&category=${category}`;
    }, 1500);
  } else {
    window.location.href = `/admin/diwali/export/yearly?format=${format}&category=${category}`;
  }
}

// Make Sequence modal action
async function triggerGenerateSequences() {
  const numInput = document.getElementById("numSequencesInput");
  const numSequences = parseInt(numInput?.value || "4", 10);
  if (isNaN(numSequences) || numSequences < 2) {
    alert("Please enter a valid number of sequences (at least 2).");
    return;
  }

  const includeGents = document.getElementById("chkCategoryGents")?.checked;
  const includeLadies = document.getElementById("chkCategoryLadies")?.checked;

  const categories = [];
  if (includeGents) categories.push("Gents");
  if (includeLadies) categories.push("Ladies");

  if (categories.length === 0) {
    alert("Please select at least one category (Gents or Ladies).");
    return;
  }

  const btn = document.getElementById("btnConfirmGenerate");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Generating Fair Sequences...";
  }

  try {
    const res = await fetch("/admin/diwali/sequence/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numSequences, categories })
    });

    const data = await res.json();
    if (!data.success) {
      alert("Error generating sequences: " + data.error);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Generate Sequences";
      }
      return;
    }

    diwaliCloseModal("modalMakeSequence");
    showFairnessSummary(data.fairnessSummary);
  } catch (err) {
    alert("Network error: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Generate Sequences";
    }
  }
}

function showFairnessSummary(summary) {
  const content = document.getElementById("fairnessSummaryContent");
  if (!content) {
    window.location.href = "/admin/diwali/sequence/editor";
    return;
  }

  let seqRowsHtml = "";
  (summary.sequences || []).forEach((s) => {
    seqRowsHtml += `
      <tr>
        <td><strong>Sequence ${s.sequenceNumber}</strong></td>
        <td>${s.gentsCount}</td>
        <td>${s.ladiesCount}</td>
        <td><strong>${s.totalCount}</strong></td>
      </tr>
    `;
  });

  content.innerHTML = `
    <div style="background:var(--diwali-gold-light); padding:16px; border-radius:10px; margin-bottom:16px;">
      <h4 style="margin:0 0 10px 0; color:var(--diwali-maroon);">Fair Distribution Verified</h4>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:13.5px;">
        <div>Total Bhajans Assigned: <strong>${summary.totalBhajans}</strong></div>
        <div>Total Pairs / Participants: <strong>${summary.totalPairs}</strong></div>
        <div>Pairs with Multiple Bhajans: <strong>${summary.multiBhajanPairs}</strong></div>
        <div>Successfully Spread Across Sequences: <strong style="color:var(--success, #4f7a5b);">${summary.successfullySpread}</strong></div>
      </div>
      ${summary.unavoidableConcentration > 0 ? `<p style="margin:8px 0 0 0; font-size:12px; color:var(--text-light);">Unavoidable concentrations (pairs with more bhajans than total sequences): ${summary.unavoidableConcentration}</p>` : ""}
    </div>

    <table class="diwali-table" style="font-size:13px; margin-bottom:16px;">
      <thead>
        <tr>
          <th>Sequence</th>
          <th>Gents</th>
          <th>Ladies</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${seqRowsHtml}
      </tbody>
    </table>
  `;

  diwaliOpenModal("modalFairnessSummary");
}

// Export Sequence modal action
function triggerSequenceExport() {
  const format = document.querySelector("input[name='seqExportFormat']:checked")?.value || "excel";
  const category =
    document.querySelector("input[name='seqExportCategory']:checked")?.value || "Both";

  diwaliCloseModal("modalExportSequence");

  const url = `/admin/diwali/export/sequence?format=${format}&category=${category}`;
  window.location.href = url;
}

// Edit Participant Modal
async function openEditParticipantModal(participantId) {
  try {
    const res = await fetch(`/admin/diwali/participant/${participantId}`);
    const data = await res.json();
    if (!data.success) {
      alert("Failed to load participant: " + data.error);
      return;
    }

    const p = data.participant;
    document.getElementById("editParticipantId").value = p.id;
    document.getElementById("editLeadName").value = p.lead_name;
    document.getElementById("editPartnerName").value = p.partner_name;
    document.getElementById("editGender").value = p.gender;
    document.getElementById("editRemarks").value = p.remarks || "";

    const bhajansContainer = document.getElementById("editBhajansContainer");
    bhajansContainer.innerHTML = "";

    (p.bhajans || []).forEach((b, idx) => {
      const row = renderEditBhajanCard(b, idx);
      bhajansContainer.appendChild(row);
      initAutocomplete(row);
    });

    diwaliOpenModal("modalEditParticipant");
  } catch (err) {
    alert("Error loading participant: " + err.message);
  }
}

function renderEditBhajanCard(b = {}, idx = 0) {
  const row = document.createElement("div");
  row.className = "bhajan-item-card modal-bhajan-item";
  row.style.marginBottom = "14px";
  row.innerHTML = `
    <div class="bhajan-card-header">
      <span class="bhajan-num-badge">Bhajan #${idx + 1}</span>
      <button type="button" class="btn-remove-bhajan" onclick="removeEditModalBhajan(this)">✕ Remove</button>
    </div>
    <div class="bhajan-card-content">
      <div class="diwali-field-group bhajan-field-title">
        <label class="diwali-field-label">Bhajan Title <span class="req-star">*</span></label>
        <div class="autocomplete-container">
          <input type="text" class="diwali-input-text bhajan-autocomplete-input edit-bhajan-title" value="${escapeHtml(b.bhajan_title || "")}" placeholder="Search Master Bhajan bank or type title..." required autocomplete="off">
          <input type="hidden" class="bhajan-master-id edit-master-id" value="${b.master_bhajan_id || ""}">
          <input type="hidden" class="edit-bhajan-id" value="${b.id || ""}">
          <div class="autocomplete-dropdown"></div>
        </div>
      </div>
      <div class="bhajan-meta-grid">
        <div class="diwali-field-group">
          <label class="diwali-field-label">Deity</label>
          <input type="text" class="diwali-input-text bhajan-deity-input edit-bhajan-deity" value="${escapeHtml(b.deity || "")}" placeholder="e.g. Ganesha, Krishna...">
        </div>
        <div class="diwali-field-group">
          <label class="diwali-field-label">Scale <span class="field-hint-tag">Auto-filled</span></label>
          <input type="text" class="diwali-input-text bhajan-scale-input edit-bhajan-scale" value="${escapeHtml(b.scale || "")}" placeholder="e.g. C#">
        </div>
        <div class="diwali-field-group">
          <label class="diwali-field-label">Tabla Shruti</label>
          <input type="text" class="diwali-input-text bhajan-tabla-input edit-bhajan-tabla" value="${escapeHtml(b.tabla || "")}" placeholder="e.g. 1.5, 2...">
        </div>
      </div>
      <div class="diwali-field-group bhajan-field-remarks">
        <label class="diwali-field-label">Remarks</label>
        <input type="text" class="diwali-input-text edit-bhajan-remarks" value="${escapeHtml(b.remarks || "")}" placeholder="Audition comments or notes...">
      </div>
    </div>
  `;
  return row;
}

function removeEditModalBhajan(btn) {
  const container = document.getElementById("editBhajansContainer");
  const items = container.querySelectorAll(".modal-bhajan-item");
  if (items.length <= 1) {
    alert("At least one bhajan is required for each participant.");
    return;
  }
  btn.closest(".modal-bhajan-item").remove();
  updateEditModalBhajanNumbers();
}

function updateEditModalBhajanNumbers() {
  const container = document.getElementById("editBhajansContainer");
  if (!container) return;
  const items = container.querySelectorAll(".modal-bhajan-item");
  items.forEach((item, idx) => {
    const badge = item.querySelector(".bhajan-num-badge");
    if (badge) badge.textContent = `Bhajan #${idx + 1}`;
  });
}

function addBhajanToEditModal() {
  const container = document.getElementById("editBhajansContainer");
  if (!container) return;
  const items = container.querySelectorAll(".modal-bhajan-item");
  const card = renderEditBhajanCard({}, items.length);
  container.appendChild(card);
  initAutocomplete(card);
}

async function saveParticipantEdits() {
  const id = document.getElementById("editParticipantId").value;
  const lead_name = document.getElementById("editLeadName").value.trim();
  const partner_name = document.getElementById("editPartnerName").value.trim();
  const gender = document.getElementById("editGender").value;
  const remarks = document.getElementById("editRemarks").value.trim();

  if (!lead_name || !partner_name) {
    alert("Both Lead Singer Name and Partner Name are mandatory.");
    return;
  }

  const bhajanCards = document.querySelectorAll("#editBhajansContainer .modal-bhajan-item");
  const bhajans = [];
  bhajanCards.forEach((c) => {
    const title = c.querySelector(".edit-bhajan-title")?.value.trim();
    const bhajanId = c.querySelector(".edit-bhajan-id")?.value;
    const masterIdVal = c.querySelector(".edit-master-id")?.value;
    if (title) {
      bhajans.push({
        id: bhajanId ? parseInt(bhajanId, 10) : null,
        bhajan_title: title,
        master_bhajan_id: (masterIdVal && masterIdVal !== "null" && masterIdVal !== "undefined") ? parseInt(masterIdVal, 10) : null,
        scale: c.querySelector(".edit-bhajan-scale")?.value.trim() || "",
        tabla: c.querySelector(".edit-bhajan-tabla")?.value.trim() || "",
        deity: c.querySelector(".edit-bhajan-deity")?.value.trim() || "",
        remarks: c.querySelector(".edit-bhajan-remarks")?.value.trim() || ""
      });
    }
  });

  if (bhajans.length === 0) {
    alert("Please provide at least one valid bhajan.");
    return;
  }

  try {
    const res = await fetch(`/admin/diwali/participant/update/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lead_name, partner_name, gender, remarks, bhajans })
    });
    const data = await res.json();
    if (!data.success) {
      alert("Error updating participant: " + data.error);
      return;
    }
    window.location.reload();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Window globals (namespaced + safe fallbacks)
window.diwaliOpenModal = diwaliOpenModal;
window.diwaliCloseModal = diwaliCloseModal;
window.openModal = diwaliOpenModal;
window.closeModal = diwaliCloseModal;
window.onDiwaliYearChange = onDiwaliYearChange;
window.triggerYearlyExport = triggerYearlyExport;
window.triggerGenerateSequences = triggerGenerateSequences;
window.triggerSequenceExport = triggerSequenceExport;
window.openEditParticipantModal = openEditParticipantModal;
window.saveParticipantEdits = saveParticipantEdits;
window.removeBhajanCard = removeBhajanCard;
