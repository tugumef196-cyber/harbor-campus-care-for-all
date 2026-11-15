import { createClient } from "@supabase/supabase-js";

const views = [...document.querySelectorAll(".view")];
const navButtons = [...document.querySelectorAll("[data-view]")];
const navMenu = document.querySelector(".main-nav");
const menuButton = document.querySelector(".mobile-menu-button");
const roleViews = {
  staff: ["staff", "admin"],
  patterns: ["reviewer", "admin"],
  admin: ["admin"],
};

let supabase = null;
let currentUser = null;
let currentProfile = null;
let selectedCaseId = null;
let caseReports = [];
let staffDirectory = [];
let suppressSignupSessionId = null;

function showAppError(message) {
  const alert = document.querySelector("#storage-alert");
  alert.textContent = message;
  alert.hidden = false;
}

function clearAppError() {
  const alert = document.querySelector("#storage-alert");
  alert.textContent = "";
  alert.hidden = true;
}

function setFormMessage(selector, message, visible = true) {
  const element = document.querySelector(selector);
  element.textContent = message;
  element.hidden = !visible;
}

function readableError(error, fallback) {
  const message = error?.message || "";
  if (/failed to fetch|fetch failed|networkerror|load failed/i.test(message)) {
    return "Could not reach Supabase. Check your internet connection, Supabase project URL, and allowed site URLs, then try again.";
  }
  return message || fallback;
}

function updateNavigation(viewName) {
  navButtons.forEach((button) => {
    const name = button.dataset.view;
    const allowed = name === "auth"
      ? !currentUser
      : Boolean(currentUser) && (!roleViews[name] || roleViews[name].includes(currentProfile?.role));
    button.hidden = !allowed;
    const active = name === viewName;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function showView(name, message = "") {
  if (!currentUser && name !== "auth") {
    name = "auth";
    message = "Sign in or create a reporter account to continue.";
  } else if (roleViews[name] && !roleViews[name].includes(currentProfile?.role)) {
    name = currentProfile?.role === "admin"
      ? "admin"
      : currentProfile?.role === "reviewer"
        ? "patterns"
        : currentProfile?.role === "staff"
          ? "staff"
          : "report";
    message = "Your account does not have permission to open that workspace.";
  }

  views.forEach((view) => {
    const active = view.id === `view-${name}`;
    view.classList.toggle("is-active", active);
    view.hidden = !active;
  });
  updateNavigation(name);
  navMenu.classList.remove("open");
  menuButton.setAttribute("aria-expanded", "false");
  if (message) showAppError(message);
  else clearAppError();

  if (name === "track") loadReporterHistory().catch((error) => showAppError(`Could not load your reports: ${error.message}`));
  if (name === "staff") loadCaseQueue().catch((error) => showAppError(`Could not load the case queue: ${error.message}`));
  if (name === "patterns") loadSuggestions().catch((error) => showAppError(`Could not load pattern suggestions: ${error.message}`));
  if (name === "admin") loadAdminUsers().catch((error) => showAppError(`Could not load registered accounts: ${error.message}`));
  if (name === "account") populateProfile();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function preferredDestination(role) {
  if (role === "admin") return "admin";
  if (role === "staff") return "staff";
  if (role === "reviewer") return "patterns";
  return "report";
}

function updateAccountHeader() {
  const displayName = currentProfile.display_name || currentUser.email;
  const initials = displayName
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
  const roleName = ({
    staff: "Case staff",
    reviewer: "Pattern reviewer",
    admin: "Administrator",
    reporter: "Reporter",
  })[currentProfile.role];
  document.querySelectorAll("[data-account-name]").forEach((element) => { element.textContent = displayName; });
  document.querySelectorAll("[data-account-initials]").forEach((element) => { element.textContent = initials; });
  document.querySelectorAll("[data-account-role]").forEach((element) => { element.textContent = roleName; });
}

async function setSession(session, autoNavigate = true) {
  currentUser = session?.user || null;
  currentProfile = null;
  selectedCaseId = null;
  if (!currentUser) {
    updateNavigation("auth");
    showView("auth");
    return;
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("id, display_name, role")
    .eq("id", currentUser.id)
    .single();
  if (error) {
    currentUser = null;
    showView("auth", `Could not load your account profile: ${error.message}`);
    return;
  }
  currentProfile = profile;
  updateAccountHeader();
  if (autoNavigate) showView(preferredDestination(profile.role));
}

function showAuthMode(mode) {
  document.querySelector(".auth-tabs").hidden = false;
  document.querySelector("#update-password-form").hidden = true;
  document.querySelectorAll("[data-auth-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.authPanel !== mode;
  });
  document.querySelectorAll("[data-auth-mode]").forEach((tab) => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  setFormMessage("#sign-in-error", "", false);
  setFormMessage("#register-error", "", false);
  setFormMessage("#auth-feedback", "", false);
}

function showPasswordRecovery() {
  document.querySelector(".auth-tabs").hidden = true;
  document.querySelectorAll("[data-auth-panel]").forEach((panel) => { panel.hidden = true; });
  document.querySelector("#update-password-form").hidden = false;
  showView("auth");
}

function formatDate(value, options = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat(undefined, options).format(new Date(value));
}

function statusClass(status) {
  return ({
    "Received": "status-new",
    "In review": "status-in-progress",
    "Follow-up": "status-follow-up",
    "Closed": "status-closed",
  })[status] || "status-new";
}

function displayStatus(status) {
  return status.replaceAll("-", " ");
}

function displayReference(reference) {
  return reference.replaceAll("-", "");
}

function displayNote(note) {
  return note.replaceAll("Follow-up", "Follow up");
}

function appendStatus(container, status) {
  const pill = document.createElement("span");
  pill.className = `status-pill ${statusClass(status)}`;
  const dot = document.createElement("span");
  const label = document.createElement("span");
  label.textContent = displayStatus(status);
  pill.append(dot, label);
  container.append(pill);
}

function updateTimeline(container, updates) {
  container.replaceChildren();
  updates.forEach((update, index) => {
    const item = document.createElement("div");
    item.className = `timeline-item ${index === 0 ? "current" : "complete"}`;
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.textContent = index === 0 ? "" : "✓";
    const details = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = update.kind === "status"
      ? `Status · ${displayStatus(update.status)}`
      : update.kind === "assignment"
        ? "Assignment"
        : "Case update";
    const note = document.createElement("small");
    note.textContent = `${formatDate(update.created_at)} · ${displayNote(update.note)}`;
    details.append(title, note);
    item.append(marker, details);
    container.append(item);
  });
}

function resetReportForm() {
  const form = document.querySelector("#report-form");
  form.reset();
  form.hidden = false;
  document.querySelector("#receipt-card").hidden = true;
  document.querySelector(".contact-fields").hidden = true;
  document.querySelectorAll(".choice-card").forEach((card, index) => {
    card.classList.toggle("selected", index === 0);
  });
  setFormMessage("#form-error", "", false);
}

function updateReview() {
  const contactPreference = document.querySelector('input[name="identity"]:checked').value;
  document.querySelector("#review-identity").textContent = contactPreference === "private"
    ? "No additional contact details shared; report remains linked to your account"
    : "You may provide an additional safe contact method";
  document.querySelector("#review-description").textContent =
    document.querySelector("#incident-description").value.trim() || "No description added.";
}

async function submitReport(form) {
  const confirmation = document.querySelector("#report-confirm");
  if (!confirmation.checked) {
    setFormMessage("#form-error", "Please confirm you understand how this report is stored and who can review it.");
    confirmation.focus();
    return;
  }

  const fields = new FormData(form);
  const contactPreference = fields.get("identity");
  const report = {
    reporter_id: currentUser.id,
    contact_preference: contactPreference,
    reporter_name: contactPreference === "contact" ? String(fields.get("reporterName") || "").trim() || null : null,
    reporter_contact: contactPreference === "contact" ? String(fields.get("reporterContact") || "").trim() || null : null,
    description: String(fields.get("description") || "").trim(),
    incident_date: String(fields.get("incidentDate") || "") || null,
    location: String(fields.get("incidentPlace") || "").trim() || null,
    desired_support: String(fields.get("desiredSupport") || "").trim() || null,
  };
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  setFormMessage("#form-error", "", false);

  let result;
  try {
    result = await supabase
      .from("reports")
      .insert(report)
      .select("id, reference")
      .single();
  } catch (error) {
    setFormMessage("#form-error", `Your report was not saved: ${error.message}`);
    return;
  } finally {
    submitButton.disabled = false;
  }
  const { data, error } = result;
  if (error) {
    setFormMessage("#form-error", `Your report was not saved: ${error.message}`);
    return;
  }

  document.querySelector("#receipt-reference").textContent = displayReference(data.reference);
  form.hidden = true;
  document.querySelector("#receipt-card").hidden = false;
  form.reset();
}

function renderHistoryCard(report, updates) {
  const card = document.createElement("article");
  card.className = "history-card";
  const header = document.createElement("div");
  header.className = "history-card-header";
  const heading = document.createElement("div");
  const reference = document.createElement("span");
  reference.className = "case-ref";
  reference.textContent = displayReference(report.reference);
  const title = document.createElement("h3");
  title.textContent = report.desired_support || "Support request";
  const submitted = document.createElement("small");
  submitted.textContent = `Submitted ${formatDate(report.created_at)}`;
  heading.append(reference, title, submitted);
  appendStatus(header, report.status);
  header.append(heading);
  const description = document.createElement("p");
  description.className = "history-description";
  description.textContent = report.description || "No description provided.";
  const timeline = document.createElement("div");
  timeline.className = "status-timeline";
  updateTimeline(timeline, updates);
  card.append(header, description, timeline);
  return card;
}

async function loadReporterHistory() {
  const container = document.querySelector("#report-history");
  container.replaceChildren();
  const { data: reports, error } = await supabase
    .from("reports")
    .select("id, reference, description, desired_support, status, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    showAppError(`Could not load your reports: ${error.message}`);
    return;
  }
  if (!reports.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "You have not submitted a report from this account.";
    container.append(empty);
    return;
  }
  const ids = reports.map((report) => report.id);
  const { data: updates, error: updatesError } = await supabase
    .from("case_updates")
    .select("id, report_id, kind, status, note, created_at")
    .in("report_id", ids)
    .order("created_at", { ascending: false });
  if (updatesError) {
    showAppError(`Your reports loaded, but updates could not be loaded: ${updatesError.message}`);
    return;
  }
  reports.forEach((report) => container.append(
    renderHistoryCard(report, updates.filter((update) => update.report_id === report.id)),
  ));
}

async function loadStaffDirectory() {
  const { data, error } = await supabase
    .from("staff_directory")
    .select("id, display_name, role")
    .order("display_name");
  if (error) {
    showAppError(`Could not load the staff directory: ${error.message}`);
    return false;
  }
  staffDirectory = data;
  return true;
}

async function loadCaseQueue() {
  const list = document.querySelector("#case-list");
  list.replaceChildren();
  const { data: reports, error } = await supabase
    .from("reports")
    .select("id, reference, contact_preference, reporter_name, reporter_contact, description, incident_date, location, desired_support, status, assigned_to, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    showAppError(`Could not load the case queue: ${error.message}`);
    return;
  }
  caseReports = reports;
  const ids = reports.map((report) => report.id);
  const [updatesResult, directoryLoaded] = await Promise.all([
    ids.length
      ? supabase.from("case_updates").select("id, report_id, kind, status, note, created_at").in("report_id", ids).order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    loadStaffDirectory(),
  ]);
  if (updatesResult.error) {
    showAppError(`Reports loaded, but case updates could not be loaded: ${updatesResult.error.message}`);
    return;
  }
  if (!directoryLoaded) return;
  reports.forEach((report) => { report.updates = updatesResult.data.filter((update) => update.report_id === report.id); });

  document.querySelector("#staff-open-count").textContent = String(reports.filter((report) => report.status !== "Closed").length);
  document.querySelector("#staff-new-count").textContent = String(reports.filter((report) => report.status === "Received").length);
  document.querySelector("#staff-followup-count").textContent = String(reports.filter((report) => report.status === "Follow-up").length);
  if (!reports.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No reports have been submitted yet.";
    list.append(empty);
    document.querySelector("#case-detail").hidden = true;
    selectedCaseId = null;
    return;
  }

  if (!reports.some((report) => report.id === selectedCaseId)) selectedCaseId = reports[0].id;
  reports.forEach((report) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `case-row ${report.id === selectedCaseId ? "selected" : ""}`;
    row.dataset.caseId = report.id;
    const reference = document.createElement("span");
    reference.className = "case-ref";
    reference.textContent = displayReference(report.reference);
    const summary = document.createElement("span");
    summary.className = "case-summary";
    const title = document.createElement("strong");
    title.textContent = report.desired_support || "Support request";
    const subtitle = document.createElement("small");
    subtitle.textContent = report.location || "Location not provided";
    summary.append(title, subtitle);
    const time = document.createElement("span");
    time.className = "case-time";
    time.textContent = formatDate(report.created_at, { dateStyle: "medium" });
    const status = document.createElement("span");
    appendStatus(status, report.status);
    const arrow = document.createElement("span");
    arrow.className = "row-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    row.append(reference, summary, time, status, arrow);
    row.addEventListener("click", () => {
      selectedCaseId = report.id;
      renderCaseQueue();
    });
    list.append(row);
  });
  renderCaseDetail(reports.find((report) => report.id === selectedCaseId));
}

function renderCaseQueue() {
  const list = document.querySelector("#case-list");
  list.querySelectorAll(".case-row").forEach((row) => {
    row.classList.toggle("selected", row.dataset.caseId === selectedCaseId);
  });
  renderCaseDetail(caseReports.find((report) => report.id === selectedCaseId));
}

function renderCaseDetail(report) {
  const detail = document.querySelector("#case-detail");
  detail.hidden = !report;
  if (!report) return;
  document.querySelector("#selected-case-title").textContent = displayReference(report.reference);
  document.querySelector("#staff-status").value = report.status;
  const assignee = document.querySelector("#staff-assignee");
  assignee.replaceChildren(new Option("Unassigned", ""));
  staffDirectory.forEach((member) => {
    const option = new Option(
      `${member.display_name || "Team member"} · ${member.role}`,
      member.id,
    );
    assignee.append(option);
  });
  assignee.value = report.assigned_to || "";
  document.querySelector("#staff-description").textContent = report.description || "Not provided";
  document.querySelector("#staff-request").textContent = report.desired_support || "Not provided";
  document.querySelector("#staff-submitted").textContent = formatDate(report.created_at);
  document.querySelector("#staff-identity").textContent = report.contact_preference === "private"
    ? "No additional contact details shared (report is account-linked)"
    : "Additional contact details provided";
  document.querySelector("#staff-contact").textContent = report.reporter_contact
    ? `${report.reporter_name ? `${report.reporter_name} · ` : ""}${report.reporter_contact}`
    : "Not provided";
  document.querySelector("#staff-location").textContent = report.location || "Not provided";
  document.querySelector("#staff-incident-date").textContent = report.incident_date || "Not provided";
  document.querySelector("#staff-note").value = "";
  document.querySelector("#save-feedback").hidden = true;
  const auditList = document.querySelector("#case-audit-list");
  auditList.replaceChildren();
  (report.updates || []).forEach((entry) => {
    const item = document.createElement("p");
    item.textContent = `${entry.kind === "status" ? `Status · ${displayStatus(entry.status)}` : entry.kind === "assignment" ? "Assignment" : "Case update"} · ${formatDate(entry.created_at)} · ${displayNote(entry.note)}`;
    auditList.append(item);
  });
}

async function saveCaseUpdate() {
  const report = caseReports.find((item) => item.id === selectedCaseId);
  if (!report) return;
  const note = document.querySelector("#staff-note").value.trim();
  const status = document.querySelector("#staff-status").value;
  const assignedTo = document.querySelector("#staff-assignee").value || null;
  const button = document.querySelector("#save-case-note");
  button.disabled = true;
  const { error } = await supabase.rpc("record_case_update", {
    p_report_id: report.id,
    p_status: status,
    p_note: note,
    p_assigned_to: assignedTo,
  });
  button.disabled = false;
  if (error) {
    document.querySelector("#staff-note").setCustomValidity(error.message);
    document.querySelector("#staff-note").reportValidity();
    return;
  }
  setFormMessage("#save-feedback", "Assignment and update saved.");
  document.querySelector("#save-feedback").hidden = false;
  await loadCaseQueue();
}

function createSuggestionCard(pair, existingReview) {
  const card = document.createElement("article");
  card.className = "suggestion-card";
  const header = document.createElement("div");
  header.className = "suggestion-top";
  const titleGroup = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "review-label";
  kicker.textContent = "POSSIBLE SHARED WORDING";
  const title = document.createElement("h3");
  title.textContent = "Some wording appears in more than one report";
  titleGroup.append(kicker, title);
  const badge = document.createElement("span");
  badge.className = "confidence-badge";
  badge.textContent = "Human review required";
  header.append(titleGroup, badge);
  const summary = document.createElement("p");
  summary.className = "suggestion-summary";
  summary.textContent = `The reports share ${pair.sharedCount} general terms. Similar wording does not establish that events are related.`;
  const meta = document.createElement("div");
  meta.className = "suggestion-meta";
  [pair.reportA, pair.reportB].forEach((report) => {
    const span = document.createElement("span");
    span.textContent = `${displayReference(report.reference)} · ${formatDate(report.created_at, { dateStyle: "medium" })}`;
    meta.append(span);
  });
  const privacy = document.createElement("div");
  privacy.className = "suggestion-privacy";
  privacy.textContent = "Descriptions, names, and contact details are not shown in this view.";
  const checklist = document.createElement("div");
  checklist.className = "review-checklist";
  const reasonLabel = document.createElement("label");
  reasonLabel.textContent = "Reason for this review decision";
  const reason = document.createElement("textarea");
  reason.className = "text-input staff-note";
  reason.rows = 2;
  reason.placeholder = "Record the review purpose and reasoning";
  reason.setAttribute("aria-label", "Reason for this review decision");
  reasonLabel.append(reason);
  checklist.append(reasonLabel);
  const actions = document.createElement("div");
  actions.className = "suggestion-actions";
  if (existingReview) {
    reason.value = existingReview.reason;
    reason.disabled = true;
    const feedback = document.createElement("p");
    feedback.className = "review-feedback";
    feedback.textContent = `${existingReview.outcome} · ${formatDate(existingReview.created_at)}`;
    actions.append(feedback);
  } else {
    [
      ["dismissed", "Dismiss"],
      ["reviewed", "Mark reviewed · keep separate"],
      ["linked", "Link after review"],
    ].forEach(([outcome, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = outcome === "reviewed" ? "button button-primary" : "button button-outline";
      button.textContent = label;
      button.addEventListener("click", () => savePatternReview(pair, outcome, reason, button));
      actions.append(button);
    });
  }
  card.append(header, summary, meta, privacy, checklist, actions);
  return card;
}

async function loadSuggestions() {
  const container = document.querySelector("#suggestion-list");
  container.replaceChildren();
  const { data: suggestions, error } = await supabase.rpc("get_pattern_suggestions");
  if (error) {
    showAppError(`Could not load reports for review: ${error.message}`);
    return;
  }
  const { data: reviews, error: reviewsError } = await supabase
    .from("pattern_reviews")
    .select("report_a_id, report_b_id, outcome, reason, created_at");
  if (reviewsError) {
    showAppError(`Could not load review decisions: ${reviewsError.message}`);
    return;
  }
  const reviewed = new Map(reviews.map((review) => [
    [review.report_a_id, review.report_b_id].join("|"),
    review,
  ]));
  const pairs = suggestions.map((suggestion) => {
    const reportA = {
      id: suggestion.report_a_id,
      reference: suggestion.report_a_reference,
      created_at: suggestion.report_a_created_at,
    };
    const reportB = {
      id: suggestion.report_b_id,
      reference: suggestion.report_b_reference,
      created_at: suggestion.report_b_created_at,
    };
    return {
      reportA,
      reportB,
      sharedCount: suggestion.shared_count,
      key: [reportA.id, reportB.id].join("|"),
    };
  });
  if (!pairs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No possible keyword overlaps are available to review. A lack of suggestions does not mean there is no pattern.";
    container.append(empty);
    return;
  }
  pairs.forEach((pair) => container.append(
    createSuggestionCard(pair, reviewed.get(pair.key)),
  ));
}

async function savePatternReview(pair, outcome, reasonField, button) {
  const reason = reasonField.value.trim();
  if (!reason) {
    reasonField.setCustomValidity("Add a short reason so the review decision is recorded.");
    reasonField.reportValidity();
    return;
  }
  reasonField.setCustomValidity("");
  button.disabled = true;
  const { error } = await supabase.from("pattern_reviews").insert({
    report_a_id: pair.reportA.id,
    report_b_id: pair.reportB.id,
    reviewer_id: currentUser.id,
    outcome,
    reason,
  });
  button.disabled = false;
  if (error) {
    showAppError(`Could not save this review decision: ${error.message}`);
    return;
  }
  await loadSuggestions();
}

async function populateProfile() {
  document.querySelector("#profile-name").value = currentProfile.display_name || "";
  document.querySelector("#profile-email").value = currentUser.email || "";
  setFormMessage("#profile-error", "", false);
  setFormMessage("#profile-feedback", "", false);
}

async function loadAdminUsers() {
  const list = document.querySelector("#admin-user-list");
  list.replaceChildren();
  const { data, error } = await supabase.rpc("admin_list_profiles");
  if (error) {
    showAppError(`Could not load registered accounts: ${error.message}`);
    return;
  }
  if (!data.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No accounts have registered yet.";
    list.append(empty);
    return;
  }
  data.forEach((user) => {
    const row = document.createElement("div");
    row.className = "admin-user-row";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = user.display_name || "Name not provided";
    const email = document.createElement("small");
    email.textContent = user.email;
    const created = document.createElement("small");
    created.textContent = `Registered ${formatDate(user.created_at, { dateStyle: "medium" })}`;
    details.append(name, email, created);
    const select = document.createElement("select");
    select.className = "status-select";
    select.setAttribute("aria-label", `Role for ${user.email}`);
    ["reporter", "staff", "reviewer", "admin"].forEach((role) => select.add(new Option(role, role)));
    select.value = user.role;
    select.disabled = user.id === currentUser.id;
    select.addEventListener("change", async () => {
      select.disabled = true;
      const { error: roleError } = await supabase.rpc("set_profile_role", {
        p_user_id: user.id,
        p_role: select.value,
      });
      if (roleError) {
        showAppError(`Could not change this role: ${roleError.message}`);
        select.value = user.role;
      } else {
        user.role = select.value;
      }
      select.disabled = user.id === currentUser.id;
    });
    row.append(details, select);
    list.append(row);
  });
}

async function inviteTeamMember(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setFormMessage("#invite-error", "", false);
  setFormMessage("#invite-feedback", "", false);
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    const response = await fetch("/api/admin/invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sessionData.session.access_token}`,
      },
      body: JSON.stringify({
        email: String(fields.get("email") || ""),
        role: String(fields.get("role") || ""),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "The invitation could not be sent.");
    form.reset();
    setFormMessage("#invite-feedback", `Invitation sent to ${result.email} with ${result.role} access.`);
    await loadAdminUsers();
  } catch (error) {
    setFormMessage("#invite-error", error.message || "The invitation could not be sent.");
  } finally {
    button.disabled = false;
  }
}

function setFormStep(step) {
  document.querySelectorAll(".form-step").forEach((panel) => {
    const active = Number(panel.dataset.step) === step;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  document.querySelectorAll("[data-step-indicator]").forEach((indicator) => {
    const number = Number(indicator.dataset.stepIndicator);
    indicator.classList.toggle("current", number === step);
    indicator.classList.toggle("complete", number < step);
  });
  document.querySelector(".flow-aside").scrollIntoView({ behavior: "smooth", block: "start" });
}

function startReport() {
  resetReportForm();
  showView("form");
  setFormStep(1);
  document.querySelector("#form-title").focus({ preventScroll: true });
}

function handleAuthError(selector, error) {
  setFormMessage(selector, readableError(error, "The request could not be completed."));
}

function wireEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => showView(button.dataset.view));
  });
  document.querySelectorAll("[data-view-link]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showView(button.dataset.viewLink);
    });
  });
  document.querySelectorAll("[data-start-report]").forEach((button) => {
    button.addEventListener("click", startReport);
  });
  document.querySelectorAll("[data-scroll-support]").forEach((button) => {
    button.addEventListener("click", () => document.querySelector("#support").scrollIntoView({ behavior: "smooth" }));
  });
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    menuButton.setAttribute("aria-expanded", String(open));
    navMenu.classList.toggle("open", open);
  });
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => showAuthMode(button.dataset.authMode));
  });

  document.querySelector("#sign-in-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setFormMessage("#sign-in-error", "", false);
    setFormMessage("#auth-feedback", "", false);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: String(fields.get("email") || "").trim(),
        password: String(fields.get("password") || ""),
      });
      if (error) handleAuthError("#sign-in-error", error);
    } catch (error) {
      handleAuthError("#sign-in-error", error);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const button = form.querySelector('button[type="submit"]');
    const password = document.querySelector("#register-password");
    const confirmPassword = document.querySelector("#register-confirm-password");
    confirmPassword.setCustomValidity(
      password.value === confirmPassword.value ? "" : "Passwords do not match.",
    );
    if (!confirmPassword.reportValidity()) return;

    button.disabled = true;
    setFormMessage("#register-error", "", false);
    setFormMessage("#auth-feedback", "", false);
    try {
      const { data, error } = await supabase.auth.signUp({
        email: String(fields.get("email") || "").trim(),
        password: String(fields.get("password") || ""),
        options: {
          data: { display_name: String(fields.get("displayName") || "").trim() },
          emailRedirectTo: window.location.origin,
        },
      });
      if (error) {
        handleAuthError("#register-error", error);
        return;
      }
      if (data.session) {
        suppressSignupSessionId = data.session.user.id;
        const { error: signOutError } = await supabase.auth.signOut();
        if (signOutError) {
          suppressSignupSessionId = null;
          setFormMessage("#register-error", `Account created, but the session could not be closed: ${readableError(signOutError, "Please sign out manually.")}`);
          return;
        }
        setFormMessage("#auth-feedback", "Account created. Email confirmation is turned off in Supabase. Ask the administrator to require email confirmation before using this account.");
      } else {
        setFormMessage("#auth-feedback", "Check your email and open the confirmation link to finish creating your account.");
      }
      form.reset();
      confirmPassword.setCustomValidity("");
    } catch (error) {
      suppressSignupSessionId = null;
      handleAuthError("#register-error", error);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#register-password").addEventListener("input", () => {
    const password = document.querySelector("#register-password");
    const confirmPassword = document.querySelector("#register-confirm-password");
    confirmPassword.setCustomValidity(
      confirmPassword.value && password.value !== confirmPassword.value
        ? "Passwords do not match."
        : "",
    );
  });
  document.querySelector("#register-confirm-password").addEventListener("input", (event) => {
    const password = document.querySelector("#register-password");
    const confirmPassword = event.currentTarget;
    confirmPassword.setCustomValidity(
      password.value === confirmPassword.value ? "" : "Passwords do not match.",
    );
  });

  document.querySelector("#forgot-password").addEventListener("click", async () => {
    const email = document.querySelector("#sign-in-email").value.trim();
    if (!email) {
      setFormMessage("#sign-in-error", "Enter your email first, then choose password recovery.");
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (error) handleAuthError("#sign-in-error", error);
      else setFormMessage("#auth-feedback", "If the address belongs to an account, password recovery instructions will be emailed.");
    } catch (error) {
      handleAuthError("#sign-in-error", error);
    }
  });
  document.querySelector("#update-password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = document.querySelector("#recovery-password").value;
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      handleAuthError("#recovery-error", error);
      return;
    }
    setFormMessage("#recovery-error", "", false);
    setFormMessage("#auth-feedback", "Password updated.");
    showView(preferredDestination(currentProfile.role));
  });

  document.querySelectorAll('input[name="identity"]').forEach((input) => {
    input.addEventListener("change", () => {
      document.querySelectorAll(".choice-card").forEach((card) => card.classList.remove("selected"));
      input.closest(".choice-card").classList.add("selected");
      document.querySelector(".contact-fields").hidden = input.value !== "contact";
    });
  });
  document.querySelectorAll("[data-next-step]").forEach((button) => {
    button.addEventListener("click", () => {
      const next = Number(button.dataset.nextStep);
      if (next === 3) updateReview();
      setFormStep(next);
    });
  });
  document.querySelectorAll("[data-prev-step]").forEach((button) => {
    button.addEventListener("click", () => setFormStep(Number(button.dataset.prevStep)));
  });
  document.querySelector("#report-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitReport(event.currentTarget);
  });
  document.querySelector("#save-case-note").addEventListener("click", saveCaseUpdate);
  document.querySelector("#staff-note").addEventListener("input", (event) => {
    event.currentTarget.setCustomValidity("");
  });
  document.querySelector("#refresh-cases").addEventListener("click", loadCaseQueue);
  document.querySelector("#refresh-users").addEventListener("click", loadAdminUsers);
  document.querySelector("#invite-form").addEventListener("submit", inviteTeamMember);
  document.querySelector("#profile-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const displayName = document.querySelector("#profile-name").value.trim();
    const { error } = await supabase.from("profiles").update({ display_name: displayName }).eq("id", currentUser.id);
    if (error) {
      handleAuthError("#profile-error", error);
      setFormMessage("#profile-feedback", "", false);
      return;
    }
    currentProfile.display_name = displayName;
    setFormMessage("#profile-error", "", false);
    setFormMessage("#profile-feedback", "Profile updated.");
  });
  document.querySelectorAll("#sign-out, [data-sign-out]").forEach((button) => {
    button.addEventListener("click", async () => {
    const { error } = await supabase.auth.signOut();
    if (error) showAppError(`Could not sign out: ${error.message}`);
    });
  });
}

function initializeProgressiveWebApp() {
  const banner = document.querySelector("#install-banner");
  const installButton = document.querySelector("#install-app");
  const dismissButton = document.querySelector("#dismiss-install");
  const description = document.querySelector("#install-description");
  let installPrompt = null;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
  const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .catch((error) => console.error("Could not register the Harbor offline app shell.", error));
  }
  if (isStandalone) return;

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    banner.hidden = false;
  });

  installButton.addEventListener("click", async () => {
    if (!installPrompt) {
      description.textContent = "In Safari, open Share and choose Add to Home Screen.";
      installButton.textContent = "Got it";
      installButton.addEventListener("click", () => { banner.hidden = true; }, { once: true });
      return;
    }

    installButton.disabled = true;
    try {
      await installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") banner.hidden = true;
      installPrompt = null;
    } catch (error) {
      console.error("The Harbor installation prompt could not be opened.", error);
      description.textContent = "Installation is not available right now. Use your browser menu to install Harbor.";
    } finally {
      installButton.disabled = false;
    }
  });
  dismissButton.addEventListener("click", () => { banner.hidden = true; });
  window.addEventListener("appinstalled", () => {
    banner.hidden = true;
    installPrompt = null;
  });

  if (isAppleMobile) {
    banner.hidden = false;
    description.textContent = "In Safari, open Share and choose Add to Home Screen.";
    installButton.textContent = "Install steps";
  }
}

async function initialize() {
  initializeProgressiveWebApp();
  wireEvents();
  if (!import.meta.env.VITE_SUPABASE_URL || !import.meta.env.VITE_SUPABASE_ANON_KEY) {
    showView("auth");
    document.querySelector("#setup-message").hidden = false;
    document.querySelectorAll("#sign-in-form button, #register-form button, #forgot-password").forEach((button) => {
      button.disabled = true;
    });
    return;
  }

  try {
    supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
    });
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      showView("auth", `Could not restore your session: ${readableError(error, "The request could not be completed.")}`);
      return;
    }
    await setSession(data.session);
  } catch (error) {
    showView("auth", `Could not connect to your account: ${readableError(error, "Check the Supabase configuration and try again.")}`);
    return;
  }
  supabase.auth.onAuthStateChange((event, session) => {
    setTimeout(async () => {
      if (event === "SIGNED_IN" && session?.user.id === suppressSignupSessionId) {
        suppressSignupSessionId = null;
        return;
      }
      try {
        if (event === "PASSWORD_RECOVERY" && session) {
          await setSession(session, false);
          showPasswordRecovery();
        } else {
          await setSession(session);
        }
      } catch (error) {
        showView("auth", `Could not load your account: ${readableError(error, "The request could not be completed.")}`);
      }
    }, 0);
  });
}

initialize();
