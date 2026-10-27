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
db.settings({ ignoreUndefinedProperties: true });

setGlobalOptions({ region: "europe-west1", maxInstances: 10 });

// ---- Secrets (set with: firebase functions:secrets:set NAME) ----
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const ALERT_WHATSAPP_TO = defineSecret("ALERT_WHATSAPP_TO"); // comma-separated

// ---- Config ----
// ARIA Clinic's registered WhatsApp Business sender
const WHATSAPP_FROM = "whatsapp:+972523617231";
// Approved WhatsApp templates for business-initiated messages, per follow-up stage.
// Variables: {{1}} = first name, {{2}} = treatment
// Set with: firebase functions:secrets:set WA_TEMPLATES  (JSON: {"day1":"HX..","mid":"HX..","final":"HX.."})
// Fallback: the original opening template for every stage until the new ones are approved.
const LEGACY_OPENING_TEMPLATE_SID = "HX33e8aed946f18a25c62f63edd5a0e00b";
const WA_TEMPLATES = defineSecret("WA_TEMPLATES");
function templateFor(stage) {
  try {
    const map = JSON.parse(WA_TEMPLATES.value() || "{}");
    if (stage === "alert") return map.alert || null; // no fallback for staff alerts
    return map[stage] || map.day1 || LEGACY_OPENING_TEMPLATE_SID;
  } catch { return stage === "alert" ? null : LEGACY_OPENING_TEMPLATE_SID; }
}
const WEBHOOK_URL = "https://europe-west1-aria-inventory.cloudfunctions.net/whatsappWebhook";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CONVERSATIONS = "whatsappConversations";
const FOLLOWUPS = "whatsappFollowups";
const TREATMENTS = "treatments"; // written by the inventory app
const PATIENTS = "patients";     // written by the inventory app
const MAX_HISTORY = 30;
// Follow-ups are sent at this hour (Israel time) on the protocol's day offsets
const FOLLOWUP_HOUR = 11;
const TIMEZONE = "Asia/Jerusalem";
const PROTOCOLS = "followupProtocols"; // editable from the app; defaults below are seeded on first run

// Default follow-up protocols. `match` = substrings (case-insensitive) of the inventory product name.
// Each step: day offset from treatment, stage (day1 | mid | final), and what Noa should focus on.
const DEFAULT_PROTOCOLS = [
  { id: "botox", name: "בוטוקס", match: ["dysport", "xeomin", "botox", "בוטוקס", "דיספורט", "קסאומין"],
    steps: [
      { day: 1,  stage: "day1",  focus: "תחושה באזור ההזרקה, נפיחות, שטפי דם, כאב ראש, קושי בהבעה." },
      { day: 3,  stage: "mid",   focus: "הבוטוקס מתחיל לפעול. לשאול אם מרגישה שינוי, אסימטריה, גבה/עפעף שצנחו, או הבעה שנראית לא טבעית." },
      { day: 13, stage: "final", focus: "התוצאה הסופית. שביעות רצון מהמראה, אסימטריה, ולהזכיר בחום שמחר יש ביקורת בקליניקה." },
    ] },
  { id: "radiesse", name: "רדיאס", match: ["radiesse", "רדיאס"],
    steps: [
      { day: 1,  stage: "day1",  focus: "נפיחות, שטפי דם, כאב, גושים או קשיות מתחת לעור, אדמומיות." },
      { day: 30, stage: "final", focus: "התוצאה אחרי חודש. האם רואה שיפור במתאר/עומק, גושים שנותרו, ושביעות רצון כללית." },
    ] },
  { id: "skinbooster", name: "סקין בוסטר", match: ["profhilo", "פרופילו", "skin booster", "סקין בוסטר"],
    steps: [
      { day: 1,  stage: "day1",  focus: "גבשושיות קטנות בנקודות ההזרקה (צפוי), נפיחות, שטפי דם." },
      { day: 7,  stage: "mid",   focus: "הגבשושיות אמורות להיספג. לשאול אם נותרו, ואיך העור מרגיש." },
      { day: 28, stage: "final", focus: "לחות, זוהר ומרקם העור. שביעות רצון, ולהזכיר שהטיפול השני מומלץ כחודש אחרי הראשון." },
    ] },
  { id: "pn", name: "פולינוקלאוטידים", match: ["rejuran", "vitaran", "ריג'ורן", "פולינוקלאוטיד"],
    steps: [
      { day: 1,  stage: "day1",  focus: "אדמומיות, גבשושיות בנקודות ההזרקה, רגישות." },
      { day: 7,  stage: "mid",   focus: "הגבשושיות אמורות להיספג. אדמומיות שנותרה, גרד, איך העור מרגיש." },
      { day: 21, stage: "final", focus: "מרקם ואיכות העור. שביעות רצון, ולהזכיר שסדרת הטיפולים ממשיכה בעוד כ-3 שבועות." },
    ] },
  { id: "dermapen", name: "דרמפן + אקסוזומים", match: ["dermapen", "דרמפן", "exosome", "אקסוזום", "אקזוזום", "microneedling"],
    steps: [
      { day: 1,  stage: "day1",  focus: "אדמומיות, תחושת צריבה או חום, יובש. להזכיר: בלי איפור, בלי שמש, לחות עדינה בלבד." },
      { day: 3,  stage: "mid",   focus: "קילוף קל (צפוי), אדמומיות שנותרה, פצעונים או גירוי חריג." },
      { day: 14, stage: "final", focus: "מרקם העור, זוהר, צלקות/כתמים. שביעות רצון מהתוצאה." },
    ] },
  { id: "polidocanol", name: "פולידוקנול (נימים)", match: ["polidocanol", "פולידוקנול", "aethoxysklerol", "סקלרו"],
    steps: [
      { day: 1,  stage: "day1",  focus: "כאב, נפיחות או קשיות לאורך הווריד, אדמומיות, גרבי לחץ אם הומלצו." },
      { day: 7,  stage: "mid",   focus: "שינוי צבע (חום/כהה לאורך הווריד – צפוי), גושים, גרד, פצע או כיב (לא תקין!)." },
      { day: 30, stage: "final", focus: "האם הנימים נעלמו או דהו, כתמים שנותרו, שביעות רצון. להזכיר שלעתים צריך טיפול נוסף." },
    ] },
  { id: "default", name: "טיפול כללי", match: [],
    steps: [
      { day: 1,  stage: "day1",  focus: "איך מרגישה אחרי הטיפול – כאב, נפיחות, אדמומיות, כל דבר חריג." },
    ] },
];

const STAGE_LABEL = { day1: "יום אחרי", mid: "מעקב ביניים", final: "סיכום" };

// ---- Persona / system prompt (Hebrew) ----
const SYSTEM_PROMPT = `את "נועה", העוזרת הדיגיטלית של קליניקת ARIA, קליניקה לאסתטיקה רפואית. את לא מסתירה שאת עוזרת דיגיטלית – זו זהותך, ואת מציגה אותה בטבעיות.
את מנהלת שיחת ווטסאפ עם לקוחה שעברה טיפול אסתטי בקליניקה לאחרונה. מטרת השיחה: לבדוק איך היא מרגישה אחרי הטיפול, לזהות בעיות או תופעות לוואי, ולתת תחושה שאכפת לנו.

סגנון:
- עברית טבעית, חמה, אנושית וקצרה – כמו הודעת ווטסאפ אמיתית, לא כמו טופס. משפט אחד עד שלושה. בלי רשימות, בלי כותרות.
- פנייה בלשון נקבה כברירת מחדל (רוב הלקוחות נשים). אם ברור שמדובר בגבר – עברי ללשון זכר.
- שאלה אחת בכל פעם. אל תחזרי על שאלות שכבר נענו.
- הזדהי כ"נועה, העוזרת הדיגיטלית של קליניקת ARIA". אם שואלים אם את בוט או אדם – אשרי בכנות שאת עוזרת דיגיטלית, ושד"ר עמית והצוות רואים את השיחה ומקבלים עדכון על כל דבר חריג.
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
  const stageLine = conv.stage
    ? `\nשלב המעקב: ${STAGE_LABEL[conv.stage] || conv.stage}${conv.dayOffset ? ` (יום ${conv.dayOffset} אחרי הטיפול)` : ""}.` +
      (conv.focus ? `\nמה חשוב לבדוק בשלב הזה: ${conv.focus}` : "") +
      (conv.stage !== "day1"
        ? `\nזו לא השיחה הראשונה עם הלקוחה – היא כבר מכירה אותך. אל תציגי את עצמך מחדש באריכות; התייחסי לזמן שעבר מאז הטיפול.`
        : "")
    : "";
  const context = `פרטי הלקוחה: שם – ${conv.name || "לא ידוע"}. טיפול – ${conv.treatment || "לא צוין"}. ${
    conv.treatmentDate ? "תאריך הטיפול – " + conv.treatmentDate + "." : ""
  }${stageLine}`;

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
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();

  const raw = toolUse ? toolUse.input || {} : {};
  const reply = (typeof raw.reply === "string" && raw.reply.trim()) || text;
  if (!reply) throw new Error("Claude returned an empty response");

  // Normalize so every field is always a valid Firestore value
  const risk = ["ok", "attention", "urgent"].includes(raw.risk) ? raw.risk : "ok";
  return {
    reply,
    risk,
    summary: (typeof raw.summary === "string" && raw.summary) || "ללא סיכום.",
    done: raw.done === true,
  };
}

async function sendWhatsApp(sid, token, to, body) {
  const client = twilio(sid, token);
  return client.messages.create({ from: WHATSAPP_FROM, to, body });
}

// Business-initiated message: must use an approved template
async function sendWhatsAppTemplate(sid, token, to, variables, stage = "day1") {
  const client = twilio(sid, token);
  return client.messages.create({
    from: WHATSAPP_FROM,
    to,
    contentSid: templateFor(stage),
    contentVariables: JSON.stringify(variables),
  });
}

async function alertDoctor({ sid, token, recipients, conv, result, lastClientText }) {
  const text =
    `*ARIA – מעקב אחרי טיפול: ${riskLabel[result.risk]}*\n` +
    `לקוחה: ${conv.name || "לא ידוע"}\n` +
    `טלפון: +${conv.phone}\n` +
    `טיפול: ${conv.treatment || "לא צוין"}\n` +
    (conv.stage ? `שלב: ${STAGE_LABEL[conv.stage] || conv.stage}${conv.dayOffset ? ` (יום ${conv.dayOffset})` : ""}\n` : "") +
    (conv.therapistName ? `מטפל/ת: ${conv.therapistName}\n` : "") +
    `\nסיכום: ${result.summary}\n\n` +
    `ההודעה האחרונה שלה: "${lastClientText}"`;

  // Manager(s) from the secret + the treating therapist (if known), without duplicates
  const all = [...recipients];
  if (conv.therapistPhone) all.push(conv.therapistPhone);
  const seen = new Set();
  const targets = all
    .map((raw) => {
      let to = String(raw || "").trim();
      if (!to) return null;
      if (!to.startsWith("whatsapp:")) to = "whatsapp:" + (normalizePhone(to) || to);
      return to;
    })
    .filter((to) => to && !seen.has(to) && seen.add(to));

  // WhatsApp only delivers free-form messages to people who wrote to Noa in the last 24h.
  // The approved alert template always arrives, so it is the primary channel for everyone;
  // the rich free-form version is sent in addition (it arrives when the window is open).
  const alertVars = {
    1: riskLabel[result.risk] || result.risk,
    2: conv.name || "לא ידוע",
    3: conv.treatment || "לא צוין",
    4: String(result.summary || "").slice(0, 300),
  };
  const alertTpl = templateFor("alert");
  const hasAlertTpl = Boolean(alertTpl);

  await Promise.all(
    targets.map(async (to) => {
      if (hasAlertTpl) {
        await sendWhatsAppTemplate(sid, token, to, alertVars, "alert").catch((e) =>
          logger.error("Alert template failed", { to, err: e.message })
        );
      }
      await sendWhatsApp(sid, token, to, text).catch((e) =>
        logger.error("Alert free-form failed", { to, err: e.message })
      );
    })
  );
}

// Look up a therapist's WhatsApp number by id (therapists collection, managed in the app)
async function getTherapist(therapistId) {
  if (!therapistId) return null;
  const snap = await db.collection("therapists").doc(therapistId).get();
  if (!snap.exists) return null;
  const t = snap.data();
  return { id: snap.id, name: t.name || "", phone: normalizePhone(t.phone) || "" };
}

// =====================================================================
// 1) Incoming WhatsApp messages from clients (Twilio webhook)
// =====================================================================
exports.whatsappWebhook = onRequest(
  { secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, ANTHROPIC_API_KEY, ALERT_WHATSAPP_TO, WA_TEMPLATES] },
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

  const firstName = (data.name || "").split(" ")[0] || "";
  const treatmentLabel = data.treatment ? "ה" + data.treatment : "הטיפול";
  const stage = data.stage || "day1";
  const dayOffset = data.dayOffset || 1;

  // Local copy of what the approved template says, for the conversation log
  const openings = {
    day1: `היי ${firstName} 💛 זאת נועה, העוזרת הדיגיטלית של קליניקת ARIA.\n` +
          `רציתי לבדוק איך את מרגישה אחרי ${treatmentLabel}? הכל בסדר באזור הטיפול?`,
    mid:  `היי ${firstName} 💛 זאת נועה מקליניקת ARIA. עברו כמה ימים מאז ${treatmentLabel} – איך את מרגישה? יש משהו שמטריד אותך?`,
    final: `היי ${firstName} 💛 זאת נועה מקליניקת ARIA. רציתי לשמוע איך התוצאה של ${treatmentLabel} נראית לך עכשיו – מרוצה?`,
  };
  const opening = openings[stage] || openings.day1;

  const therapist = await getTherapist(data.therapistId);
  const convRef = db.collection(CONVERSATIONS).doc(key);
  const existing = await convRef.get();
  const prev = existing.exists ? existing.data() : null;
  // Continue the same conversation thread if it is for the same treatment episode
  const sameEpisode = prev && prev.treatmentDate && prev.treatmentDate === (data.treatmentDate || "");
  const prevMessages = sameEpisode ? (prev.messages || []).slice(-MAX_HISTORY) : [];
  const protocolStep = data.protocolStepFocus || "";

  await convRef.set(
    {
      phone: key,
      whatsapp: to,
      name: data.name || prev?.name || "",
      patientId: data.patientId || prev?.patientId || "",
      treatment: data.treatment || prev?.treatment || "",
      treatmentDate: data.treatmentDate || "",
      therapistId: therapist?.id || prev?.therapistId || "",
      therapistName: therapist?.name || data.therapistName || prev?.therapistName || "",
      therapistPhone: therapist?.phone || prev?.therapistPhone || "",
      stage,
      dayOffset,
      focus: protocolStep,
      status: "open",
      handled: false,
      lastRisk: "ok",
      messages: [...prevMessages, { role: "assistant", text: opening, at: new Date().toISOString(), stage }],
      createdAt: prev?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: false }
  );

  try {
    await sendWhatsAppTemplate(sid, token, to, { 1: firstName, 2: treatmentLabel }, stage);
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
  { document: `${FOLLOWUPS}/{id}`, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
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
// "Day N after today at HH:00" in Israel time, returned as a UTC Date
function dayOffsetAt(daysAhead, hour) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce((o, p) => ((o[p.type] = p.value), o), {});
  const target = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + daysAhead, hour, 0, 0));
  const offsetMin = (() => {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "shortOffset" })
      .formatToParts(target).find((p) => p.type === "timeZoneName")?.value || "GMT+2";
    const m = s.match(/([+-])(\d+)(?::(\d+))?/);
    return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + (+m[3] || 0)) : 120;
  })();
  return new Date(target.getTime() - offsetMin * 60 * 1000);
}

// Load protocols from Firestore (seeding defaults on first run), then pick the one matching a product name
async function loadProtocols() {
  const snap = await db.collection(PROTOCOLS).get();
  if (snap.empty) {
    const batch = db.batch();
    DEFAULT_PROTOCOLS.forEach((p) => batch.set(db.collection(PROTOCOLS).doc(p.id), { ...p, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
    await batch.commit();
    return DEFAULT_PROTOCOLS;
  }
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.enabled !== false);
}

function pickProtocol(protocols, productName) {
  const name = String(productName || "").toLowerCase();
  const hit = protocols.find((p) => (p.match || []).some((m) => m && name.includes(String(m).toLowerCase())));
  return hit || protocols.find((p) => p.id === "default") || DEFAULT_PROTOCOLS[DEFAULT_PROTOCOLS.length - 1];
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
  const treatmentLabel = [t.productName, t.note].filter(Boolean).join(" – ");
  const protocols = await loadProtocols();
  const protocol = pickProtocol(protocols, t.productName);
  logger.info("Scheduling follow-ups", { patientId: t.patientId, product: t.productName, protocol: protocol.id });

  // One follow-up doc per protocol step. ID = patient_date_stage so several products on the same day merge.
  for (const step of protocol.steps || []) {
    const ref = db.collection(FOLLOWUPS).doc(`${t.patientId}_${dateKey}_${step.stage}`);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const d = snap.data();
        if (d.status !== "scheduled") return; // already sent – don't touch
        const treatments = Array.from(new Set([...(d.treatments || []), treatmentLabel]));
        const upd = { treatments, treatment: treatments.join(", ") };
        // If a second product has a longer protocol, keep the later of the two dates for this stage
        const existingDay = d.dayOffset || 0;
        if (step.day > existingDay) {
          upd.dayOffset = step.day;
          upd.scheduledFor = admin.firestore.Timestamp.fromDate(dayOffsetAt(step.day, FOLLOWUP_HOUR));
          upd.protocolStepFocus = step.focus || "";
          upd.protocolId = protocol.id;
        }
        if (!d.therapistId && t.therapistId) {
          upd.therapistId = t.therapistId;
          upd.therapistName = t.therapistName || "";
        }
        tx.update(ref, upd);
        return;
      }
      tx.set(ref, {
        phone,
        name: patient.name || t.patientName || "",
        patientId: t.patientId,
        therapistId: t.therapistId || "",
        therapistName: t.therapistName || "",
        treatments: [treatmentLabel],
        treatment: treatmentLabel,
        treatmentDate: dateKey,
        protocolId: protocol.id,
        protocolName: protocol.name || "",
        stage: step.stage,
        dayOffset: step.day,
        protocolStepFocus: step.focus || "",
        status: "scheduled",
        scheduledFor: admin.firestore.Timestamp.fromDate(dayOffsetAt(step.day, FOLLOWUP_HOUR)),
        source: "auto",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
  }
});

// =====================================================================
// 4) Hourly: send scheduled follow-ups whose time has come
// =====================================================================
exports.sendScheduledFollowups = onSchedule(
  { schedule: "every 1 hours", timeZone: TIMEZONE, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
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
