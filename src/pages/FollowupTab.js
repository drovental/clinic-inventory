// src/pages/FollowupTab.js
import React, { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { collection, onSnapshot, query, orderBy, doc, updateDoc, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { usePatients } from "../hooks/useFirestore";

const RISK = {
  urgent:    { label: "דחוף",          badge: "badge-danger", color: "var(--danger)" },
  attention: { label: "דורש תשומת לב", badge: "badge-warn",   color: "var(--warn)" },
  ok:        { label: "תקין",          badge: "badge-ok",     color: "var(--success, #16a34a)" },
};

const FOLLOWUP_STATUS = {
  scheduled: { label: "מתוזמן",   badge: "badge-info" },
  sending:   { label: "נשלח...",  badge: "badge-info" },
  sent:      { label: "נשלח",     badge: "badge-ok" },
  failed:    { label: "נכשל",     badge: "badge-danger" },
};

function fmtDate(ts) {
  const d = ts?.toDate?.() || (ts ? new Date(ts) : null);
  if (!d || isNaN(d)) return "";
  return d.toLocaleString("he-IL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function FollowupTab() {
  const [conversations, setConversations] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("needsAttention"); // needsAttention | open | all
  const [expanded, setExpanded] = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [newPatientId, setNewPatientId] = useState("");
  const [newTreatment, setNewTreatment] = useState("");
  const [sending, setSending] = useState(false);
  const { patients } = usePatients();

  useEffect(() => {
    const q = query(collection(db, "whatsappConversations"), orderBy("updatedAt", "desc"));
    const unsub = onSnapshot(q, snap => {
      setConversations(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const q = query(collection(db, "whatsappFollowups"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, snap => setFollowups(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return unsub;
  }, []);

  const needsAttention = conversations.filter(c => c.lastRisk !== "ok" && !c.handled);
  const filtered = conversations.filter(c => {
    if (filter === "needsAttention") return c.lastRisk !== "ok" && !c.handled;
    if (filter === "open") return c.status === "open";
    return true;
  });
  const pending = followups.filter(f => f.status === "scheduled" || f.status === "failed");

  async function markHandled(c, handled) {
    await updateDoc(doc(db, "whatsappConversations", c.id), { handled, handledAt: handled ? serverTimestamp() : null });
    toast.success(handled ? "סומן כטופל" : "הוחזר לרשימה");
  }

  async function sendNow() {
    const p = patients.find(x => x.id === newPatientId);
    if (!p) { toast.error("בחר מטופלת"); return; }
    if (!p.phone) { toast.error("למטופלת אין מספר טלפון"); return; }
    setSending(true);
    try {
      await addDoc(collection(db, "whatsappFollowups"), {
        phone: p.phone, name: p.name, patientId: p.id,
        treatment: newTreatment, treatmentDate: new Date().toISOString().slice(0, 10),
        status: "pending", source: "manual", createdAt: serverTimestamp(),
      });
      toast.success("הודעת המעקב נשלחת 💬");
      setShowNew(false); setNewPatientId(""); setNewTreatment("");
    } catch (e) { toast.error("שגיאה: " + e.message); }
    finally { setSending(false); }
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}><div className="spinner" /></div>;

  return (
    <div>
      {needsAttention.length > 0 && (
        <div style={{ background: "var(--warn-light)", border: "1px solid #fcd34d", borderRadius: "var(--radius-md)", padding: "10px 14px", marginBottom: "1rem", fontSize: "0.875rem", color: "var(--warn)", display: "flex", gap: 8 }}>
          <span style={{ fontSize: 18 }}>⚠️</span>
          <div><strong>{needsAttention.length} שיחות</strong> דורשות את תשומת לבך</div>
        </div>
      )}

      <button className="btn btn-primary btn-full" onClick={() => setShowNew(!showNew)} style={{ marginBottom: "1rem" }}>
        {showNew ? "✕ ביטול" : "💬 שלח מעקב עכשיו"}
      </button>

      {showNew && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: 12 }}>מעקב ידני</h3>
          <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
            <div>
              <label>מטופלת</label>
              <select value={newPatientId} onChange={e => setNewPatientId(e.target.value)}>
                <option value="">— בחר —</option>
                {patients.filter(p => p.phone).map(p => <option key={p.id} value={p.id}>{p.name} · {p.phone}</option>)}
              </select>
            </div>
            <div>
              <label>טיפול (לניסוח ההודעה)</label>
              <input value={newTreatment} onChange={e => setNewTreatment(e.target.value)} placeholder="בוטוקס מצח, שפתיים..." />
            </div>
          </div>
          <button className="btn btn-primary btn-full" onClick={sendNow} disabled={sending || !newPatientId}>
            {sending ? "שולח..." : "שלח הודעת פתיחה"}
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: 8, fontSize: "0.95rem" }}>מעקבים ממתינים</h3>
          {pending.map(f => (
            <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span>{f.name} · {f.treatment || "טיפול"}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {f.scheduledFor && <span style={{ color: "var(--text-secondary)" }}>{fmtDate(f.scheduledFor)}</span>}
                <span className={`badge ${FOLLOWUP_STATUS[f.status]?.badge || "badge-info"}`}>{FOLLOWUP_STATUS[f.status]?.label || f.status}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: "0.75rem" }}>
        {[["needsAttention", `לטיפול (${needsAttention.length})`], ["open", "פתוחות"], ["all", "הכל"]].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)} className={`btn ${filter === id ? "btn-primary" : "btn-secondary"}`} style={{ flex: 1, fontSize: "0.8rem", padding: "8px 4px" }}>
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <span style={{ fontSize: 40, opacity: 0.3 }}>💬</span>
          <p>{filter === "needsAttention" ? "אין שיחות שדורשות טיפול 🎉" : "אין שיחות עדיין"}</p>
        </div>
      ) : filtered.map(c => {
        const risk = RISK[c.lastRisk] || RISK.ok;
        const isOpen = expanded === c.id;
        return (
          <div key={c.id} className="card" style={{ marginBottom: 10, borderRight: `4px solid ${risk.color}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }} onClick={() => setExpanded(isOpen ? null : c.id)}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{c.name || "+" + c.phone}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  {c.treatment || "טיפול"} · {fmtDate(c.updatedAt)}
                </div>
                {c.lastSummary && <div style={{ fontSize: "0.8rem", marginTop: 4 }}>{c.lastSummary}</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                <span className={`badge ${risk.badge}`}>{risk.label}</span>
                {c.handled && <span className="badge badge-ok" style={{ fontSize: "0.65rem" }}>טופל</span>}
                {c.status === "closed" && <span style={{ fontSize: "0.7rem", color: "var(--text-tertiary)" }}>הסתיימה</span>}
              </div>
              <span style={{ color: "var(--text-tertiary)", fontSize: 20 }}>{isOpen ? "▲" : "▼"}</span>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
                  {(c.messages || []).map((m, i) => (
                    <div key={i} style={{
                      alignSelf: m.role === "client" ? "flex-start" : "flex-end",
                      background: m.role === "client" ? "rgba(212,175,116,0.18)" : "#16204a",
                      color: "#f3f1ea",
                      border: "1px solid rgba(212,175,116,0.25)",
                      borderRadius: 12, padding: "8px 12px", maxWidth: "85%", fontSize: "0.85rem",
                    }}>
                      <div style={{ fontSize: "0.65rem", color: "#b9c0d6", marginBottom: 2 }}>
                        {m.role === "client" ? c.name || "לקוחה" : "נועה"} · {fmtDate(m.at)}
                      </div>
                      {m.text}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <a className="btn btn-secondary" style={{ flex: 1, textAlign: "center", textDecoration: "none" }} href={`https://wa.me/${c.phone}`} target="_blank" rel="noreferrer">
                    📱 פתח בווטסאפ
                  </a>
                  <a className="btn btn-secondary" style={{ flex: 1, textAlign: "center", textDecoration: "none" }} href={`tel:+${c.phone}`}>
                    📞 התקשר
                  </a>
                  {c.lastRisk !== "ok" && (
                    <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => markHandled(c, !c.handled)}>
                      {c.handled ? "↩ החזר" : "✓ טופל"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
