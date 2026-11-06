/**
 * ARIA Clinic – Gmail poller for Alma IQ reports
 * ------------------------------------------------
 * Every 5 minutes: read the dedicated Gmail inbox (ariaclinic10@gmail.com), pick unread mails with a PDF
 * attachment, run them through ingestIqReport(), then label the mail "Alma IQ" and mark it read.
 * Auth: OAuth refresh token stored in the GMAIL_OAUTH secret as JSON {client_id, client_secret, refresh_token}.
 * Scope needed: https://www.googleapis.com/auth/gmail.modify
 */
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { ingestIqReport } = require("./iq");

const GMAIL_OAUTH = defineSecret("GMAIL_OAUTH");
const REGION = "europe-west1";
const DONE_LABEL = "Alma IQ";
const QUERY = "is:unread has:attachment filename:pdf newer_than:30d";

async function accessToken(cfg) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: cfg.refresh_token, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("gmail token refresh failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function gapi(token, path, opts = {}) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!r.ok) throw new Error(`gmail ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ensureLabel(token) {
  const { labels = [] } = await gapi(token, "labels");
  const found = labels.find((l) => l.name === DONE_LABEL);
  if (found) return found.id;
  const created = await gapi(token, "labels", { method: "POST", body: JSON.stringify({ name: DONE_LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" }) });
  return created.id;
}

function walkParts(part, out = []) {
  if (!part) return out;
  if (part.filename && part.body?.attachmentId) out.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId, size: part.body.size });
  for (const p of part.parts || []) walkParts(p, out);
  return out;
}

function header(msg, name) {
  return (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

async function pollGmail() {
  const cfg = JSON.parse(GMAIL_OAUTH.value() || "{}");
  if (!cfg.refresh_token) { logger.warn("GMAIL_OAUTH not configured"); return; }
  const token = await accessToken(cfg);
  const labelId = await ensureLabel(token);
  const list = await gapi(token, `messages?q=${encodeURIComponent(QUERY + ` -label:"${DONE_LABEL}"`)}&maxResults=10`);
  const ids = (list.messages || []).map((m) => m.id);
  if (!ids.length) return;
  let done = 0;
  for (const id of ids) {
    const msg = await gapi(token, `messages/${id}?format=full`);
    const meta = { from: header(msg, "From"), subject: header(msg, "Subject"), date: header(msg, "Date"), gmailId: id };
    const atts = walkParts(msg.payload).filter((a) => /\.pdf$/i.test(a.filename) || (a.mimeType || "").includes("pdf"));
    for (const a of atts) {
      try {
        const body = await gapi(token, `messages/${id}/attachments/${a.attachmentId}`);
        const buf = Buffer.from(body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (buf.slice(0, 4).toString() !== "%PDF") continue;
        await ingestIqReport(buf, { source: "email", meta: { ...meta, filename: a.filename } });
        done++;
      } catch (e) {
        logger.error("Gmail IQ ingest failed", { id, file: a.filename, err: e.message });
        await admin.firestore().collection("iqReports").add({ status: "error", source: "email", error: e.message, meta: { ...meta, filename: a.filename }, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    // label + mark read either way, so a bad mail is not retried forever
    await gapi(token, `messages/${id}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: [labelId], removeLabelIds: ["UNREAD"] }) });
  }
  logger.info(`Gmail poll: ${ids.length} mails, ${done} reports ingested`);
}

exports.pollIqMailbox = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Asia/Jerusalem", region: REGION, memory: "1GiB", timeoutSeconds: 300, secrets: [GMAIL_OAUTH] },
  async () => { await pollGmail(); }
);
