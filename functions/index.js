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
// gender: "m" picks the masculine variant (map["day1_m"] etc.) when it exists
function templateFor(stage, gender) {
  try {
    const map = JSON.parse(WA_TEMPLATES.value() || "{}");
    if (stage === "alert") return map.alert || null; // no fallback for staff alerts
    if (stage === "reminder") return map.reminder || null; // no fallback for reminders
    if (stage === "day0") return null; // resolved per protocol in aftercareTemplateFor()
    if (gender === "m" && map[stage + "_m"]) return map[stage + "_m"];
    return map[stage] || map.day1 || LEGACY_OPENING_TEMPLATE_SID;
  } catch { return stage === "alert" || stage === "reminder" ? null : LEGACY_OPENING_TEMPLATE_SID; }
}
const WEBHOOK_URL = "https://europe-west1-aria-inventory.cloudfunctions.net/whatsappWebhook";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CONVERSATIONS = "whatsappConversations";
// No-reply handling: one reminder after REMINDER_AFTER_HOURS without an answer,
// then the conversation is flagged "noReply" after NOREPLY_AFTER_HOURS more.
const REMINDER_ENABLED = false;   // reminders felt like nagging – off for now
const REMINDER_AFTER_HOURS = 8;   // 11:00 → ~19:00
const NOREPLY_AFTER_HOURS = 15;   // next morning
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
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Botox-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): פנים – 4 שעות ראשונות: להישאר זקופה, לא לשכב ולא להתכופף, לא לגעת/ללחוץ, להפעיל את השרירים שטופלו (גבות, מצח), בלי איפור/כובע/משקפיים לוחצים; עד הערב בלי ספורט, סאונה, אלכוהול ומים חמים; לישון על הגב בלילה הראשון. בתי שחי – 24 שעות: בלי דאודורנט עד למחרת, בלי גילוח/שעווה 48 שעות, בלי ספורט/סאונה, בגדים רפויים. שבועיים: בלי עיסוי פנים/RF/לייזר 14 יום, בלי סאונה ושיזוף שבוע. צפוי ותקין: בליטות קטנות שנעלמות תוך שעה, אדמומיות/שטף דם זעיר, כאב ראש קל ב-48 השעות הראשונות. השפעה מיום 3–5, תוצאה מלאה ביום 14 – לא לשפוט לפני. ביקורת אחרי 14 יום להשלמת יחידות. משך: פנים 3–4 חודשים, בתי שחי 6–9. לפנות מיד: צניחת עפעף/גבה, אסימטריה בולטת אחרי יום 14, קושי בבליעה/דיבור/נשימה, ראייה כפולה, חום/אדמומיות מתפשטת.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "תחושה באזור ההזרקה, נפיחות, שטפי דם, כאב ראש, קושי בהבעה." },
      { day: 3,  stage: "mid",   focus: "הבוטוקס מתחיל לפעול. לשאול אם מרגישה שינוי, אסימטריה, גבה/עפעף שצנחו, או הבעה שנראית לא טבעית." },
      { day: 13, stage: "final", focus: "התוצאה הסופית. שביעות רצון מהמראה, אסימטריה, ולהזכיר בחום שמחר יש ביקורת בקליניקה." },
    ] },
  { id: "radiesse", name: "רדיאס", match: ["radiesse", "רדיאס"],
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Radiesse-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): 24 שעות: לא ללחוץ/לשפשף, בלי איפור על נקודות ההזרקה, קירור עדין 10 דקות כל שעה (לא קרח ישיר), לישון על הגב עם ראש מוגבה, בלי אלכוהול/ספורט/סאונה/חום, בלי אספירין ונוגדי דלקת (אקמול מותר). עיסוי: רדיאס היברידי (מיצוק) – עיסוי עדין 5 דקות, 5 פעמים ביום, 5 ימים מהערב של הטיפול; רדיאס לפיסול (לסת/סנטר/לחיים) – ללא עיסוי, לא ללחוץ ולא לשכב על האזור. אם לא בטוחה איזה סוג – לפי מה שהרופא הנחה בסיום. שבועיים: בלי ספורט מאומץ/סאונה/שמש 3 ימים, בלי טיפולי פנים/לייזר/RF/עיסוי 14 יום, בלי טיפולי שיניים 14 יום, בלי טיסה ארוכה 48 שעות, SPF 50 ושתייה מרובה. צפוי ותקין: נפיחות ואדמומיות בשיא ביום 1–2 וחולפות תוך שבוע, שטפי דם 7–14 יום, רגישות וגושיות קלה שנספגת תוך 2–4 שבועות, בפיסול הנפח הראשוני גבוה מהסופי. תוצאה אמיתית אחרי 4–12 שבועות, משך 12–18 חודשים. ביקורת אחרי 4–6 שבועות. לפנות מיד: החוורה, גוון סגול-כחלחל או דוגמת רשת בעור, כאב חזק וחריג, הפרעת ראייה או כאב בעין, חום/אדמומיות מתפשטת/הפרשה, נפיחות שמחמירה אחרי 72 שעות.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "נפיחות, שטפי דם, כאב, גושים או קשיות מתחת לעור, אדמומיות." },
      { day: 30, stage: "final", focus: "התוצאה אחרי חודש. האם רואה שיפור במתאר/עומק, גושים שנותרו, ושביעות רצון כללית." },
    ] },
  { id: "skinbooster", name: "סקין בוסטר", match: ["profhilo", "פרופילו", "skin booster", "סקין בוסטר"],
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Profhilo-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): 24 שעות: לא לגעת/ללחוץ/לעסות את נקודות ההזרקה – החומר מתפשט לבד, בלי איפור/קרמים/סרומים, שטיפה במים פושרים בלבד בלי סבון, לישון על הגב עם ראש מוגבה, בלי אלכוהול ועישון, בלי אספירין/נוגדי דלקת ללא צורך (אקמול מותר). 3 ימים: בלי ספורט מאומץ והזעה, בלי סאונה/ג'קוזי/בריכה/ים, בלי שמש ישירה וסולריום, קומפרס קר עטוף בבד ללא לחץ, לשתות לפחות 2 ליטר מים ביום; משעה 24 – SPF 50 כל בוקר. שבועיים: בלי טיפולי פנים/פילינג/לייזר/מיקרונידלינג 14 יום, בלי רטינול/חומצות/ויטמין C 5–7 ימים, בלי טיפולי שיניים 14 יום, שגרה עדינה ולחות, בלי הזרקות נוספות באותו אזור ללא תיאום. צפוי ותקין: בליטות קטנות כמו עקיצות בנקודות ההזרקה שנספגות תוך 24–72 שעות, אדמומיות ורגישות קלה יום-יומיים, לעיתים שטף דם קטן 7–10 ימים. שיפור ראשוני בלחות וזוהר אחרי כשבוע; תוצאה מלאה 4 שבועות אחרי הטיפול השני. פרוטוקול: 2 טיפולים במרווח 4 שבועות, תחזוקה כל 6 חודשים. לפנות מיד: בליטות שלא נספגות אחרי 5 ימים או גושים קשים, נפיחות/אדמומיות שמחמירות אחרי 48 שעות, חום/כאב גובר/הפרשה, שינוי צבע לבן-אפור-כחלחל, כאב חריף או טשטוש ראייה.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "גבשושיות קטנות בנקודות ההזרקה (צפוי), נפיחות, שטפי דם." },
      { day: 7,  stage: "mid",   focus: "הגבשושיות אמורות להיספג. לשאול אם נותרו, ואיך העור מרגיש." },
      { day: 28, stage: "final", focus: "לחות, זוהר ומרקם העור. שביעות רצון, ולהזכיר שהטיפול השני מומלץ כחודש אחרי הראשון." },
    ] },
  { id: "pn", name: "פולינוקלאוטידים", match: ["rejuran", "vitaran", "ריג'ורן", "פולינוקלאוטיד"],
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Rejuran-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): 24 שעות: לא לגעת/לשפשף/ללחוץ, בלי איפור/קרמים/סרומים, שטיפה במים פושרים בלבד בלי סבון, לישון עם ראש מוגבה על הגב, בלי אלכוהול ועישון, בלי אספירין/נוגדי דלקת ללא צורך רפואי. 3 ימים: בלי ספורט מאומץ והזעה, בלי סאונה/ג'קוזי/בריכה/ים, להימנע משמש ישירה וסולריום, קירור עדין עם קומפרס קר (לא ישיר), לשתות הרבה מים; מיום 2 – SPF 50 כל בוקר. שבועות קרובים: בלי טיפולי פנים/פילינג/לייזר/מיקרונידלינג, בלי רטינול/חומצות/ויטמין C 5–7 ימים, שגרה עדינה ולחות, בלי הזרקות נוספות באותו אזור ללא תיאום. צפוי ותקין: בליטות קטנות בנקודות ההזרקה שנעלמות תוך 24–72 שעות, אדמומיות ונפיחות קלה יום-יומיים, לעיתים שטפי דם קטנים שנעלמים תוך שבוע. תוצאות מתחילות אחרי 2–4 שבועות ומשתפרות בהדרגה; סדרה מלאה 3–4 טיפולים במרווח 3–4 שבועות. לפנות מיד: נפיחות/אדמומיות שמחמירות אחרי 48 שעות, חום, כאב גובר או הפרשה מוגלתית, שינוי צבע לבן או כחלחל בעור, כאב חריף או טשטוש ראייה.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "אדמומיות, גבשושיות בנקודות ההזרקה, רגישות." },
      { day: 7,  stage: "mid",   focus: "הגבשושיות אמורות להיספג. אדמומיות שנותרה, גרד, איך העור מרגיש." },
      { day: 21, stage: "final", focus: "מרקם ואיכות העור. שביעות רצון, ולהזכיר שסדרת הטיפולים ממשיכה בעוד כ-3 שבועות." },
    ] },
  { id: "dermapen", name: "דרמפן + אקסוזומים", match: ["dermapen", "דרמפן", "exosome", "אקסוזום", "אקזוזום", "microneedling"],
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Dermapen-Exosomes-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): 24 שעות (המיקרו-תעלות פתוחות): לא לשטוף את הפנים ולא לגעת – לתת לאקסוזומים להיספג, בלי איפור/קרמים/מוצרים מלבד מה שניתן במרפאה, לא להסיר שאריות סרום, להימנע מהזעה/אדים חמים/מקלחת חמה על הפנים, ציפית כרית נקייה ולישון על הגב, בלי אלכוהול ועישון. ימים 2–5: שטיפה במים פושרים וסבון עדין, לייבש בטפיחות, לחות עדינה ללא בושם כמה פעמים ביום (העור יהיה יבש), SPF 50 כל בוקר ובלי שמש ישירה, בלי ספורט מאומץ/סאונה/בריכה/ים, לא לקלף או לגרד קילופים, איפור מינרלי קל אפשרי מיום 3 אם העור רגוע. שבוע-שבועיים: בלי רטינול/חומצות/ויטמין C/הלבנה 7 ימים, בלי פילינג/לייזר/שעווה/טיפולי פנים 14 יום, בלי בוטוקס/מילוי באותו אזור ללא תיאום, המשך הגנה מהשמש (רגישות לפיגמנטציה). צפוי ותקין: אדמומיות כמו אחרי שיזוף שדועכת תוך 24–48 שעות, חום/מתיחות/יובש ביומיים הראשונים, קילוף עדין בימים 3–5, לעיתים נקודות דימום זעירות או נפיחות קלה. זוהר ראשוני אחרי כשבוע, שיפור במרקם ובקמטוטים תוך 4–6 שבועות; סדרה מלאה 3–4 טיפולים במרווח 4 שבועות. לפנות מיד: אדמומיות/נפיחות שמחמירות אחרי 48 שעות, חום, כאב גובר, חום מקומי או הפרשה מוגלתית, פצעונים/שלפוחיות, פריחה או גירוד חזק.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "אדמומיות, תחושת צריבה או חום, יובש. להזכיר: בלי איפור, בלי שמש, לחות עדינה בלבד." },
      { day: 3,  stage: "mid",   focus: "קילוף קל (צפוי), אדמומיות שנותרה, פצעונים או גירוי חריג." },
      { day: 14, stage: "final", focus: "מרקם העור, זוהר, צלקות/כתמים. שביעות רצון מהתוצאה." },
    ] },
  { id: "polidocanol", name: "פולידוקנול (נימים)", match: ["polidocanol", "פולידוקנול", "aethoxysklerol", "סקלרו"],
    guideUrl: "https://aria-clinic-inventory.netlify.app/aftercare/ARIA-Polidocanol-aftercare.pdf",
    guide: "הנחיות הקליניקה (למסור אם שואלת): גרב לחץ – ללבוש ברציפות 24 שעות כולל בלילה, לא להוריד כלל; לאחר מכן שבועיים ביום בלבד (מורידים בלילה). 24 שעות: בלי מקלחת כלל ביממה הראשונה, ללכת 15–20 דקות מיד אחרי הטיפול ומספר פעמים ביום, לא לעמוד/לשבת ברציפות זמן ממושך, להשאיר את הפדים הקטנים עד למחרת, בלי אמבטיה/סאונה/ג'קוזי, בלי ספורט מאומץ/ריצה/קפיצות. שבועיים: הליכה יומית 30 דקות, בלי ספורט מאומץ/משקולות/אופניים, להימנע מחום על הרגליים, בלי שמש ישירה או סולריום על האזור (סיכון לכתמים), בלי טיסה ארוכה מעל 4 שעות. שבועות קרובים: SPF 50 על הרגליים 4 שבועות, בלי שעווה/לייזר/טיפולים על האזור 4 שבועות, בלי אספירין/נוגדי דלקת בשבוע הראשון (אקמול מותר), נקודה כהה קטנה (דם כלוא) – לא ללחוץ, הרופא משחרר בביקורת. צפוי ותקין: אדמומיות, נפיחות קלה ותחושת עקיצות שחולפות תוך ימים, שטפי דם 1–2 שבועות, קשיות או \"חבל\" לאורך הווריד שנספג תוך שבועות, גוון חום לאורך הווריד (פיגמנטציה) שדוהה תוך 3–12 חודשים, גרד קל ביום הראשון. הנימים נעלמים בהדרגה, תוצאה מלאה 4–8 שבועות; לעיתים נדרש טיפול נוסף במרווח 4–6 שבועות. ביקורת אחרי 4–6 שבועות. לפנות מיד: כאב חזק או נפיחות/אדמומיות שמחמירות, פצע/שלפוחית/כיב באזור ההזרקה, רגל נפוחה חמה וכואבת (במיוחד בשוק), קוצר נשימה או כאב בחזה – מיון מיד, הפרעת ראייה/כאב ראש חזק/חולשה.",
    steps: [
      { day: 0,  stage: "day0",  focus: "שליחת דף ההנחיות ביום הטיפול. אם עונה – לענות קצר וחם, לוודא שקיבלה את הדף." },
      { day: 1,  stage: "day1",  focus: "כאב, נפיחות או קשיות לאורך הווריד, אדמומיות, גרבי לחץ אם הומלצו." },
      { day: 7,  stage: "mid",   focus: "שינוי צבע (חום/כהה לאורך הווריד – צפוי), גושים, גרד, פצע או כיב (לא תקין!)." },
      { day: 30, stage: "final", focus: "האם הנימים נעלמו או דהו, כתמים שנותרו, שביעות רצון. להזכיר שלעתים צריך טיפול נוסף." },
    ] },
  { id: "default", name: "טיפול כללי", match: [],
    steps: [
      { day: 1,  stage: "day1",  focus: "איך מרגישה אחרי הטיפול – כאב, נפיחות, אדמומיות, כל דבר חריג." },
    ] },
];

const STAGE_LABEL = { day0: "דף הנחיות", day1: "יום אחרי", mid: "מעקב ביניים", final: "סיכום" };

// ---- Persona / system prompt (Hebrew) ----
const SYSTEM_PROMPT = `את "נועה", העוזרת הדיגיטלית של קליניקת ARIA, קליניקה לאסתטיקה רפואית. את לא מסתירה שאת עוזרת דיגיטלית – זו זהותך, ואת מציגה אותה בטבעיות.
את מנהלת שיחת ווטסאפ עם לקוחה שעברה טיפול אסתטי בקליניקה לאחרונה. מטרת השיחה: לבדוק איך היא מרגישה אחרי הטיפול, לזהות בעיות או תופעות לוואי, ולתת תחושה שאכפת לנו.

סגנון:
- עברית טבעית, חמה, אנושית וקצרה – כמו הודעת ווטסאפ אמיתית, לא כמו טופס. משפט אחד עד שלושה. בלי רשימות, בלי כותרות.
- פנייה בלשון נקבה כברירת מחדל (רוב הלקוחות נשים). אם ברור שמדובר בגבר – עברי ללשון זכר.
- שאלה אחת בכל פעם. אל תחזרי על שאלות שכבר נענו.
- הזדהי כ"נועה, העוזרת הדיגיטלית של קליניקת ARIA". אם שואלים אם את בוט או אדם – אשרי בכנות שאת עוזרת דיגיטלית, ושד"ר עמית והצוות רואים את השיחה ומקבלים עדכון על כל דבר חריג.
- אל תתני אבחנות או הנחיות רפואיות מעבר להנחיות הכלליות שאחרי טיפול (קירור עדין, להימנע מלחץ על האזור, להימנע מחום/ספורט ב-24 שעות). אל תמליצי על תרופות.
- אם משהו לא תקין – הרגיעי, והסבירי שאת מעדכנת עכשיו את ד"ר עמית **וגם את המטפל/ת שטיפל/ה בה** (בשמו/ה, כפי שמופיע בפרטי השיחה), ושיחזרו אליה. אם המטפל הוא ד"ר עמית עצמו – ציני רק אותו. במקרה דחוף בקשי ממנה להתקשר לקליניקה מיד.
- כשברור שהכל בסדר – סיימי בחום, הזכירי שאפשר לכתוב לנו בכל שאלה, וסמני שהשיחה הסתיימה.
- אם הלקוחה מבקשת להפסיק לקבל הודעות, אומרת שזה מציק, או מבקשת שלא יפנו אליה – התנצלי בחום ובקצרה, אשרי שלא יישלחו עוד הודעות מעקב, הזכירי שאפשר תמיד לכתוב לנו, וסמני stop=true. אל תנסי לשכנע אותה להמשיך.

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
      stop: {
        type: "boolean",
        description: "true ONLY if the client asked not to receive more follow-up messages (opt-out).",
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
      (conv.guideUrl ? `\nקישור לדף ההנחיות המלא (אפשר לשלוח ללקוחה אם מבקשת): ${conv.guideUrl}` : "") +
      (conv.guide ? `\n\n${conv.guide}\nאלה ההנחיות הרשמיות של הקליניקה לטיפול הזה – אפשר למסור מהן בביטחון, בניסוח חם וקצר, רק את מה שרלוונטי לשאלה. אל תמציאי הנחיות שלא מופיעות כאן.` : "") +
      (conv.stage !== "day1"
        ? `\nזו לא השיחה הראשונה עם הלקוחה – היא כבר מכירה אותך. אל תציגי את עצמך מחדש באריכות; התייחסי לזמן שעבר מאז הטיפול.`
        : "")
    : "";
  const genderLine = conv.gender === "m" ? "המטופל הוא גבר – פנה אליו בלשון זכר (אתה, שלך, תרגיש)." : "המטופלת היא אישה – פני אליה בלשון נקבה.";
  const portalLine = "באזור האישי (aria-clinic-portal.netlify.app, כניסה עם מספר הטלפון וקוד במסרון) אפשר לראות הוראות לאחר הטיפול, תמונות לפני/אחרי, נקודות מועדון ולקבוע תור. הזכר/י את זה פעם אחת בשיחה, בטבעיות, רק כשזה רלוונטי (למשל כששואלים על הוראות או על התור הבא) – לא בכל הודעה.";
  const context = `${genderLine}\n${portalLine}\nפרטי הלקוח/ה: שם – ${conv.name || "לא ידוע"}. טיפול – ${conv.treatment || "לא צוין"}. ${
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

  const system = `${SYSTEM_PROMPT}\n\n${context}`;
  const extract = (res) => {
    const toolUse = res.content.find((c) => c.type === "tool_use");
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const raw = toolUse ? toolUse.input || {} : {};
    return { raw, reply: (typeof raw.reply === "string" && raw.reply.trim()) || text };
  };

  let res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system,
    tools: [RESPOND_TOOL],
    tool_choice: { type: "auto" },
    messages,
  });
  let { raw, reply } = extract(res);

  if (!reply) {
    // Retry once in plain text so the client never gets the technical-fallback message
    logger.warn("Claude empty response – retrying without tools", {
      stop_reason: res.stop_reason, content: JSON.stringify(res.content).slice(0, 800),
    });
    res = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 800,
      system: `${system}\n\nעני עכשיו בטקסט רגיל בלבד: ההודעה ללקוחה, בלי שום דבר נוסף.`,
      messages,
    });
    ({ raw, reply } = extract(res));
    if (reply) raw = { ...raw, risk: raw.risk || "attention", summary: raw.summary || "נועה ענתה ללא סיווג – מומלץ לבדוק את השיחה." };
  }
  if (!reply) throw new Error("Claude returned an empty response");

  // Normalize so every field is always a valid Firestore value
  const risk = ["ok", "attention", "urgent"].includes(raw.risk) ? raw.risk : "ok";
  return {
    reply,
    risk,
    summary: (typeof raw.summary === "string" && raw.summary) || "ללא סיכום.",
    done: raw.done === true,
    stop: raw.stop === true,
  };
}

async function sendWhatsApp(sid, token, to, body) {
  const client = twilio(sid, token);
  return client.messages.create({ from: WHATSAPP_FROM, to, body });
}

// Business-initiated message: must use an approved template
async function sendWhatsAppTemplate(sid, token, to, variables, stage = "day1", gender = "f") {
  const client = twilio(sid, token);
  return client.messages.create({
    from: WHATSAPP_FROM,
    to,
    contentSid: templateFor(stage, gender),
    contentVariables: JSON.stringify(variables),
  });
}

// Aftercare PDF: business-initiated → media template (variables: 1=name, 2=treatment; media URL is baked in the template per protocol? No – Twilio media templates take the URL as a variable)
// WA_TEMPLATES.day0 is a map { protocolId: "HX..." } – one media template per treatment (fixed PDF URL each)
// A protocol edited in the app may carry its own template SID (aftercareTemplateSid) – it wins.
function aftercareTemplateFor(protocolId, protocol) {
  const own = String(protocol?.aftercareTemplateSid || "").trim();
  if (/^HX[0-9a-f]{32}$/i.test(own)) return own;
  try {
    const map = JSON.parse(WA_TEMPLATES.value() || "{}");
    const d0 = map.day0;
    if (!d0) return null;
    if (typeof d0 === "string") return d0;
    return d0[protocolId] || null;
  } catch { return null; }
}
async function sendAftercareTemplate(sid, token, to, { firstName, treatmentLabel, protocolId, protocol }) {
  const client = twilio(sid, token);
  const tpl = aftercareTemplateFor(protocolId, protocol);
  if (!tpl) throw new Error(`No approved aftercare template for protocol "${protocolId}" (WA_TEMPLATES.day0)`);
  return client.messages.create({
    from: WHATSAPP_FROM, to, contentSid: tpl,
    contentVariables: JSON.stringify({ 1: firstName, 2: treatmentLabel }),
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
    (conv.therapistName && !/עמית/.test(conv.therapistName)
      ? `כשצריך לעדכן את הצוות כתבי: "אני מעדכנת את ד"ר עמית ואת ${conv.therapistName}" – את השם כתבי בדיוק כך, כולל התואר ד"ר אם הוא מופיע, ובלי להוסיף תואר אם לא.\n`
      : `כשצריך לעדכן את הצוות כתבי: "אני מעדכנת את ד"ר עמית".\n`) +
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
    conv.awaitingReply = false;
    conv.noReply = false;
    conv.lastClientAt = admin.firestore.FieldValue.serverTimestamp();
    conv.messages = conv.messages || [];
    conv.messages.push({ role: "client", text, at: new Date().toISOString() });

    // Safety net: if the conversation has no therapist, take it from the patient's latest treatment
    if (!conv.therapistPhone && conv.patientId) {
      try {
        const tSnap = await db.collection(TREATMENTS).where("patientId", "==", conv.patientId).get();
        const last = tSnap.docs.map((d) => d.data())
          .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))[0];
        const therapist = await getTherapist(last?.therapistId);
        if (therapist?.phone) {
          conv.therapistId = therapist.id;
          conv.therapistName = therapist.name;
          conv.therapistPhone = therapist.phone;
        }
      } catch (e) { logger.warn("Therapist fallback lookup failed", e.message); }
    }

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
    if (result.stop) {
      // Client opted out: close the thread and cancel every follow-up still scheduled for her
      update.optOut = true;
      update.optOutAt = admin.firestore.FieldValue.serverTimestamp();
      update.status = "closed";
      update.awaitingReply = false;
      update.lastSummary = "ביקשה להפסיק לקבל הודעות מעקב – המעקבים בוטלו. " + (result.summary || "");
      try {
        const pend = await db.collection(FOLLOWUPS).where("phone", "in", [conv.phone, "+" + conv.phone, conv.whatsapp || "whatsapp:+" + conv.phone]).get();
        const batch = db.batch();
        pend.docs.forEach((d) => { if (["scheduled", "pending"].includes(d.data().status)) batch.update(d.ref, { status: "cancelled", cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelReason: "opt-out" }); });
        await batch.commit();
        logger.info("Opt-out: cancelled scheduled follow-ups", { phone: conv.phone, count: pend.size });
      } catch (e) { logger.error("Opt-out cancel failed", e); }
    }
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
  let gender = data.gender === "m" ? "m" : data.gender === "f" ? "f" : "";
  if (!gender && data.patientId) {
    try { gender = (await db.collection(PATIENTS).doc(data.patientId).get()).data()?.gender === "m" ? "m" : "f"; } catch { gender = "f"; }
  }
  if (!gender) gender = "f";

  // Local copy of what the approved template says, for the conversation log
  const openings = gender === "m" ? {
    day0: `היי ${firstName} 💛 זאת נועה, העוזרת הדיגיטלית של קליניקת ARIA. תודה שהיית אצלנו היום! מצורף דף ההנחיות לאחר ${treatmentLabel} – כדאי לשמור אותו. מחר אכתוב לך לשמוע איך אתה מרגיש 🌿`,
    day1: `היי ${firstName} 💛 זאת נועה, העוזרת הדיגיטלית של קליניקת ARIA.\n` +
          `רציתי לבדוק איך אתה מרגיש אחרי ${treatmentLabel}? הכל בסדר באזור הטיפול?`,
    mid:  `היי ${firstName} 💛 זאת נועה מקליניקת ARIA. עברו כמה ימים מאז ${treatmentLabel} – איך אתה מרגיש? יש משהו שמטריד אותך?`,
    final: `היי ${firstName} 💛 זאת נועה מקליניקת ARIA. רציתי לשמוע איך התוצאה של ${treatmentLabel} נראית לך עכשיו – מרוצה?`,
  } : {
    day0: `היי ${firstName} 💛 זאת נועה, העוזרת הדיגיטלית של קליניקת ARIA. תודה שהיית אצלנו היום! מצורף דף ההנחיות לאחר ${treatmentLabel} – כדאי לשמור אותו. מחר אכתוב לך לשמוע איך את מרגישה 🌿`,
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
  if (prev?.optOut) {
    logger.info("Client opted out – follow-up skipped", { phone: key });
    await ref.update({ status: "skipped", error: "client opted out" });
    return;
  }
  // Continue the same conversation thread if it is for the same treatment episode
  const sameEpisode = prev && prev.treatmentDate && prev.treatmentDate === (data.treatmentDate || "");
  const prevMessages = sameEpisode ? (prev.messages || []).slice(-MAX_HISTORY) : [];
  let protocolStep = data.protocolStepFocus || "";
  let protocolGuide = data.protocolGuide || prev?.guide || "";
  let protocolId = data.protocolId || prev?.protocolId || "";
  if (!protocolGuide || !protocolStep || !protocolId) {
    // Manual follow-ups don't come through onTreatmentCreated – resolve the protocol here
    try {
      const protocols = await loadProtocols();
      const proto = pickProtocol(protocols, data.treatment || "");
      if (!protocolGuide) protocolGuide = proto.guide || "";
      if (!protocolId) protocolId = proto.id || "";
      if (!protocolStep) protocolStep = (proto.steps || []).find((st) => st.stage === stage)?.focus || (proto.steps || [])[0]?.focus || "";
    } catch (e) { logger.warn("Protocol lookup failed", e.message); }
  }

  await convRef.set(
    {
      phone: key,
      whatsapp: to,
      name: data.name || prev?.name || "",
      patientId: data.patientId || prev?.patientId || "",
      gender,
      treatment: data.treatment || prev?.treatment || "",
      treatmentDate: data.treatmentDate || "",
      therapistId: therapist?.id || prev?.therapistId || "",
      therapistName: therapist?.name || data.therapistName || prev?.therapistName || "",
      therapistPhone: therapist?.phone || prev?.therapistPhone || "",
      stage,
      dayOffset,
      focus: protocolStep,
      guide: protocolGuide,
      protocolId,
      guideUrl: data.protocolGuideUrl || prev?.guideUrl || "",
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
    if (stage === "day0") {
      let protocol = null;
      try { protocol = (await loadProtocols()).find((p) => p.id === protocolId) || null; } catch {}
      if (!aftercareTemplateFor(protocolId, protocol)) { await ref.update({ status: "skipped", error: "no aftercare template for " + protocolId }); return; }
      await sendAftercareTemplate(sid, token, to, { firstName, treatmentLabel, protocolId, protocol });
    } else {
      await sendWhatsAppTemplate(sid, token, to, { 1: firstName, 2: treatmentLabel }, stage, gender);
      await convRef.set({
        awaitingReply: true, reminderSent: false, noReply: false,
        openingSentAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
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
// Shabbat window (Israel time): no outgoing follow-ups from Friday 15:00 until Saturday 20:00.
// Anything due inside the window is pushed to Sunday at FOLLOWUP_HOUR.
const SHABBAT_START = { day: 5, hour: 15 }; // Friday
const SHABBAT_END = { day: 6, hour: 20 };   // Saturday
function israelParts(date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, weekday: "short", hour: "numeric", hour12: false })
    .formatToParts(date).reduce((o, x) => ((o[x.type] = x.value), o), {});
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { day, hour: +p.hour % 24 };
}
function isShabbat(date = new Date()) {
  const { day, hour } = israelParts(date);
  if (day === SHABBAT_START.day && hour >= SHABBAT_START.hour) return true;
  if (day === SHABBAT_END.day && hour < SHABBAT_END.hour) return true;
  return false;
}
// Returns the same instant, or Sunday FOLLOWUP_HOUR if it falls inside Shabbat
function avoidShabbat(date) {
  if (!isShabbat(date)) return date;
  const { day } = israelParts(date);
  const daysToSunday = (7 - day) % 7 || 7; // Fri → 2, Sat → 1
  return dayOffsetAt(daysToSunday, FOLLOWUP_HOUR, date);
}

function dayOffsetAt(daysAhead, hour, from = new Date()) {
  const now = from;
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
  const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // Backfill clinic guides added to the defaults after the first seed (never overwrites an edited guide)
  const batch = db.batch();
  let dirty = false;
  for (const p of list) {
    const def = DEFAULT_PROTOCOLS.find((d) => d.id === p.id);
    const upd = {};
    if (def?.guide && !p.guide) { upd.guide = def.guide; p.guide = def.guide; }
    if (def?.guideUrl && !p.guideUrl) { upd.guideUrl = def.guideUrl; p.guideUrl = def.guideUrl; }
    if (def && !(p.steps || []).some((st) => st.stage === "day0")) {
      const day0 = (def.steps || []).find((st) => st.stage === "day0");
      if (day0) { upd.steps = [day0, ...(p.steps || [])]; p.steps = upd.steps; }
    }
    if (Object.keys(upd).length) { batch.update(db.collection(PROTOCOLS).doc(p.id), upd); dirty = true; }
  }
  if (dirty) await batch.commit();
  return list.filter((p) => p.enabled !== false);
}

function pickProtocol(protocols, productName) {
  const name = String(productName || "").toLowerCase();
  // The most specific (longest) matching keyword wins, e.g. "stylage lips" beats "stylage"
  let hit = null, best = 0;
  for (const p of protocols) {
    for (const m of p.match || []) {
      const kw = String(m || "").trim().toLowerCase();
      if (kw && kw.length > best && name.includes(kw)) { hit = p; best = kw.length; }
    }
  }
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
    // day0 (aftercare PDF) is per protocol – two treatments on one day = two PDFs. Other stages merge into one conversation.
    const docId = step.stage === "day0"
      ? `${t.patientId}_${dateKey}_day0_${protocol.id}`
      : `${t.patientId}_${dateKey}_${step.stage}`;
    const ref = db.collection(FOLLOWUPS).doc(docId);
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
          upd.scheduledFor = admin.firestore.Timestamp.fromDate(avoidShabbat(dayOffsetAt(step.day, FOLLOWUP_HOUR)));
          upd.protocolStepFocus = step.focus || "";
          upd.protocolId = protocol.id;
        }
        if (!d.therapistId && t.therapistId) {
          upd.therapistId = t.therapistId;
          upd.therapistName = t.therapistName || "";
        }
        // A different protocol on the same day: give Noa both sets of clinic instructions
        if (d.protocolId && d.protocolId !== protocol.id && protocol.guide && !(d.protocolGuide || "").includes(protocol.guide)) {
          upd.protocolGuide = `${d.protocolGuide || ""}\n\n— ${protocol.name || protocol.id} —\n${protocol.guide}`.trim();
          upd.protocolGuideUrl = [d.protocolGuideUrl, protocol.guideUrl].filter(Boolean).join(" , ");
          upd.protocolName = [d.protocolName, protocol.name].filter(Boolean).join(" + ");
        }
        tx.update(ref, upd);
        return;
      }
      tx.set(ref, {
        phone,
        name: patient.name || t.patientName || "",
        gender: patient.gender || "f",
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
        protocolGuide: protocol.guide || "",
        protocolGuideUrl: protocol.guideUrl || "",
        status: "scheduled",
        scheduledFor: step.day === 0
          ? admin.firestore.Timestamp.fromDate(new Date(Date.now() + 2 * 60 * 1000))
          : admin.firestore.Timestamp.fromDate(avoidShabbat(dayOffsetAt(step.day, FOLLOWUP_HOUR))),
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
  { schedule: "0 * * * *", timeZone: TIMEZONE, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
  async () => {
    if (isShabbat()) { logger.info("Shabbat – no follow-ups sent this hour"); return; }
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
    await processNoReplies(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
  }
);

// Clients who never answered the follow-up: one reminder, then flag for the staff
async function processNoReplies(sid, token) {
  const nowMs = Date.now();
  const snap = await db.collection(CONVERSATIONS).where("awaitingReply", "==", true).limit(200).get();
  let reminders = 0, flagged = 0;
  for (const d of snap.docs) {
    const c = d.data();
    if (c.status === "closed" || c.archived) continue;
    const sentMs = c.openingSentAt?.toMillis?.() || 0;
    if (!sentMs) continue;
    const hours = (nowMs - sentMs) / 36e5;
    try {
      if (!c.reminderSent && hours >= REMINDER_AFTER_HOURS) {
        if (!REMINDER_ENABLED || !templateFor("reminder")) continue;
        const firstName = (c.name || "").split(" ")[0] || "";
        const reminderText = `היי ${firstName} 💛 זאת נועה מקליניקת ARIA. שלחתי לך קודם הודעה בנוגע ל${c.treatment || "הטיפול"} ועוד לא ראיתי תשובה – רק רוצה לוודא שהכל בסדר. אפשר לענות לי כאן בכל שעה 🙂`;
        await sendWhatsAppTemplate(sid, token, c.whatsapp || "whatsapp:+" + c.phone, { 1: firstName, 2: c.treatment || "הטיפול" }, "reminder");
        await d.ref.update({
          reminderSent: true, reminderAt: admin.firestore.FieldValue.serverTimestamp(),
          messages: admin.firestore.FieldValue.arrayUnion({ role: "assistant", text: reminderText, at: new Date().toISOString(), stage: c.stage || "" }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        reminders++;
      } else if (c.reminderSent) {
        const remMs = c.reminderAt?.toMillis?.() || sentMs;
        if ((nowMs - remMs) / 36e5 >= NOREPLY_AFTER_HOURS) {
          await d.ref.update({ awaitingReply: false, noReply: true, noReplyAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          flagged++;
        }
      }
    } catch (e) { logger.error("No-reply processing failed", { phone: c.phone, err: e.message }); }
  }
  if (reminders || flagged) logger.info(`No-reply pass: ${reminders} reminders, ${flagged} flagged`);
}


// ============================================================
// Loyalty club: renewal reminders + birthday gifts (called from the app)
// WA_TEMPLATES may override: {"loyaltyRenewal":"HX..","loyaltyBirthday":"HX.."}
// ============================================================
const { onCall: onCallLoyalty, HttpsError: HttpsErrorLoyalty } = require("firebase-functions/v2/https");
const LOYALTY_TX = "loyaltyTransactions";
const LOYALTY_RENEWAL_TEMPLATE_SID = "HX8689ca98ceb150f26dae6dfce5d2e7d4";
const LOYALTY_BIRTHDAY_TEMPLATE_SID = "HX4d278e7a7439e9fa1391f4763f280e75";
// Loyalty v2: birthdays get a greeting only (no points) – template key "loyaltyBirthdayGreeting" in WA_TEMPLATES.
// The old points-gift template (LOYALTY_BIRTHDAY_TEMPLATE_SID) is no longer used.
function loyaltyTemplateFor(kind) {
  try {
    const map = JSON.parse(WA_TEMPLATES.value() || "{}");
    if (kind === "birthday") return map.loyaltyBirthdayGreeting || null;
    return map.loyaltyRenewal || LOYALTY_RENEWAL_TEMPLATE_SID;
  } catch {
    return kind === "birthday" ? null : LOYALTY_RENEWAL_TEMPLATE_SID;
  }
}

exports.sendLoyaltyMessage = onCallLoyalty(
  { region: "europe-west1", secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
  async (request) => {
    if (!request.auth) throw new HttpsErrorLoyalty("unauthenticated", "login required");
    const { patientId, kind, treatment } = request.data || {};
    if (!patientId || !["renewal", "birthday"].includes(kind)) {
      throw new HttpsErrorLoyalty("invalid-argument", "patientId and kind are required");
    }

    const pSnap = await db.collection(PATIENTS).doc(patientId).get();
    if (!pSnap.exists) throw new HttpsErrorLoyalty("not-found", "patient not found");
    const patient = pSnap.data();
    const phone = normalizePhone(patient.phone || "");
    if (!phone) throw new HttpsErrorLoyalty("failed-precondition", "no-phone");

    // Respect opt-out recorded by the follow-up bot
    const conv = await db.collection(CONVERSATIONS).doc(phoneKey(phone)).get();
    if (conv.exists && conv.data().optOut) {
      throw new HttpsErrorLoyalty("failed-precondition", "opted-out");
    }
    if (isShabbat()) throw new HttpsErrorLoyalty("failed-precondition", "shabbat");

    const firstName = String(patient.name || "").trim().split(/\s+/)[0] || "";
    const to = "whatsapp:" + phone;
    const client = twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());

    let variables;
    if (kind === "birthday") {
      if (!loyaltyTemplateFor("birthday")) throw new HttpsErrorLoyalty("failed-precondition", "template-missing");
      await db.collection(PATIENTS).doc(patientId).update({ lastBirthdayGreetingYear: new Date().getFullYear() });
      variables = { 1: firstName };
    } else {
      const points = Number(patient.loyaltyPoints || 0).toLocaleString("he-IL");
      variables = { 1: firstName, 2: treatment || "אסתטי", 3: points };
    }

    const res = await client.messages.create({
      from: WHATSAPP_FROM, to,
      contentSid: loyaltyTemplateFor(kind),
      contentVariables: JSON.stringify(variables),
    });

    // Log the send so the app can show "sent" and avoid duplicates
    await db.collection(LOYALTY_TX).add({
      patientId, patientName: patient.name || "", type: "message", kind,
      treatment: treatment || null, points: 0, shekels: 0,
      note: kind === "birthday" ? "נשלחה ברכת יום הולדת" : `נשלחה תזכורת חידוש: ${treatment || ""}`,
      messageSid: res.sid, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (kind === "renewal") {
      await db.collection(PATIENTS).doc(patientId).update({
        lastRenewalReminderAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    logger.info("Loyalty message sent", { patientId, kind, sid: res.sid });
    return { ok: true, sid: res.sid };
  }
);


// ============================================================
// Patient portal: link the signed-in phone user to their patient record
// Writes portalUsers/{uid} = { patientId, phone } — security rules read it
// ============================================================
const { onCall: onCallPortal, HttpsError: HttpsErrorPortal } = require("firebase-functions/v2/https");
const PORTAL_USERS = "portalUsers";

function phoneDigitsIL(raw) {
  // Returns the local 9-digit form (without leading 0 / 972), or ""
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  return d.length === 9 ? d : "";
}

exports.linkPortalUser = onCallPortal({ region: "europe-west1" }, async (request) => {
  if (!request.auth) throw new HttpsErrorPortal("unauthenticated", "login required");
  const uid = request.auth.uid;
  const authPhone = phoneDigitsIL(request.auth.token.phone_number || "");
  if (!authPhone) throw new HttpsErrorPortal("failed-precondition", "no-phone");

  // Already linked?
  const existing = await db.collection(PORTAL_USERS).doc(uid).get();
  if (existing.exists && existing.data().patientId) {
    return { patientId: existing.data().patientId };
  }

  // Find the patient whose phone matches (any stored format)
  const snap = await db.collection(PATIENTS).get();
  const match = snap.docs.find(d => phoneDigitsIL(d.data().phone) === authPhone);
  if (!match) throw new HttpsErrorPortal("not-found", "no patient with this phone");

  await db.collection(PORTAL_USERS).doc(uid).set({
    patientId: match.id,
    phone: "+972" + authPhone,
    linkedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  logger.info("Portal user linked", { uid, patientId: match.id });
  return { patientId: match.id };
});



// ============================================================
// Appointment requests from the patient portal
// staff alert -> secretary WhatsApp; confirmation + day-before reminder -> patient
// WA_TEMPLATES may override: {"apptStaff":"HX..","apptConfirmed":"HX..","apptReminder":"HX.."}
// ============================================================
const { onDocumentCreated: onApptCreated, onDocumentUpdated: onApptUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule: onApptSchedule } = require("firebase-functions/v2/scheduler");
const APPOINTMENTS = "appointmentRequests";
const APPT_STAFF_WHATSAPP = ["whatsapp:+972524430344"]; // secretary
const APPT_TEMPLATES = {
  staff: "HXbbdb3c5f4c505697eda3ea9e6fe80b45",
  confirmed: "HXc9e3b582d2515ececc3e2d5b6ffd9020",
  reminder: "HXbb24f03632ee50c2dd9deb120d4eceed",
};
const HEB_DAYS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];
const SLOT_LABELS = { morning: "בבוקר", noon: "בצהריים", evening: "בערב" };

function apptTemplateFor(kind) {
  try {
    const map = JSON.parse(WA_TEMPLATES.value() || "{}");
    const key = { staff: "apptStaff", confirmed: "apptConfirmed", reminder: "apptReminder" }[kind];
    return map[key] || APPT_TEMPLATES[kind];
  } catch { return APPT_TEMPLATES[kind]; }
}
// "2026-11-12T10:30" -> { dayLabel: "ג' 12.11", time: "10:30", full: "ג' 12.11 בשעה 10:30" }
function apptLabel(confirmedAt = "") {
  const m = String(confirmedAt).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return { dayLabel: confirmedAt, time: "", full: confirmedAt };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dayLabel = `${HEB_DAYS[d.getDay()]} ${Number(m[3])}.${Number(m[2])}`;
  const time = `${m[4]}:${m[5]}`;
  return { dayLabel, time, full: `${dayLabel} בשעה ${time}` };
}
function preferredLabel(a) {
  const m = String(a.preferredDate || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const day = m ? `יום ${HEB_DAYS[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]} ${Number(m[3])}.${Number(m[2])}` : "גמיש";
  return `${day} ${SLOT_LABELS[a.slot] || ""}`.trim();
}
async function sendApptTemplate(to, kind, variables) {
  const client = twilio(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
  return client.messages.create({
    from: WHATSAPP_FROM, to, contentSid: apptTemplateFor(kind), contentVariables: JSON.stringify(variables),
  });
}

// 1) New request -> alert the secretary
exports.onAppointmentRequested = onApptCreated(
  { document: `${APPOINTMENTS}/{id}`, region: "europe-west1", secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
  async (event) => {
    const a = event.data?.data();
    if (!a) return;
    const vars = { 1: a.patientName || "", 2: a.phone || "", 3: a.treatment || "", 4: preferredLabel(a) + (a.note ? ` · ${a.note}` : "") };
    for (const to of APPT_STAFF_WHATSAPP) {
      try { await sendApptTemplate(to, "staff", vars); }
      catch (e) { logger.error("Staff appt alert failed", { to, err: String(e) }); }
    }
  }
);

// 2) Status -> confirmed: tell the patient
exports.onAppointmentUpdated = onApptUpdated(
  { document: `${APPOINTMENTS}/{id}`, region: "europe-west1", secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
  async (event) => {
    const before = event.data?.before?.data();
    const after = event.data?.after?.data();
    if (!after || before?.status === after.status || after.status !== "confirmed") return;
    if (!after.phone) return;
    const conv = await db.collection(CONVERSATIONS).doc(phoneKey(after.phone)).get();
    if (conv.exists && conv.data().optOut) { logger.info("Appt confirm skipped: opted out"); return; }
    const firstName = String(after.patientName || "").trim().split(/\s+/)[0] || "";
    try {
      const res = await sendApptTemplate("whatsapp:" + normalizePhone(after.phone), "confirmed",
        { 1: firstName, 2: after.treatment || "", 3: apptLabel(after.confirmedAt).full });
      await event.data.after.ref.update({ confirmationSid: res.sid, confirmationSentAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch (e) { logger.error("Appt confirmation failed", { id: event.params.id, err: String(e) }); }
  }
);

// 3) Every evening (after Shabbat ends on Saturday): remind tomorrow's appointments
exports.sendAppointmentReminders = onApptSchedule(
  { schedule: "30 20 * * *", timeZone: TIMEZONE, region: "europe-west1", secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, WA_TEMPLATES] },
  async () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
    const t = new Date(now); t.setDate(t.getDate() + 1);
    const tomorrow = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    const snap = await db.collection(APPOINTMENTS).where("status", "==", "confirmed").get();
    let sent = 0;
    for (const d of snap.docs) {
      const a = d.data();
      if (a.reminderSent || !String(a.confirmedAt || "").startsWith(tomorrow) || !a.phone) continue;
      const conv = await db.collection(CONVERSATIONS).doc(phoneKey(a.phone)).get();
      if (conv.exists && conv.data().optOut) continue;
      const firstName = String(a.patientName || "").trim().split(/\s+/)[0] || "";
      try {
        await sendApptTemplate("whatsapp:" + normalizePhone(a.phone), "reminder",
          { 1: firstName, 2: a.treatment || "", 3: apptLabel(a.confirmedAt).time });
        await d.ref.update({ reminderSent: true, reminderSentAt: admin.firestore.FieldValue.serverTimestamp() });
        sent++;
      } catch (e) { logger.error("Appt reminder failed", { id: d.id, err: String(e) }); }
    }
    logger.info("Appointment reminders", { tomorrow, sent });
  }
);

// ============================================================
// Loyalty v2 maintenance: one-time migration + daily points expiry
// ============================================================
const { onCall: onCallLoyaltyV2, HttpsError: HttpsErrorLoyaltyV2 } = require("firebase-functions/v2/https");
const { onSchedule: onScheduleLoyalty } = require("firebase-functions/v2/scheduler");
const LOYALTY_EXPIRY_MONTHS = 24;

// Old scheme: 1 point per ₪, 100 points = 10 ₪  →  New: 1 point = 1 ₪. So old points ÷ 10.
// Also builds loyaltySpendByYear from historic "earn" transactions and marks remaining/expiresAt on them.
exports.migrateLoyaltyV2 = onCallLoyaltyV2({ region: "europe-west1", timeoutSeconds: 540, memory: "512MiB" }, async (request) => {
  if (!request.auth) throw new HttpsErrorLoyaltyV2("unauthenticated", "login required");
  const settingsRef = db.collection("settings").doc("loyalty");
  const settings = (await settingsRef.get()).data() || {};
  if (settings.migratedV2At) return { ok: true, alreadyDone: true };

  const txSnap = await db.collection(LOYALTY_TX).orderBy("createdAt", "asc").get();
  const byPatient = {};
  for (const d of txSnap.docs) {
    const t = d.data();
    if (!t.patientId) continue;
    (byPatient[t.patientId] ||= []).push({ id: d.id, ...t });
  }
  const pSnap = await db.collection(PATIENTS).get();
  let count = 0;
  for (const pd of pSnap.docs) {
    const p = pd.data();
    const txs = byPatient[pd.id] || [];
    const hasAnything = txs.length || p.loyaltyPoints || p.loyaltyTotalEarned;
    if (!hasAnything) continue;
    const spendByYear = {};
    const batch = db.batch();
    let newEarnedTotal = 0;
    // convert earn-type transactions and record remaining (FIFO consumption of what was redeemed)
    const earnTx = txs.filter((t) => ["earn", "referral"].includes(t.type) && (t.points || 0) > 0);
    const redeemedOld = txs.filter((t) => t.type === "redeem").reduce((s, t) => s + Math.abs(t.points || 0), 0);
    let toConsume = Math.round(redeemedOld / 10);
    for (const t of earnTx) {
      const created = t.createdAt?.toDate?.() || new Date();
      if (t.shekels) { const y = String(created.getFullYear()); spendByYear[y] = (spendByYear[y] || 0) + Number(t.shekels); }
      const newPts = Math.round((t.points || 0) / 10);
      const take = Math.min(toConsume, newPts); toConsume -= take;
      const exp = new Date(created); exp.setMonth(exp.getMonth() + LOYALTY_EXPIRY_MONTHS);
      newEarnedTotal += newPts;
      batch.update(d_ref(t.id), { points: newPts, remaining: newPts - take, expiresAt: admin.firestore.Timestamp.fromDate(exp), legacyPoints: t.points });
    }
    for (const t of txs.filter((t) => t.type === "redeem")) {
      batch.update(d_ref(t.id), { points: -Math.round(Math.abs(t.points || 0) / 10), legacyPoints: t.points });
    }
    const newBalance = Math.max(0, Math.round((p.loyaltyPoints || 0) / 10));
    batch.update(pd.ref, {
      loyaltyPoints: newBalance,
      loyaltyTotalEarned: newEarnedTotal || Math.round((p.loyaltyTotalEarned || 0) / 10),
      loyaltySpendByYear: spendByYear,
      loyaltyLegacyPoints: p.loyaltyPoints || 0,
    });
    batch.set(db.collection(LOYALTY_TX).doc(), {
      patientId: pd.id, patientName: p.name || "", type: "migration", points: 0, shekels: 0,
      note: `המרה לשיטה החדשה: ${p.loyaltyPoints || 0} נק׳ ישנות → ${newBalance} נק׳`,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
    count++;
  }
  await settingsRef.set({ migratedV2At: admin.firestore.FieldValue.serverTimestamp(), migratedPatients: count }, { merge: true });
  logger.info("Loyalty v2 migration done", { count });
  return { ok: true, patients: count };
  function d_ref(id) { return db.collection(LOYALTY_TX).doc(id); }
});

// Every night: points older than 24 months that were never used expire
exports.expireLoyaltyPoints = onScheduleLoyalty({ schedule: "30 3 * * *", timeZone: TIMEZONE, region: "europe-west1" }, async () => {
  const now = admin.firestore.Timestamp.now();
  const snap = await db.collection(LOYALTY_TX).where("remaining", ">", 0).get();
  const due = snap.docs.filter((d) => d.data().expiresAt && d.data().expiresAt.toMillis() <= now.toMillis());
  const perPatient = {};
  for (const d of due) { const t = d.data(); perPatient[t.patientId] = (perPatient[t.patientId] || 0) + t.remaining; }
  const batch = db.batch();
  for (const d of due) batch.update(d.ref, { remaining: 0, expiredAt: now });
  for (const [patientId, pts] of Object.entries(perPatient)) {
    const pSnap = await db.collection(PATIENTS).doc(patientId).get();
    const name = pSnap.data()?.name || "";
    batch.update(db.collection(PATIENTS).doc(patientId), { loyaltyPoints: admin.firestore.FieldValue.increment(-pts) });
    batch.set(db.collection(LOYALTY_TX).doc(), { patientId, patientName: name, type: "expire", points: -pts, shekels: 0, note: "פקיעת תוקף (24 חודשים)", createdAt: now });
  }
  if (due.length) await batch.commit();
  logger.info("Loyalty expiry", { transactions: due.length, patients: Object.keys(perPatient).length });
});

// Alma IQ report ingestion (see iq.js)
for (const mod of [require("./iq"), require("./gmail")]) {
  for (const [k, v] of Object.entries(mod)) if (v && v.__endpoint) exports[k] = v; // only Cloud Functions, not helpers
}
