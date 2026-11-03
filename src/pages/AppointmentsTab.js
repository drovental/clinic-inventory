// src/pages/AppointmentsTab.js — appointment requests from the patient portal
import React, { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { collection, doc, onSnapshot, orderBy, query, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

const HEB_DAYS = ["א'", "ב'", "ג'", "ד'", "ה'", "ו'", "ש'"];
const SLOT = { morning: "בוקר", noon: "צהריים", evening: "ערב" };
const STATUS = {
  pending: { label: "ממתין", color: "#fbbf24" },
  confirmed: { label: "אושר", color: "#4ade80" },
  declined: { label: "נדחה", color: "#f87171" },
  cancelled: { label: "בוטל", color: "#9ca3af" },
};
function dayLabel(ymd = "") {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "גמיש";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${HEB_DAYS[d.getDay()]} ${Number(m[3])}.${Number(m[2])}`;
}
function fullLabel(dt = "") {
  const m = String(dt).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${dayLabel(dt)} בשעה ${m[4]}:${m[5]}` : dt;
}
function toDate(ts) { return ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null; }

export default function AppointmentsTab() {
  const [items, setItems] = useState([]);
  const [confirming, setConfirming] = useState(null); // id
  const [when, setWhen] = useState("");
  const [filter, setFilter] = useState("pending");

  useEffect(() => {
    const q = query(collection(db, "appointmentRequests"), orderBy("createdAt", "desc"));
    return onSnapshot(q, s => setItems(s.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, []);

  const counts = useMemo(() => items.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {}), [items]);
  const shown = useMemo(() => {
    if (filter === "all") return items;
    if (filter === "confirmed") return items.filter(a => a.status === "confirmed").sort((a, b) => String(a.confirmedAt).localeCompare(String(b.confirmedAt)));
    return items.filter(a => a.status === filter);
  }, [items, filter]);

  async function confirm(a) {
    if (!when) { toast.error("בחר תאריך ושעה"); return; }
    try {
      await updateDoc(doc(db, "appointmentRequests", a.id), { status: "confirmed", confirmedAt: when, decidedAt: serverTimestamp() });
      toast.success(`אושר · נועה שולחת אישור ל${a.patientName} 🤍`);
      setConfirming(null); setWhen("");
    } catch (e) { console.error(e); toast.error("שגיאה"); }
  }
  async function decline(a) {
    const reason = window.prompt("סיבה (תוצג למטופלת בפורטל):", "לא נמצא מועד פנוי, ניצור קשר");
    if (reason === null) return;
    try {
      await updateDoc(doc(db, "appointmentRequests", a.id), { status: "declined", declineReason: reason, decidedAt: serverTimestamp() });
      toast("הבקשה נדחתה. שימו לב: המטופלת לא מקבלת הודעה אוטומטית – כדאי להתקשר.", { duration: 6000 });
    } catch (e) { console.error(e); toast.error("שגיאה"); }
  }

  const chip = (id, label) => (
    <button type="button" onClick={() => setFilter(id)} className={filter === id ? "btn btn-primary" : "btn"} style={{ flex: 1 }}>
      {label}{counts[id] ? ` (${counts[id]})` : ""}
    </button>
  );

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ margin: 0 }}>📅 בקשות תור</h2>
      <div style={{ display: "flex", gap: 6 }}>
        {chip("pending", "ממתינות")}{chip("confirmed", "מאושרות")}{chip("all", "הכל")}
      </div>

      {shown.length === 0 && <div style={{ opacity: 0.6 }}>אין בקשות</div>}
      {shown.map(a => {
        const st = STATUS[a.status] || STATUS.pending;
        return (
          <div key={a.id} className="card" style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div>
                <div style={{ fontWeight: 700 }}>{a.patientName}</div>
                <div style={{ fontSize: 13, opacity: 0.8 }}>{a.phone}</div>
              </div>
              <span style={{ background: st.color, color: "#111", padding: "3px 10px", borderRadius: 8, fontSize: 12, fontWeight: 700 }}>{st.label}</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 14 }}>
              <div><b>{a.treatment}</b></div>
              <div>מועדף: {dayLabel(a.preferredDate)} {SLOT[a.slot] || ""}</div>
              {a.note && <div style={{ opacity: 0.8 }}>הערה: {a.note}</div>}
              {a.status === "confirmed" && <div style={{ color: "#4ade80", fontWeight: 600 }}>נקבע: {fullLabel(a.confirmedAt)}{a.reminderSent ? " · תזכורת נשלחה" : ""}</div>}
              {a.status === "declined" && a.declineReason && <div style={{ opacity: 0.8 }}>סיבה: {a.declineReason}</div>}
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>התקבל {toDate(a.createdAt)?.toLocaleString("he-IL") || ""}</div>
            </div>

            {a.status === "pending" && (
              confirming === a.id ? (
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} style={{ flex: 1, padding: 10, fontSize: 15 }} />
                  <button type="button" className="btn btn-primary" onClick={() => confirm(a)}>אשר ושלח</button>
                  <button type="button" className="btn" onClick={() => { setConfirming(null); setWhen(""); }}>ביטול</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={() => setConfirming(a.id)}>✓ שובץ ביומן</button>
                  <button type="button" className="btn" onClick={() => decline(a)}>דחייה</button>
                </div>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
