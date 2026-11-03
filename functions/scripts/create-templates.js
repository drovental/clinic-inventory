// functions/scripts/create-templates.js — creates gender-neutral WhatsApp templates in Twilio and submits them to Meta
// Usage: node create-templates.js  (needs TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in env)
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
if (!SID || !TOKEN) { console.error("Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN"); process.exit(1); }
const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
const PORTAL = "aria-clinic-portal.netlify.app";

const TEMPLATES = [
  {
    name: "loyalty_renewal_v3_he", category: "MARKETING",
    body: `היי {{1}}, כאן נועה מאריה קליניק 💫
עברו כבר כמה חודשים מטיפול ה{{2}} האחרון שלך, וזה בדיוק הזמן לשמור על התוצאה. יש לך {{3}} נקודות במועדון שמחכות לך.
לצפייה בנקודות ובטיפולים שלך: ${PORTAL}
לקביעת תור אפשר פשוט לכתוב לי כאן 🤍`,
    vars: { 1: "דנה", 2: "בוטוקס", 3: "1200" },
  },
  {
    name: "loyalty_birthday_v3_he", category: "MARKETING",
    body: `מזל טוב {{1}}! 🎂
כל הצוות באריה קליניק מאחל לך שנה מתוקה. מתנה קטנה מאיתנו: {{2}} נקודות נוספו למועדון שלך.
לצפייה בנקודות ובטיפולים שלך: ${PORTAL}
נשמח לראותך בקרוב 🤍`,
    vars: { 1: "דנה", 2: "200" },
  },
  {
    name: "appt_request_staff_v2_he", category: "UTILITY",
    body: `📅 בקשת תור חדשה מהפורטל
שם: {{1}}
טלפון: {{2}}
טיפול: {{3}}
מועד מועדף: {{4}}
לאישור או שינוי – היכנסי לאפליקציה, טאב תורים.`,
    vars: { 1: "דנה כהן", 2: "0501234567", 3: "בוטוקס", 4: "יום ג' 12.11 בבוקר" },
  },
  {
    name: "appt_confirmed_v2_he", category: "UTILITY",
    body: `היי {{1}}, כאן נועה מאריה קליניק 🤍
התור שלך ל{{2}} אושר ליום {{3}}.
אם משהו משתנה, אפשר פשוט לכתוב לי כאן. נתראה!`,
    vars: { 1: "דנה", 2: "בוטוקס", 3: "ג' 12.11 בשעה 10:30" },
  },
  {
    name: "appt_reminder_v2_he", category: "UTILITY",
    body: `היי {{1}}, תזכורת קטנה מנועה 🤍
מחר יש לך תור ל{{2}} בשעה {{3}} באריה קליניק.
אם לא מסתדר להגיע, אפשר לעדכן אותי כאן כדי שנפנה את המקום. נתראה!`,
    vars: { 1: "דנה", 2: "בוטוקס", 3: "10:30" },
  },
];

async function api(path, body) {
  const res = await fetch("https://content.twilio.com/v1" + path, {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

(async () => {
  const out = {};
  for (const t of TEMPLATES) {
    const created = await api("/Content", {
      friendly_name: t.name, language: "he", variables: t.vars, types: { "twilio/text": { body: t.body } },
    });
    await api(`/Content/${created.sid}/ApprovalRequests/whatsapp`, { name: t.name, category: t.category });
    out[t.name] = created.sid;
    console.log(`${t.name}: ${created.sid} (submitted, ${t.category})`);
  }
  console.log("\nSIDs:", JSON.stringify(out, null, 2));
})().catch(e => { console.error(e.message); process.exit(1); });
