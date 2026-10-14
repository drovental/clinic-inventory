/**
 * ARIA Clinic – WhatsApp post-treatment follow-up bot
 * Firebase Cloud Functions (v2) + Twilio WhatsApp + Claude
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// ---- Secrets (set with: firebase functions:secrets:set NAME) ----
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ALERT_WHATSAPP_TO = defineSecret("ALERT_WHATSAPP_TO"); // comma-separated

// ---- Config ----
// Sandbox number during development. Replace with the clinic's registered sender later.
const WHATSAPP_FROM = "whatsapp:+14155238886";
const WEBHOOK_URL = "https://europe-west1-aria-inventory.cloudfunctions.net/whatsappWebhook";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CONVERSATIONS = "whatsappConversations";
const FOLLOWUPS = "whatsappFollowups";
const TREATMENTS = "treatments"; // written by the inventory app
const PATIENTS = "patients";     // written by the inventory app
const MAX_HISTORY = 30;
// When to send the follow-up: next day at this hour (Israel time)
const FOLLOWUP_HOUR = 11;
const TIMEZONE = "Asia/Jerusalem";

// ---- Persona / system prompt (Hebrew) ----
const SYSTEM_PROMPT = `את נציגת מעקב של ARIA Clinic, קליניקה לאסתטיקה רפואית. שמך "נועה".
את מנהלת שיחת ווטסאפ עם לקוחה שעברה טיפול אסתטי בקליניקה לאחרונה. מטרת השיחה: לבדוק איך היא מרגישה אחרי הטיפול, לזהות בעיות או תופעות לוואי, ולתת תחושה שאכפת לנו.

סגנון:
- עברית טבעית, חמה, אנושית וקצרה – כמו הודעת ווטסאפ אמיתית, לא כמו טופס. משפט אחד עד שלושה. בלי רשימות, בלי כותרות.
- פנייה בלשון נקבה כברירת מחדל (רוב הלקוחות נשים). אם ברור שמדובר בגבר – עברי ללשון זכר.
- שאלה אחת בכל פעם. אל תחזרי על שאלות שכבר נענו.
- אם שואלים אם את בוט – עני בכנות שאת עוזרת דיגיטלית של הקליניקה, ושד"ר עמית והצוות רואים את השיחה.
- אל תתני אבחנות או הנחיות רפואיות מעבר להנחיות הכלליות שאחרי טיפול (קירור עדין, להימנע מלחץ על האזור, להימנע מחום/ספורט ב-24 שעות). אל תמליצי על תרופות.
- אם משהו לא תקין – הרגיעי, הסבירי שהרופא מקבל עדכון מיידי ויחזור אליה, ובמקרה דחוף בקשי ממנה להתקשר לקליניקה מיד.
- כשברור שהכל בסדר – סיימי בחום, הזכירי שאפשר לכתוב לנו בכל שאלה, וסמני שהשיחה הסתיימה.

סיווג סיכון (risk) – חובה בכל תשובה:
- "ok": הכל תקין, או תופעות צפויות וקלות (נפיחות קלה, שטף דם קטן, רגישות קלה, אדמומיות מקומית שחולפת).
- "attention": משהו שדורש עין של הרופא אך לא חירום – אסימטריה, נפיחות שלא יורדת אחרי כמה ימים, כאב בינוני מתמשך, גושים/קשיות, צניחת עפעף, חוסר שביעות רצון מהתוצאה, לקוחה מודאגת או כועסת.
- "urgent": סימני חירום – כאב חזק או מחמיר, שינוי צבע עור (לבן/אפור/כחלחל/כתמים), אדמומיות מתפשטת או חמה, פצעים/שלפוחיות, חום, הפרעות ראייה, קושי בבליעה/נשימה, סימני זיהום, תגובה אלרגית.

תמיד השתמשי בכלי respond כדי לענות.`;

const RESPOND_TOOL = {
  name: "respond",
  description: "Send the next WhatsApp reply to the client and classify the situation.",
  input_schema: {
    type: "object",
    properties: {
      reply: { type: "string", description: "The WhatsApp message to send to the client, in Hebrew." },
      risk: { type: "string", enum: ["ok", "attention", "urgent"] },
      summary: {
        type: "string",
        description: "One or two Hebrew sentences summarizing the client's current state for the doctor.",
      },
      done: {
        type: "boolean",
        description: "true if the follow-up conversation has naturally concluded.",
      },
    },
    required: ["reply", "risk", "summary", "done"],
  },
};

// ---- Helpers ----
const phoneKey = (whatsappAddr) => String(whatsappAddr || "").replace(/^whatsapp:/, "").replace(/\D/g, "");

const escapeXml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const riskLabel = { ok: "תקין", attention: "דורש תשומת לב ⚠️", urgent: "דחוף 🚨" };

async function askClaude(apiKey, conv) {
  const client = new Anthropic({ apiKey });
  const context = `פרטי הלקוחה: שם – ${conv.name || "לא ידוע"}. טיפול – ${conv.treatment || "לא צוין"}. ${
    conv.treatmentDate ? "תאריך הטיפול – " + conv.treatmentDate + "." : ""
  }`;

  const messages = conv.messages.slice(-MAX_HISTORY).map((m) => ({
    role: m.role === "client" ? "user" : "assistant",
    content: m.text,
  }));
  // Claude requires the conversation to start with a user turn.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "[תחילת שיחת מעקב]" });
  }

  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 600,
    system: `${SYSTEM_PROMPT}\n\n${context}`,
    tools: [RESPOND_TOOL],
    tool_choice: { type: "auto" },
    messages,
  });

  const toolUse = res.content.find((c) => c.type === "tool_use");
  if (toolUse) return toolUse.input;

  // Fallback: the model answered in plain text instead of using the tool
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  if (!text) throw new Error("Claude returned an empty response");
  return { reply: text, risk: "ok", summary: "תשובה ללא סיווג (טקסט חופשי).", done: false };
}

async function sendWhatsApp(sid, token, to, body) {
  const client = twilio(sid, token);
  return client.messages.create({ from: WHATSAPP_FROM, to, body });
}

async function alertDoctor({ sid, token, recipients, conv, result, lastClientText }) {
  const text =
    `*ARIA – מעקב אחרי טיפול: ${riskLabel[result.risk]}*\n` +
    `לקוחה: ${conv.name || "לא ידוע"}\n` +
    `טלפון: +${conv.phone}\n` +
    `טיפול: ${conv.treatment || "לא צוין"}\n\n` +
    `סיכום: ${result.summary}\n\n` +
    `ההודעה האחרונה שלה: "${lastClientText}"`;

  await Promise.all(
    recipients.map((raw) => {
      let to = raw.trim();
      if (!to.startsWith("whatsapp:")) to = "whatsapp:" + to;
      return sendWhatsApp(sid, token, to, text).catch((e) =>
        logger.error("Alert send failed", { to, err: e.message })
      );
    })
  );
}

// =====================================================================
// 1) Incoming WhatsApp messages from clients (Twilio webhook)
// =====================================================================
exports.whatsappWebhook = onRequest(
  { secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ANTHROPIC_API_KEY, ALERT_WHATSAPP_TO] },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");

    // Verify the request really came from Twilio
    const signature = req.get("X-Twilio-Signature") || "";
    const url = WEBHOOK_URL;
    const valid = twilio.validateRequest(TWILIO_AUTH_TOKEN.value(), signature, url, req.body || {});
    if (!valid) {
      logger.warn("Invalid Twilio signature", { url });
      return res.status(403).send("Forbidden");
    }

    const from = req.body.From; // e.g. whatsapp:+9725...
    const text = (req.body.Body || "").trim();
    const name = req.body.ProfileName || "";
    const key = phoneKey(from);
    if (!key || !text) return res.status(200).send("<Response></Response>");

    const ref = db.collection(CONVERSATIONS).doc(key);
    const snap = await ref.get();
    const conv = snap.exists
      ? snap.data()
      : {
          phone: key,
          whatsapp: from,
          name,
          treatment: "",
          status: "open",
          lastRisk: "ok",
          messages: [],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
    if (!conv.name && name) conv.name = name;
    conv.messages = conv.messages || [];
    conv.messages.push({ role: "client", text, at: new Date().toISOString() });

    let result;
    try {
      result = await askClaude(ANTHROPIC_API_KEY.value(), conv);
    } catch (e) {
      logger.error("Claude error", e);
      result = {
        reply: "סליחה, יש לי תקלה קטנה רגע. אם משהו דחוף – התקשרי לקליניקה. נחזור אלייך בהקדם 💛",
        risk: "attention",
        summary: "תקלה טכנית בבוט – לא הצלחנו לעבד את ההודעה.",
        done: false,
      };
    }

    conv.messages.push({ role: "assistant", text: result.reply, at: new Date().toISOString() });

    const order = { ok: 0, attention: 1, urgent: 2 };
    const escalated = order[result.risk] > order[conv.lastRisk || "ok"] || result.risk === "urgent";

    const update = {
      ...conv,
      lastRisk: result.risk,
      lastSummary: result.summary,
      status: result.done && result.risk === "ok" ? "closed" : "open",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (escalated) update.lastAlertAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(update, { merge: true });

    if (escalated) {
      const recipients = ALERT_WHATSAPP_TO.value().split(",").filter(Boolean);
      await alertDoctor({
        sid: TWILIO_ACCOUNT_SID.value(),
        token: TWILIO_AUTH_TOKEN.value(),
        recipients,
        conv: update,
        result,
        lastClientText: text,
      });
    }

    res.set("Content-Type", "text/xml");
    return res.status(200).send(`<Response><Message>${escapeXml(result.reply)}</Message></Response>`);
  }
);

// =====================================================================
// Follow-up sending (shared by manual + automatic flows)
// =====================================================================
function normalizePhone(raw) {
  let phone = String(raw || "").replace(/[\s-]/g, "");
  if (!phone) return null;
  if (phone.startsWith("0")) phone = "+972" + phone.slice(1);
  if (!phone.startsWith("+")) phone = "+" + phone;
  if (phone.replace(/\D/g, "").length < 11) return null; // not a full international number
  return phone;
}

async function sendOpeningMessage({ sid, token, ref, data }) {
  const phone = normalizePhone(data.phone);
  if (!phone) {
    await ref.update({ status: "failed", error: "מספר טלפון לא תקין" });
    return;
  }
  const to = `whatsapp:${phone}`;
  const key = phoneKey(to);

  const firstName = (data.name || "").split(" ")[0];
  const opening =
    `היי${firstName ? " " + firstName : ""} 💛 זאת נועה מ-ARIA Clinic.\n` +
    `רציתי לבדוק איך את מרגישה אחרי ${data.treatment ? "ה" + data.treatment : "הטיפול"}? הכל בסדר באזור הטיפול?`;

  await db.collection(CONVERSATIONS).doc(key).set(
    {
      phone: key,
      whatsapp: to,
      name: data.name || "",
      patientId: data.patientId || "",
      treatment: data.treatment || "",
      treatmentDate: data.treatmentDate || "",
      status: "open",
      lastRisk: "ok",
      messages: [{ role: "assistant", text: opening, at: new Date().toISOString() }],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: false }
  );

  try {
    await sendWhatsApp(sid, token, to, opening);
    await ref.update({ sentAt: admin.firestore.FieldValue.serverTimestamp(), status: "sent" });
  } catch (e) {
    logger.error("Opening message failed", e);
    await ref.update({ status: "failed", error: e.message });
  }
}

// =====================================================================
// 2) Manual follow-up: create a doc in "whatsappFollowups" without scheduledFor
//    { phone: "+9725xxxxxxx", name: "דנה", treatment: "בוטוקס מצח" }
//    Docs that carry scheduledFor are sent later by sendScheduledFollowups.
// =====================================================================
exports.startFollowup = onDocumentCreated(
  { document: `${FOLLOWUPS}/{id}`, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN] },
  async (event) => {
    const data = event.data?.data();
    if (!data || !data.phone) return;
    if (data.scheduledFor) return; // scheduled → handled by the hourly job
    await sendOpeningMessage({
      sid: TWILIO_ACCOUNT_SID.value(),
      token: TWILIO_AUTH_TOKEN.value(),
      ref: event.data.ref,
      data,
    });
  }
);

// =====================================================================
// 3) Automatic: a treatment saved in the inventory app → schedule a follow-up
//    for the next day at FOLLOWUP_HOUR. Several products for the same patient
//    on the same day are merged into one follow-up.
// =====================================================================
function nextDayAt(hour) {
  // Compute "tomorrow at HH:00" in Israel time, returned as a JS Date (UTC instant)
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const tomorrow = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1, hour, 0, 0));
  // Israel offset at that moment (UTC+2 or UTC+3)
  const offsetMin = (() => {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "shortOffset" })
      .formatToParts(tomorrow).find((p) => p.type === "timeZoneName")?.value || "GMT+2";
    const m = s.match(/([+-])(\d+)(?::(\d+))?/);
    return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0)) : 120;
  })();
  return new Date(tomorrow.getTime() - offsetMin * 60 * 1000);
}

exports.onTreatmentCreated = onDocumentCreated(`${TREATMENTS}/{id}`, async (event) => {
  const t = event.data?.data();
  if (!t || !t.patientId) return;

  const patientSnap = await db.collection(PATIENTS).doc(t.patientId).get();
  if (!patientSnap.exists) return;
  const patient = patientSnap.data();
  const phone = normalizePhone(patient.phone);
  if (!phone) {
    logger.info("Treatment without valid patient phone – no follow-up", { patientId: t.patientId });
    return;
  }
  if (patient.noFollowup === true) return; // opt-out flag on the patient record

  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date()); // YYYY-MM-DD
  const followupId = `${t.patientId}_${dateKey}`;
  const ref = db.collection(FOLLOWUPS).doc(followupId);
  const treatmentLabel = [t.productName, t.note].filter(Boolean).join(" – ");

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data();
      if (d.status !== "scheduled") return; // already sent – don't touch
      const treatments = Array.from(new Set([...(d.treatments || []), treatmentLabel]));
      tx.update(ref, { treatments, treatment: treatments.join(", ") });
      return;
    }
    tx.set(ref, {
      phone,
      name: patient.name || t.patientName || "",
      patientId: t.patientId,
      treatments: [treatmentLabel],
      treatment: treatmentLabel,
      treatmentDate: dateKey,
      status: "scheduled",
      scheduledFor: admin.firestore.Timestamp.fromDate(nextDayAt(FOLLOWUP_HOUR)),
      source: "auto",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });
});

// =====================================================================
// 4) Hourly: send scheduled follow-ups whose time has come
// =====================================================================
exports.sendScheduledFollowups = onSchedule(
  { schedule: "every 1 hours", timeZone: TIMEZONE, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN] },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const due = await db
      .collection(FOLLOWUPS)
      .where("status", "==", "scheduled")
      .where("scheduledFor", "<=", now)
      .limit(50)
      .get();

    for (const docSnap of due.docs) {
      await docSnap.ref.update({ status: "sending" });
      await sendOpeningMessage({
        sid: TWILIO_ACCOUNT_SID.value(),
        token: TWILIO_AUTH_TOKEN.value(),
        ref: docSnap.ref,
        data: docSnap.data(),
      });
    }
    logger.info(`Scheduled follow-ups processed: ${due.size}`);
  }
);
