// src/pages/LoyaltyTab.js
import React, { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";
import {
  usePatients, useTreatments, useLoyalty,
  getTier, pointsToShekels, getRenewalRule, TIERS, SHEKELS_PER_100_POINTS, referralCode, awardReferralIfDue, REFERRAL_BONUS,
} from "../hooks/useFirestore";

const DAY = 24 * 60 * 60 * 1000;
const sendLoyaltyMessage = httpsCallable(functions, "sendLoyaltyMessage");
const SEND_ERRORS = {
  "no-phone": "אין מספר טלפון בתיק המטופלת",
  "opted-out": "המטופלת ביקשה לא לקבל הודעות",
  "shabbat": "לא שולחים הודעות בשבת",
};
function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return new Date(ts);
}
function fmtDate(d) {
  return d ? d.toLocaleDateString("he-IL") : "";
}
function fmtNum(n) {
  return Number(n || 0).toLocaleString("he-IL");
}

export default function LoyaltyTab() {
  const { patients, updatePatient } = usePatients();
  const { treatments } = useTreatments();
  const { transactions, addPoints, redeemPoints } = useLoyalty();

  const [search, setSearch] = useState("");
  const [patientId, setPatientId] = useState("");
  const [shekels, setShekels] = useState("");
  const [redeem, setRedeem] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(""); // key of row being sent
  const [view, setView] = useState("points"); // points | renewals | birthdays

  // Reminders sent in the last 30 days: key = patientId|treatment
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
      toast.success(kind === "birthday" ? `ברכה ו־200 נקודות נשלחו ל${p.name} 🎂` : `תזכורת נשלחה ל${p.name} 💫`);
    } catch (err) {
      const code = (err?.message || "").replace(/^.*?:\s*/, "");
      toast.error(SEND_ERRORS[code] || SEND_ERRORS[err?.message] || "השליחה נכשלה");
      console.error(err);
    } finally { setSending(""); }
  }

  const patient = patients.find(p => p.id === patientId) || null;
  const balance = patient?.loyaltyPoints || 0;
  const totalEarned = patient?.loyaltyTotalEarned || 0;
  const tier = getTier(totalEarned);
  const nextTier = TIERS.find(t => t.min > totalEarned) || null;

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return patients.filter(p =>
      (p.name || "").toLowerCase().includes(s) || (p.phone || "").includes(s)
    ).slice(0, 8);
  }, [patients, search]);

  const patientTx = useMemo(
    () => transactions.filter(t => t.patientId === patientId).slice(0, 20),
    [transactions, patientId]
  );

  // ——— Renewal reminders ———
  const renewals = useMemo(() => {
    const latest = {}; // key: patientId|ruleLabel -> { date, rule, patientName }
    for (const t of treatments) {
      const rule = getRenewalRule(t.productName || "");
      if (!rule) continue;
      const d = toDate(t.createdAt);
      if (!d) continue;
      const key = `${t.patientId}|${rule.label}`;
      if (!latest[key] || d > latest[key].date) {
        latest[key] = { date: d, rule, patientId: t.patientId, patientName: t.patientName || "" };
      }
    }
    const now = Date.now();
    return Object.values(latest)
      .map(x => {
        const due = new Date(x.date.getTime() + x.rule.days * DAY);
        return { ...x, due, daysLeft: Math.round((due - now) / DAY) };
      })
      .filter(x => x.daysLeft <= 14)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [treatments]);

  // ——— Birthdays this month ———
  const birthdays = useMemo(() => {
    const month = new Date().getMonth();
    return patients
      .filter(p => p.dob && new Date(p.dob).getMonth() === month)
      .map(p => ({ ...p, day: new Date(p.dob).getDate() }))
      .sort((a, b) => a.day - b.day);
  }, [patients]);

  function selectPatient(p) {
    setPatientId(p.id);
    setSearch(p.name || "");
  }

  async function handleEarn(e) {
    e.preventDefault();
    const amount = parseFloat(shekels);
    if (!patient) { toast.error("בחר מטופל/ת"); return; }
    if (!amount || amount <= 0) { toast.error("הזן סכום תשלום"); return; }
    setSaving(true);
    try {
      const pts = await addPoints(patient, amount, note);
      if (await awardReferralIfDue(patient, patients)) toast.success("🤝 בונוס חבר מביא חבר: " + REFERRAL_BONUS + " נקודות לשתיהן", { duration: 5000 });
      toast.success(`נוספו ${fmtNum(pts)} נקודות ל${patient.name} ✨`);
      setShekels(""); setNote("");
    } catch (err) {
      toast.error("שגיאה בשמירה");
      console.error(err);
    } finally { setSaving(false); }
  }

  async function handleRedeem(e) {
    e.preventDefault();
    const pts = parseInt(redeem, 10);
    if (!patient) { toast.error("בחר מטופל/ת"); return; }
    if (!pts || pts <= 0 || pts % 100 !== 0) { toast.error("פדיון בכפולות של 100 נקודות"); return; }
    if (pts > balance) { toast.error("אין מספיק נקודות"); return; }
    setSaving(true);
    try {
      await redeemPoints(patient, pts, note);
      toast.success(`נפדו ${fmtNum(pts)} נקודות = ${fmtNum(pointsToShekels(pts))} ₪ הנחה`);
      setRedeem(""); setNote("");
    } catch (err) {
      toast.error("שגיאה בשמירה");
      console.error(err);
    } finally { setSaving(false); }
  }

  const subTab = (id, label) => (
    <button
      type="button"
      onClick={() => setView(id)}
      className={view === id ? "btn btn-primary" : "btn"}
      style={{ flex: 1 }}
    >{label}</button>
  );

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <h2 style={{ margin: 0 }}>💎 מועדון לקוחות</h2>

      <div style={{ display: "flex", gap: 8 }}>
        {subTab("points", "נקודות")}
        {subTab("renewals", `חידושים${renewals.length ? ` (${renewals.length})` : ""}`)}
        {subTab("birthdays", `ימי הולדת${birthdays.length ? ` (${birthdays.length})` : ""}`)}
      </div>

      {view === "points" && (
        <>
          {/* Patient search */}
          <div style={{ position: "relative" }}>
            <input
              placeholder="חיפוש מטופל/ת לפי שם או טלפון..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPatientId(""); }}
              style={{ width: "100%", padding: 12, fontSize: 16, boxSizing: "border-box" }}
            />
            {!patientId && filtered.length > 0 && (
              <div style={{
                position: "absolute", top: "100%", right: 0, left: 0, zIndex: 10,
                background: "var(--bg-card, #fff)", color: "#1f2937", border: "1px solid var(--border, #e5e7eb)",
                borderRadius: 8, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", maxHeight: 260, overflowY: "auto",
              }}>
                {filtered.map(p => {
                  const t = getTier(p.loyaltyTotalEarned || 0);
                  return (
                    <div key={p.id} onClick={() => selectPatient(p)}
                      style={{ padding: 12, cursor: "pointer", display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border, #eee)" }}>
                      <span>{p.name}</span>
                      <span style={{ color: t.color, fontWeight: 600 }}>{fmtNum(p.loyaltyPoints)} נק׳ · {t.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {patient && (
            <>
              {/* Balance card */}
              <div style={{
                padding: 20, borderRadius: 14, textAlign: "center",
                background: `linear-gradient(135deg, ${tier.color}22, ${tier.color}55)`,
                border: `2px solid ${tier.color}`,
              }}>
                <div style={{ fontSize: 14, opacity: 0.8 }}>{patient.name}</div>
                <div style={{ fontSize: 40, fontWeight: 700, margin: "4px 0" }}>{fmtNum(balance)}</div>
                <div style={{ fontSize: 14 }}>נקודות · שווי {fmtNum(pointsToShekels(balance))} ₪ הנחה</div>
                <div style={{ marginTop: 10, fontWeight: 600, color: tier.color }}>דרגת {tier.label}</div>
                <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>קוד הפניה: <b>{referralCode(patient.id)}</b>{patient.referralCount ? ` · הביאה ${patient.referralCount}` : ""}</div>
                {nextTier && (
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    עוד {fmtNum(nextTier.min - totalEarned)} נקודות לדרגת {nextTier.label}
                  </div>
                )}
              </div>

              {/* Earn */}
              <form onSubmit={handleEarn} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontWeight: 600 }}>💰 רישום תשלום</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="number" inputMode="decimal" placeholder="סכום בש״ח" value={shekels}
                    onChange={e => setShekels(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16 }} />
                  <button type="submit" className="btn btn-primary" disabled={saving}>הוסף נקודות</button>
                </div>
              </form>

              {/* Redeem */}
              <form onSubmit={handleRedeem} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <label style={{ fontWeight: 600 }}>🎁 פדיון נקודות (100 נק׳ = {SHEKELS_PER_100_POINTS} ₪)</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="number" inputMode="numeric" step="100" placeholder="כמות נקודות" value={redeem}
                    onChange={e => setRedeem(e.target.value)} style={{ flex: 1, padding: 12, fontSize: 16 }} />
                  <button type="submit" className="btn" disabled={saving || balance < 100}>פדה</button>
                </div>
              </form>

              <input placeholder="הערה (אופציונלי)" value={note} onChange={e => setNote(e.target.value)}
                style={{ padding: 12, fontSize: 16 }} />

              {/* History */}
              {patientTx.length > 0 && (
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>היסטוריה</div>
                  {patientTx.map(t => (
                    <div key={t.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border, #eee)", fontSize: 14 }}>
                      <span>{fmtDate(toDate(t.createdAt))} {t.note ? `· ${t.note}` : ""}</span>
                      <span style={{ fontWeight: 600, color: t.points >= 0 ? "#16a34a" : "#dc2626" }}>
                        {t.points >= 0 ? "+" : ""}{fmtNum(t.points)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {view === "renewals" && (
        <div>
          <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>
            מטופלות שהגיע זמנן לחידוש או שיגיע בשבועיים הקרובים
          </div>
          {renewals.length === 0 && <div style={{ opacity: 0.6 }}>אין חידושים קרובים 🎉</div>}
          {renewals.map(r => {
            const key = `${r.patientId}|${r.rule.label}`;
            const sent = recentlySent.has(key);
            const p = patients.find(x => x.id === r.patientId);
            return (
              <div key={key} style={{
                padding: 12, marginBottom: 8, borderRadius: 10,
                background: r.daysLeft < 0 ? "#fee2e2" : "#fef3c7", color: "#1f2937",
                display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{r.patientName}</div>
                  <div style={{ fontSize: 13 }}>{r.rule.label} · אחרון: {fmtDate(r.date)}</div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {r.daysLeft < 0 ? `באיחור ${Math.abs(r.daysLeft)} ימים` : r.daysLeft === 0 ? "היום" : `בעוד ${r.daysLeft} ימים`}
                  </div>
                </div>
                {sent ? (
                  <span style={{ fontSize: 13, color: "#16a34a", fontWeight: 600 }}>✓ נשלח</span>
                ) : (
                  <button type="button" className="btn btn-primary"
                    disabled={!p || sending === key}
                    onClick={() => p && handleSend("renewal", p, r.rule.label)}>
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
          <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 10 }}>ימי הולדת החודש</div>
          {birthdays.length === 0 && <div style={{ opacity: 0.6 }}>אין ימי הולדת החודש</div>}
          {birthdays.map(p => {
            const key = `${p.id}|bday`;
            const gifted = p.lastBirthdayGiftYear === new Date().getFullYear();
            return (
              <div key={p.id} style={{ padding: 12, marginBottom: 8, borderRadius: 10, background: "#fdf2f8", color: "#1f2937", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>🎂 {p.name}</div>
                  <div style={{ fontSize: 13 }}>{p.day} בחודש</div>
                </div>
                {gifted ? (
                  <span style={{ fontSize: 13, color: "#16a34a", fontWeight: 600 }}>✓ נשלח</span>
                ) : (
                  <button type="button" className="btn btn-primary"
                    disabled={sending === key}
                    onClick={() => handleSend("birthday", p, null)}>
                    {sending === key ? "..." : "ברכה + 200 נק׳"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
