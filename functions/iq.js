/**
 * ARIA Clinic – Alma IQ report ingestion
 * ---------------------------------------
 * Two entry points feed the same pipeline:
 *   1. Storage trigger: a PDF uploaded to iq-inbox/<file>.pdf (from the clinic app / iPad)
 *   2. HTTP endpoint "iqInbound": SendGrid Inbound Parse posts the e-mail Alma IQ sends
 *      (multipart/form-data with the PDF attached). Protected by the IQ_INBOUND_KEY secret (?key=...)
 *
 * Pipeline: parse the PDF (patient name/phone/e-mail/date + labelled images) → match a patient by
 * phone (fallback: exact name) → store the PDF + the 5 daylight photos under patients/<id>/ →
 * create patientPhotos docs (tag "before", area "Alma IQ · <view> · <date>") → log an iqReports doc.
 * Unmatched reports are kept under iq-unmatched/ with status "unmatched" so staff can assign them in the app.
 */
const admin = require("firebase-admin");
const { logger } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { defineSecret } = require("firebase-functions/params");
const Busboy = require("busboy");
const crypto = require("crypto");
const { parseIqReport } = require("./iqparse");

const IQ_INBOUND_KEY = defineSecret("IQ_INBOUND_KEY");
const REGION = "europe-west1";
const DAYLIGHT_ONLY = true; // store only the daylight views as patient photos (the full PDF keeps the rest)

function db() { return admin.firestore(); }
function bucket() { return admin.storage().bucket(); }

// "054-443-2108" / "+972544432108" / "972544432108" → "0544432108"
function localPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
}

async function findPatient({ phone, name }) {
  const want = localPhone(phone);
  const snap = await db().collection("patients").get();
  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (want.length >= 9) {
    const byPhone = all.filter((p) => localPhone(p.phone) === want);
    if (byPhone.length === 1) return { patient: byPhone[0], how: "phone" };
    if (byPhone.length > 1) {
      const byBoth = byPhone.find((p) => (p.name || "").trim() === (name || "").trim());
      if (byBoth) return { patient: byBoth, how: "phone+name" };
    }
  }
  const n = (name || "").trim();
  if (n) {
    const byName = all.filter((p) => (p.name || "").trim() === n);
    if (byName.length === 1) return { patient: byName[0], how: "name" };
  }
  return { patient: null, how: "none" };
}

// "before" for the patient's first Alma IQ visit, "after" for any later visit date.
// A re-sent report of the same visit keeps the tag that visit already has.
function parseVisitDate(d) { // "15.4.2026" → Date
  const m = String(d || "").match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
}
async function tagForVisit(patientId, visitDate) {
  const snap = await db().collection("iqReports").where("patientId", "==", patientId).where("status", "==", "matched").get();
  const thisDate = parseVisitDate(visitDate);
  let earliest = null, sameVisitTag = null;
  for (const d of snap.docs) {
    const r = d.data();
    const vd = parseVisitDate(r.parsed?.visitDate);
    if (!vd) continue;
    if (thisDate && vd.getTime() === thisDate.getTime() && r.tag) sameVisitTag = r.tag;
    if (!earliest || vd < earliest) earliest = vd;
  }
  if (sameVisitTag) return sameVisitTag;
  if (!earliest || !thisDate) return "before";
  return thisDate > earliest ? "after" : "before";
}

async function saveFile(path, buf, contentType) {
  const token = crypto.randomUUID();
  const file = bucket().file(path);
  await file.save(buf, { contentType, metadata: { metadata: { firebaseStorageDownloadTokens: token } }, resumable: false });
  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket().name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  return { path, url };
}

// Main pipeline. Returns the iqReports doc data.
async function ingestIqReport(pdfBuffer, { source, meta = {} }) {
  const parsed = await parseIqReport(pdfBuffer);
  const { patient: info, images } = parsed;
  const { patient, how } = await findPatient(info);
  const stamp = Date.now();
  const dateLabel = info.visitDate || new Date().toLocaleDateString("he-IL");
  const base = patient ? `patients/${patient.id}` : "iq-unmatched";

  const pdf = await saveFile(`${base}/iq-${stamp}.pdf`, pdfBuffer, "application/pdf");
  const keep = images.filter((im) => !DAYLIGHT_ONLY || im.mode === "daylight");
  const stored = [];
  for (const im of keep) {
    const f = await saveFile(`${base}/iq-${stamp}-${im.view || "front"}-${im.mode}.jpg`, im.jpeg, "image/jpeg");
    stored.push({ ...f, view: im.view, viewLabel: im.viewLabel, mode: im.mode, modeLabel: im.modeLabel });
  }

  const tag = patient ? await tagForVisit(patient.id, info.visitDate) : "before";
  const report = {
    status: patient ? "matched" : "unmatched",
    matchedBy: how,
    tag,
    source,
    meta,
    patientId: patient?.id || "",
    patientName: patient?.name || "",
    parsed: { name: info.name, phone: info.phone, email: info.email, visitDate: info.visitDate, visitTime: info.visitTime, imageCount: images.length },
    pdfPath: pdf.path, pdfUrl: pdf.url,
    images: stored,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  const ref = await db().collection("iqReports").add(report);

  if (patient) {
    const batch = db().batch();
    for (const im of stored) {
      batch.set(db().collection("patientPhotos").doc(), {
        patientId: patient.id, patientName: patient.name || "",
        path: im.path, url: im.url, tag,
        area: `Alma IQ · ${im.viewLabel} · ${dateLabel}`,
        source: "alma-iq", iqReportId: ref.id, iqView: im.view, iqMode: im.mode,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  logger.info("Alma IQ report ingested", { id: ref.id, status: report.status, matchedBy: how, tag, name: info.name, phone: info.phone, images: stored.length });
  return { id: ref.id, ...report };
}

// Staff assigns an unmatched report to a patient from the app: iqReports/{id}.assignTo = patientId
async function assignReport(reportId, patientId) {
  const rref = db().collection("iqReports").doc(reportId);
  const rsnap = await rref.get();
  if (!rsnap.exists) throw new Error("report not found");
  const r = rsnap.data();
  const psnap = await db().collection("patients").doc(patientId).get();
  if (!psnap.exists) throw new Error("patient not found");
  const patient = { id: psnap.id, ...psnap.data() };
  const dateLabel = r.parsed?.visitDate || "";
  const tag = await tagForVisit(patient.id, r.parsed?.visitDate);
  const moved = [];
  // move files under the patient folder so storage rules apply
  for (const im of r.images || []) {
    const newPath = im.path.replace(/^iq-unmatched\//, `patients/${patient.id}/`);
    if (newPath !== im.path) { await bucket().file(im.path).move(newPath); }
    const token = crypto.randomUUID();
    await bucket().file(newPath).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    const url = `https://firebasestorage.googleapis.com/v0/b/${bucket().name}/o/${encodeURIComponent(newPath)}?alt=media&token=${token}`;
    moved.push({ ...im, path: newPath, url });
  }
  let pdfPath = r.pdfPath, pdfUrl = r.pdfUrl;
  if (pdfPath && pdfPath.startsWith("iq-unmatched/")) {
    const newPath = pdfPath.replace(/^iq-unmatched\//, `patients/${patient.id}/`);
    await bucket().file(pdfPath).move(newPath);
    const token = crypto.randomUUID();
    await bucket().file(newPath).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    pdfPath = newPath;
    pdfUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket().name}/o/${encodeURIComponent(newPath)}?alt=media&token=${token}`;
  }
  const batch = db().batch();
  for (const im of moved) {
    batch.set(db().collection("patientPhotos").doc(), {
      patientId: patient.id, patientName: patient.name || "",
      path: im.path, url: im.url, tag,
      area: `Alma IQ · ${im.viewLabel} · ${dateLabel}`,
      source: "alma-iq", iqReportId: reportId, iqView: im.view, iqMode: im.mode,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  batch.update(rref, { status: "matched", matchedBy: "manual", tag, patientId: patient.id, patientName: patient.name || "", images: moved, pdfPath, pdfUrl, assignTo: admin.firestore.FieldValue.delete(), assignedAt: admin.firestore.FieldValue.serverTimestamp() });
  await batch.commit();
}

// ---- Entry point 1: PDF dropped into iq-inbox/ (app upload) ------------------------------------
exports.onIqPdfUploaded = onObjectFinalized({ region: REGION, memory: "1GiB", timeoutSeconds: 300 }, async (event) => {
  const name = event.data.name || "";
  if (!name.startsWith("iq-inbox/") || !name.toLowerCase().endsWith(".pdf")) return;
  const [buf] = await bucket().file(name).download();
  try {
    await ingestIqReport(buf, { source: "upload", meta: { file: name, uploadedBy: event.data.metadata?.uploadedBy || "" } });
    await bucket().file(name).delete().catch(() => {});
  } catch (e) {
    logger.error("Alma IQ ingest failed", { file: name, err: e.message });
    await db().collection("iqReports").add({ status: "error", source: "upload", error: e.message, meta: { file: name }, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  }
});

// ---- Entry point 2: inbound e-mail via SendGrid Inbound Parse -----------------------------------
exports.iqInbound = onRequest({ region: REGION, memory: "1GiB", timeoutSeconds: 300, secrets: [IQ_INBOUND_KEY] }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("POST only");
  if ((req.query.key || "") !== IQ_INBOUND_KEY.value()) return res.status(403).send("forbidden");
  const fields = {}; const pdfs = [];
  await new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 40 * 1024 * 1024 } });
    bb.on("field", (k, v) => { fields[k] = v; });
    bb.on("file", (k, stream, info) => {
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const buf = Buffer.concat(chunks);
        const isPdf = (info.mimeType || "").includes("pdf") || /\.pdf$/i.test(info.filename || "") || buf.slice(0, 4).toString() === "%PDF";
        if (isPdf && buf.length) pdfs.push({ filename: info.filename, buf });
      });
    });
    bb.on("error", reject);
    bb.on("finish", resolve);
    if (req.rawBody) bb.end(req.rawBody); else req.pipe(bb);
  });
  const meta = { from: fields.from || "", subject: fields.subject || "", to: fields.to || "" };
  if (!pdfs.length) {
    logger.warn("iqInbound: e-mail without PDF", meta);
    await db().collection("iqReports").add({ status: "error", source: "email", error: "no PDF attached", meta, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return res.status(200).send("no pdf");
  }
  for (const p of pdfs) {
    try { await ingestIqReport(p.buf, { source: "email", meta: { ...meta, filename: p.filename } }); }
    catch (e) {
      logger.error("iqInbound ingest failed", { err: e.message, ...meta });
      await db().collection("iqReports").add({ status: "error", source: "email", error: e.message, meta, createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }
  }
  res.status(200).send("ok");
});

// ---- Manual assignment from the app --------------------------------------------------------------
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
exports.onIqReportAssigned = onDocumentUpdated({ region: REGION, document: "iqReports/{id}" }, async (event) => {
  const after = event.data?.after?.data();
  if (!after?.assignTo || after.status === "matched") return;
  try { await assignReport(event.params.id, after.assignTo); }
  catch (e) {
    logger.error("assignReport failed", e.message);
    await event.data.after.ref.update({ assignTo: admin.firestore.FieldValue.delete(), error: e.message });
  }
});

module.exports.ingestIqReport = ingestIqReport;
