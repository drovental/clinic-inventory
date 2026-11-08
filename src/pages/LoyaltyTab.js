// src/pages/LoyaltyTab.js — מועדון לקוחות ARIA (v2: tiers by yearly spend, 1 point = 1 ₪)
import React, { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import {
  usePatients, useTreatments, useLoyalty, useLoyaltySettings,
  getTier, nextTierInfo, yearSpend, pointsToShekels, pointsForPayment, getRenewalRule,
  TIERS, PERK_LABELS, EARN_RATE, POINTS_EXPIRY_MONTHS, REFERRAL_BONUS, REFERRALS_FOR_PLATINUM,
  referralCode, awardReferralIfDue,
} from "../hooks/useFirestore";

const DAY = 24 * 60 * 60 * 1000;
const sendLoyaltyMessage = httpsCallable(functions, "sendLoyaltyMessage");
const migrateLoyaltyV2 = httpsCallable(functions, "migrateLoyaltyV2");
const SEND_ERRORS = {
  "no-phone": "אין מספר טלפון בתיק",
  "opted-out": "המטופל/ת ביקש/ה לא לקבל הודעות",
  "shabbat": "לא שולחים הודעות בשבת",
  "template-missing": "תבנית הברכה עדיין לא הוגדרה",
};
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return new Date(ts);
}
const fmtDate = d => (d ? d.toLocaleDateString("he-IL") : "");
const fmtNum = n => Number(n || 0).toLocaleString("he-IL");
const TX_TYPE = { earn: "צבירה", redeem: "מימוש", referral: "חבר מביא חבר", expire: "פקיעת תוקף", perk: "הטבה", message: "הודעה", migration: "המרה לשיטה החדשה", adjust: "תיקון" };

export default function LoyaltyTab() {
  const { patients } = usePatients();
  const { treatments } = useTreatments();
  const { transactions, addPoints, redeemPoints, markPerk } = useLoyalty();
  const { settings, save: saveSettings } = useLoyaltySettings();

  const [search, setSearch] = useState("");
  const [patientId, setPatientId] = useState("");
  const [shekels, setShekels] = useState("");
  const [redeem, setRedeem] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState("");
  const [view, setView] = useState("points"); // points | perks | renewals | birthdays | rules
  const year = new Date().getFullYear();

  const recentlySent = useMemo(() => {
    const cutoff = Date.now() - 30 * DAY;
    const set = new Set();
    for (const t of transactions) {
      if (t.type !== "message" || t.kind !== "renewal") continue;
      const d = toDate(t.createdAt);
      if (d && d.getTime() > cutoff) set.add(`${t.patientId}|${t.treatment || ""}`);
    }
    return set;
  }, [transactions]);

  async function handleSend(kind, p, treatment) {
    const key = `${p.id}|${treatment || "bday"}`;
    setSending(key);
    try {
      await sendLoyaltyMessage({ patientId: p.id, kind, treatment: treatment || null });
      toast.success(kind === "birthday" ? `ברכת יום הולדת נשלחה ל${p.name} 🎂` : `תזכורת נשלחה ל${p.name} 💫`);
    } catch (err) {
      const code = (err?.message || "").replace(/^.*?:\s*/, "");
      toast.error(SEND_ERRORS[code] || SEND_ERRORS[err?.message] || "השליחה נכשלה");
      console.error(err);
    } finally { setSending(""); }
  }

  const patient = patients.find(p => p.id === patientId) || null;
  const balance = patient?.loyaltyPoints || 0;
  const tier = patient ? getTier(patient) : TIERS[0];
  const next = patient ? nextTierInfo(patient) : null;

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return patients.filter(p => (p.name || "").toLowerCase().includes(s) || (p.phone || "").includes(s)).slice(0, 8);
  }, [patients, search]);

  const patientTx = useMemo(() => transactions.filter(t => t.patientId === patientId).slice(0, 25), [transactions, patientId]);

  // Points that will expire in the next 60 days (oldest earned, still unused)
  const expiringSoon = useMemo(() => {
    if (!patient) return 0;
    const limit = Date.now() + 60 * DAY;
    return transactions.filter(t => t.patientId === patient.id && (t.remaining || 0) > 0 && toDate(t.expiresAt) && toDate(t.expiresAt).getTime() < limit)
      .reduce((s, t) => s + t.remaining, 0);
  }, [transactions, patient]);

  // ——— Perks owed this year ———
  const perks = useMemo(() => {
    const rows = [];
    const month = new Date().getMonth();
    for (const p of patients) {
      const t = getTier(p);
      const done = p.loyaltyPerks || {};
      if (t.key === "gold" || t.key === "platinum") {
        if (done.goldGift !== year) rows.push({ p, tier: t, perk: "goldGift" });
      }
      if (t.key === "platinum") {
        if (done.platinumFacial !== year) rows.push({ p, tier: t, perk: "platinumFacial" });
        if (p.dob && new Date(p.dob).getMonth() === month && done.platinumBirthday !== year) rows.push({ p, tier: t, perk: "platinumBirthday" });
      }
    }
    return rows.sort((a, b) => (b.tier.min - a.tier.min) || (a.p.name || "").localeCompare(b.p.name || "", "he"));
  }, [patients, year]);

  const tierCounts = useMemo(() => {
    const c = { silver: 0, gold: 0, platinum: 0 };
    for (const p of patients) c[getTier(p).key]++;
    return c;
  }, [patients]);

  // ——— Renewal reminders ———
  const renewals = useMemo(() => {
    const latest = {};
    for (const t of treatments) {
      const rule = getRenewalRule(t.productName || "");
      if (!rule) continue;
      const d = toDate(t.createdAt);
      if (!d) continue;
      const key = `${t.patientId}|${rule.label}`;
      if (!latest[key] || d > latest[key].date) latest[key] = { date: d, rule, patientId: t.patientId, patientName: t.patientName || "" };
    }
    const now = Date.now();
    return Object.values(latest)
      .map(x => { const due = new Date(x.date.getTime() + x.rule.days * DAY); return { ...x, due, daysLeft: Math.round((due - now) / DAY) }; })
      .filter(x => x.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [treatments]);

  const birthdays = useMemo(() => {
    const month = new Date().getMonth();
    return patients.filter(p => p.dob && new Date(p.dob).getMonth() === month)
      .map(p => ({ ...p, day: new Date(p.dob).getDate() })).sort((a, b) => a.day - b.day);
  }, [patients]);

  function selectPatient(p) { setPatientId(p.id); setSearch(p.name || ""); }

  async function handleEarn(e) {
    e.preventDefault();
    const amount = parseFloat(shekels);
    if (!patient) { toast.error("בחר מטופל/ת"); return; }
    if (!amount || amount <= 0) { toast.error("הזן סכום תשלום"); return; }
    setSaving(true);
    try {
      const pts = await addPoints(patient, amount, note);
      if (await awardReferralIfDue(patient, patients, settings.joinGiftPoints)) {
        toast.success(`🤝 חבר מביא חבר: ${REFERRAL_BONUS} נק׳ לממליץ/ה, ${settings.joinGiftPoints} נק׳ מתנת הצטרפות`, { duration: 5000 });
      }
      toast.success(`נוספו ${fmtNum(pts)} נקודות ל${patient.name} ✨`);
      setShekels(""); setNote("");
    } catch (err) { toast.error("שגיאה בשמירה"); console.error(err); }
    finally { setSaving(false); }
  }

  async function handleRedeem(e) {
    e.preventDefault();
    const pts = parseInt(redeem, 10);
    if (!patient) { toast.error("בחר מטופל/ת"); return; }
    if (!pts || pts <= 0) { toast.error("הזן כמות נקודות"); return; }
    if (pts > balance) { toast.error("אין מספיק נקודות"); return; }
    setSaving(true);
    try {
      await redeemPoints(patient, pts, note);
      toast.success(`מומשו ${fmtNum(pts)} נקודות = ${fmtNum(pointsToShekels(pts))} ₪ הנחה`);
      setRedeem(""); setNote("");
    } catch (err) { toast.error("שגיאה בשמירה"); console.error(err); }
    finally { setSaving(false); }
  }

  async function handleMigrate() {
    if (!window.confirm("להמיר את כל הנקודות הקיימות לשיטה החדשה? (10 נקודות ישנות = 1 נקודה חדשה; ההוצאה השנתית תחושב מההיסטוריה). פעולה חד-פעמית.")) return;
    setSaving(true);
    try {
      const r = await migrateLoyaltyV2({});
      toast.success(`הומרו ${r.data?.patients || 0} מטופלים`, { duration: 6000 });
    } catch (err) { toast.error("ההמרה נכשלה: " + (err?.message || "")); console.error(err); }
    finally { setSaving(false); }
  }

  const subTab = (id, label) => (
    <button type="button" onClick={() => setView(id)} className={view === id ? "btn btn-primary" : "btn"} style={{ flex: 1, fontSize: "0.85rem", padding: "8px 4px" }}>{label}</button>
  );
  const previewPts = pointsForPayment(parseFloat(shekels) || 0);

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ margin: 0 }}>💎 מועדון לקוחות</h2>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {subTab("points", "נקודות")}
        {subTab("perks", `הטבות${perks.length ? ` (${perks.length})` : ""}`)}
        {subTab("renewals", `חידושים${renewals.length ? ` (${renewals.length})` : ""}`)}
        {subTab("birthdays", `ימי הולדת${birthdays.length ? ` (${birthdays.length})` : ""}`)}
        {subTab("rules", "כללים")}
      </div>

      {view === "points" && (
        <>
          <div style={{ position: "relative" }}>
            <input placeholder="חיפוש מטופל/ת לפי שם או טלפון..." value={search}
              onChange={e => { setSearch(e.target.value); setPatientId(""); }}
              style={{ width: "100%", padding: 12, fontSize: 16, boxSizing: "border-box" }} />
            {!patientId && filtered.length > 0 && (
              <div style={{ position: "absolute", top: "100%", right: 0, left: 0, zIndex: 10, background: "var(--surface, #fff)", color: "var(--text-primary, #1f2937)", border: "1px solid var(--border, #e5e7eb)", borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.25)", maxHeight: 260, overflowY: "auto" }}>
                {filtered.map(p => { const t = getTier(p); return (
                  <div key={p.id} onClick={() => selectPatient(p)} style={{ padding: 12, cursor: "pointer", display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border, #eee)" }}>
                    <span>{p.name}</span>
                    <span style={{ color: t.color, fontWeight: 600 }}>{fmtNum(p.loyaltyPoints)} נק׳ · {t.label}</span>
                  </div>); })}
              </div>
            )}
          </div>

          {patient && (
            <>
              <div style={{ padding: 20, borderRadius: 14, textAlign: "center", background: `linear-gradient(135deg, ${tier.color}22, ${tier.color}55)`, border: `2px solid ${tier.color}` }}>
                <div style={{ fontSize: 14, opacity: 0.8 }}>{patient.name}</div>
                <div style={{ fontSize: 40, fontWeight: 700, margin: "4px 0" }}>{fmtNum(balance)}</div>
                <div style={{ fontSize: 14 }}>נקודות = {fmtNum(pointsToShekels(balance))} ₪ הנחה</div>
                <div style={{ marginTop: 10, fontWeight: 600, color: tier.color }}>דרגת {tier.label}{patient.tierOverride ? " (ידני)" : (patient.referralCount || 0) >= REFERRALS_FOR_PLATINUM ? " (חבר מביא חבר)" : ""}</div>
                <div style={{ fontSize: 12, marginTop: 6, opacity: 0.85 }}>הוצאה ב-{year}: {fmtNum(yearSpend(patient))} ₪ · {year - 1}: {fmtNum(yearSpend(patient, year - 1))} ₪</div>
                {next && <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>עוד {fmtNum(next.missing)} ₪ השנה לדרגת {next.tier.label}</div>}
                {expiringSoon > 0 && <div style={{ fontSize: 12, marginTop: 6, color: "var(--warn, #e0a23a)", fontWeight: 600 }}>⏳ {fmtNum(expiringSoon)} נקודות פגות תוקף ב-60 הימים הקרובים</div>}
                <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>קוד הפניה: <b>{referralCode(patient.id)}</b>{patient.referralCount ? ` · הביא/ה ${patient.referralCount}` : ""}</div>
              </div>

              <form onSubmit={handleEarn} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontWeight: 600 }}>💰 רישום תשלום <span style={{ fontWeight: 400, fontSize: 13, opacity: 0.7 }}>({EARN_RATE * 100}% נקודות)</span></label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="number" inputMode="decimal" placeholder="סכום בש״ח" value={shekels} onChange={e => setShekels(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16 }} />
                  <button type="submit" className="btn btn-primary" disabled={saving}>{previewPts ? `+${previewPts} נק׳` : "הוסף"}</button>
                </div>
              </form>

              <form onSubmit={handleRedeem} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontWeight: 600 }}>🎁 מימוש נקודות <span style={{ fontWeight: 400, fontSize: 13, opacity: 0.7 }}>(1 נק׳ = 1 ₪)</span></label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="number" inputMode="numeric" placeholder="כמות נקודות" value={redeem} onChange={e => setRedeem(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16 }} />
                  <button type="submit" className="btn" disabled={saving || balance < 1}>ממש</button>
                </div>
              </form>

              <input placeholder="הערה (אופציונלי)" value={note} onChange={e => setNote(e.target.value)} style={{ padding: 12, fontSize: 16 }} />

              {patientTx.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>היסטוריה</div>
                  {patientTx.map(t => (
                    <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border, #eee)", fontSize: 14, gap: 8 }}>
                      <span>{fmtDate(toDate(t.createdAt))} · {TX_TYPE[t.type] || t.type}{t.shekels ? ` · ${fmtNum(t.shekels)} ₪` : ""}{t.note ? ` · ${t.note}` : ""}</span>
                      {t.points ? <span style={{ fontWeight: 600, whiteSpace: "nowrap", color: t.points >= 0 ? "var(--success, #16a34a)" : "var(--danger, #dc2626)" }}>{t.points >= 0 ? "+" : ""}{fmtNum(t.points)}</span> : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {view === "perks" && (
        <div>
          <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>
            הטבות דרגה שטרם ניתנו השנה · חברות: כסף {tierCounts.silver} · זהב {tierCounts.gold} · פלטינום {tierCounts.platinum}
          </div>
          {perks.length === 0 && <div style={{ opacity: 0.6 }}>אין הטבות ממתינות 🎉</div>}
          {perks.map(({ p, tier: t, perk }) => (
            <div key={p.id + perk} style={{ padding: 12, marginBottom: 8, borderRadius: 10, background: `${t.color}22`, border: `1px solid ${t.color}66`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name} <span style={{ color: t.color, fontSize: 13 }}>· {t.label}</span></div>
                <div style={{ fontSize: 13 }}>{PERK_LABELS[perk]}{p.phone ? ` · ${p.phone}` : ""}</div>
              </div>
              <button type="button" className="btn btn-primary" style={{ fontSize: "0.8rem" }}
                onClick={async () => { await markPerk(p, perk); toast.success("סומן כניתן ✓"); }}>ניתן ✓</button>
            </div>
          ))}
        </div>
      )}

      {view === "renewals" && (
        <div>
          <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>מטופלים שהגיע זמנם לחידוש או שיגיע בשבועיים הקרובים</div>
          {renewals.length === 0 && <div style={{ opacity: 0.6 }}>אין חידושים קרובים 🎉</div>}
          {renewals.map(r => {
            const key = `${r.patientId}|${r.rule.label}`;
            const sent = recentlySent.has(key);
            const p = patients.find(x => x.id === r.patientId);
            return (
              <div key={key} style={{ padding: 12, marginBottom: 8, borderRadius: 10, background: r.daysLeft < 0 ? "var(--danger-light, #fee2e2)" : "var(--warn-light, #fef3c7)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{r.patientName}</div>
                  <div style={{ fontSize: 13 }}>{r.rule.label} · אחרון: {fmtDate(r.date)}</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{r.daysLeft < 0 ? `באיחור ${Math.abs(r.daysLeft)} ימים` : r.daysLeft === 0 ? "היום" : `בעוד ${r.daysLeft} ימים`}</div>
                </div>
                {sent ? <span style={{ fontSize: 13, color: "var(--success, #16a34a)", fontWeight: 600 }}>✓ נשלח</span> : (
                  <button type="button" className="btn btn-primary" disabled={!p || sending === key} onClick={() => p && handleSend("renewal", p, r.rule.label)}>
                    {sending === key ? "..." : "שלחי תזכורת"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === "birthdays" && (
        <div>
          <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>ימי הולדת החודש · ברכה לכולם; מתנה — לדרגת פלטינום (ראה "הטבות")</div>
          {birthdays.length === 0 && <div style={{ opacity: 0.6 }}>אין ימי הולדת החודש</div>}
          {birthdays.map(p => {
            const key = `${p.id}|bday`;
            const greeted = p.lastBirthdayGreetingYear === year || p.lastBirthdayGiftYear === year;
            const t = getTier(p);
            return (
              <div key={p.id} style={{ padding: 12, marginBottom: 8, borderRadius: 10, background: "var(--surface2, #fdf2f8)", border: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>🎂 {p.name} <span style={{ color: t.color, fontSize: 13 }}>· {t.label}</span></div>
                  <div style={{ fontSize: 13 }}>{p.day} בחודש</div>
                </div>
                {greeted ? <span style={{ fontSize: 13, color: "var(--success, #16a34a)", fontWeight: 600 }}>✓ נשלח</span> : (
                  <button type="button" className="btn btn-primary" disabled={sending === key} onClick={() => handleSend("birthday", p, null)}>
                    {sending === key ? "..." : "שלחי ברכה"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {view === "rules" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {TIERS.map(t => (
            <div key={t.key} style={{ padding: 12, borderRadius: 10, border: `1px solid ${t.color}88`, background: `${t.color}18` }}>
              <div style={{ fontWeight: 700, color: t.color }}>{t.label}{t.min ? ` · מ-${fmtNum(t.min)} ₪ בשנה` : " · דרגת הבסיס"}</div>
              <ul style={{ margin: "6px 0 0", paddingRight: 18, fontSize: 14 }}>{t.perks.map(x => <li key={x}>{x}</li>)}</ul>
            </div>
          ))}
          <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.6 }}>
            • הדרגה נקבעת לפי ההוצאה בשנה קלנדרית ונשמרת עד סוף השנה שאחריה; מי שלא הגיע/ה לסף — יורד/ת.<br />
            • הנקודות תקפות {POINTS_EXPIRY_MONTHS} חודשים מיום הצבירה (הישנות נפדות ראשונות).<br />
            • חבר מביא חבר: {REFERRAL_BONUS} נק׳ לממליץ/ה בתשלום הראשון של המופנה; {REFERRALS_FOR_PLATINUM} הפניות מוצלחות = פלטינום.<br />
            • התקנון המלא: <a href="/takanon.html" target="_blank" rel="noreferrer">takanon.html</a>
          </div>
          <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 14 }}>מתנת הצטרפות למופנה (נקודות):</label>
            <input type="number" min="0" value={settings.joinGiftPoints} onChange={e => saveSettings({ joinGiftPoints: Math.max(0, parseInt(e.target.value || "0", 10)) })} style={{ width: 90, padding: 8 }} />
          </div>
          {!settings.migratedV2At && (
            <div className="card" style={{ border: "1px solid var(--warn)" }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>מעבר לשיטה החדשה</div>
              <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 8 }}>ממיר יתרות קיימות (10 נק׳ ישנות = 1 נק׳ חדשה = 1 ₪) ומחשב את ההוצאה השנתית מההיסטוריה. חד-פעמי.</div>
              <button type="button" className="btn btn-primary" disabled={saving} onClick={handleMigrate}>בצע המרה</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
