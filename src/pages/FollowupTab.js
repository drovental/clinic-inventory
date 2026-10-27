// src/pages/FollowupTab.js
import React, { useState, useEffect } from "react";
import toast from "react-hot-toast";
import { collection, onSnapshot, query, orderBy, doc, updateDoc, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";
import { usePatients, useTherapists } from "../hooks/useFirestore";

const RISK = {
  urgent:    { label: "דחוף",          badge: "badge-danger", color: "var(--danger)" },
  attention: { label: "דורש תשומת לב", badge: "badge-warn",   color: "var(--warn)" },
  ok:        { label: "תקין",          badge: "badge-ok",     color: "var(--success, #16a34a)" },
};

const STAGE_LABEL = { day0: "דף הנחיות", day1: "יום אחרי", mid: "ביניים", final: "סיכום" };

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
  const { therapists, addTherapist, deleteTherapist } = useTherapists();
  const [showTherapists, setShowTherapists] = useState(false);
  const [protocols, setProtocols] = useState([]);
  const [showProtocols, setShowProtocols] = useState(false);
  const [editProto, setEditProto] = useState(null); // {id, name, match, steps}

  useEffect(() => {
    const unsub = onSnapshot(collection(db, "followupProtocols"), snap =>
      setProtocols(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.id === "default") - (b.id === "default"))));
    return unsub;
  }, []);

  async function saveProtocol() {
    if (!editProto) return;
    const all = (editProto.steps || []).filter(st => st.day !== "" && Number(st.day) >= 0).sort((a, b) => a.day - b.day);
    const day0 = all.filter(st => Number(st.day) === 0).slice(0, 1).map(st => ({ day: 0, focus: st.focus || "", stage: "day0" }));
    const steps = all.filter(st => Number(st.day) > 0);
    if (steps.length === 0) { toast.error("צריך לפחות שלב אחד אחרי יום הטיפול"); return; }
    // stage is derived from position: day 0 = aftercare PDF, first = day1, last = final, others = mid
    const normalized = [...day0, ...steps.map((st, i) => ({
      day: Number(st.day), focus: st.focus || "",
      stage: i === 0 ? "day1" : i === steps.length - 1 ? "final" : "mid",
    }))];
    const match = (typeof editProto.match === "string" ? editProto.match.split(",") : editProto.match || [])
      .map(m => m.trim()).filter(Boolean);
    try {
      await updateDoc(doc(db, "followupProtocols", editProto.id), { name: editProto.name, match, steps: normalized, guide: editProto.guide || "", guideUrl: editProto.guideUrl || "", enabled: editProto.enabled !== false });
      toast.success("הפרוטוקול נשמר");
      setEditProto(null);
    } catch (e) { toast.error("שגיאה: " + e.message); }
  }
  const [newTherapist, setNewTherapist] = useState({ name: "", phone: "" });
  const [newTherapistId, setNewTherapistId] = useState("");

  async function handleAddTherapist() {
    if (!newTherapist.name || !newTherapist.phone) { toast.error("שם וטלפון חובה"); return; }
    try {
      await addTherapist(newTherapist);
      setNewTherapist({ name: "", phone: "" });
      toast.success("מטפל/ת נוסף/ה");
    } catch (e) { toast.error("שגיאה: " + e.message); }
  }

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

  // Re-send a scheduled/failed follow-up immediately (bypasses the hourly job)
  async function sendPendingNow(f) {
    try {
      await addDoc(collection(db, "whatsappFollowups"), {
        phone: f.phone, name: f.name || "", patientId: f.patientId || "",
        treatment: f.treatment || "", treatmentDate: f.treatmentDate || "",
        status: "pending", source: "manual-resend", createdAt: serverTimestamp(),
      });
      await updateDoc(doc(db, "whatsappFollowups", f.id), { status: "resent", resentAt: serverTimestamp() });
      toast.success("נשלח עכשיו 💬");
    } catch (e) { toast.error("שגיאה: " + e.message); }
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
        therapistId: newTherapistId || "",
        therapistName: therapists.find(t => t.id === newTherapistId)?.name || "",
        status: "pending", source: "manual", createdAt: serverTimestamp(),
      });
      toast.success("הודעת המעקב נשלחת 💬");
      setShowNew(false); setNewPatientId(""); setNewTreatment(""); setNewTherapistId("");
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
              <label>מטפל/ת (יקבל/תקבל התראות)</label>
              <select value={newTherapistId} onChange={e => setNewTherapistId(e.target.value)}>
                <option value="">— ללא —</option>
                {therapists.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
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

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowTherapists(!showTherapists)}>
          <h3 style={{ fontSize: "0.95rem", margin: 0 }}>👩‍⚕️ מטפלים ({therapists.length})</h3>
          <span style={{ color: "var(--text-tertiary)" }}>{showTherapists ? "▲" : "▼"}</span>
        </div>
        {showTherapists && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 8 }}>
              המטפל/ת שנבחר/ה בטופס הטיפול יקבל/תקבל התראה בווטסאפ כשמשהו לא תקין, בנוסף למנהל הרפואי.
            </p>
            {therapists.map(t => (
              <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span>{t.name} · <span style={{ color: "var(--text-secondary)" }}>{t.phone}</span></span>
                <button className="btn btn-danger" style={{ fontSize: "0.7rem", padding: "2px 8px" }}
                  onClick={async () => { if (window.confirm(`להסיר את ${t.name}?`)) await deleteTherapist(t.id); }}>הסר</button>
              </div>
            ))}
            <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
              <input value={newTherapist.name} onChange={e => setNewTherapist({ ...newTherapist, name: e.target.value })} placeholder="שם (למשל ד״ר גלינה)" />
              <input value={newTherapist.phone} onChange={e => setNewTherapist({ ...newTherapist, phone: e.target.value })} placeholder="ווטסאפ: 050-0000000" />
              <button className="btn btn-secondary" onClick={handleAddTherapist}>＋ הוסף מטפל/ת</button>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowProtocols(!showProtocols)}>
          <h3 style={{ fontSize: "0.95rem", margin: 0 }}>📅 פרוטוקולי מעקב ({protocols.length})</h3>
          <span style={{ color: "var(--text-tertiary)" }}>{showProtocols ? "▲" : "▼"}</span>
        </div>
        {showProtocols && (
          <div style={{ marginTop: 10 }}>
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginBottom: 8 }}>
              לכל סוג טיפול – באילו ימים נועה פונה ומה היא בודקת. הזיהוי לפי שם המוצר במלאי (מילות מפתח).
            </p>
            {protocols.map(p => (
              <div key={p.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                {editProto?.id === p.id ? (
                  <div style={{ display: "grid", gap: 8 }}>
                    <input value={editProto.name} onChange={e => setEditProto({ ...editProto, name: e.target.value })} placeholder="שם הפרוטוקול" />
                    {p.id !== "default" && (
                      <input value={Array.isArray(editProto.match) ? editProto.match.join(", ") : editProto.match}
                        onChange={e => setEditProto({ ...editProto, match: e.target.value })}
                        placeholder="מילות מפתח לזיהוי המוצר, מופרדות בפסיק" />
                    )}
                    <input value={editProto.guideUrl || ""} onChange={e => setEditProto({ ...editProto, guideUrl: e.target.value })} placeholder="קישור לדף ההנחיות (PDF) – נשלח ביום הטיפול" style={{ fontSize: "0.8rem", direction: "ltr" }} />
                    <textarea value={editProto.guide || ""} rows={5} style={{ fontSize: "0.8rem" }}
                      onChange={e => setEditProto({ ...editProto, guide: e.target.value })}
                      placeholder="הנחיות הקליניקה לטיפול הזה (מה שנועה רשאית למסור ללקוחה): שעות ראשונות, מה אסור, מה צפוי, מתי לפנות" />
                    {(editProto.steps || []).map((st, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: "0.8rem", whiteSpace: "nowrap" }}>יום</span>
                        <input type="number" min="1" value={st.day} style={{ width: 64 }}
                          onChange={e => { const steps = [...editProto.steps]; steps[i] = { ...st, day: e.target.value }; setEditProto({ ...editProto, steps }); }} />
                        <input value={st.focus || ""} placeholder="מה לבדוק בשלב הזה" style={{ flex: 1 }}
                          onChange={e => { const steps = [...editProto.steps]; steps[i] = { ...st, focus: e.target.value }; setEditProto({ ...editProto, steps }); }} />
                        <button className="btn btn-danger" style={{ fontSize: "0.7rem", padding: "2px 8px" }}
                          onClick={() => setEditProto({ ...editProto, steps: editProto.steps.filter((_, j) => j !== i) })}>✕</button>
                      </div>
                    ))}
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-secondary" style={{ fontSize: "0.8rem" }}
                        onClick={() => setEditProto({ ...editProto, steps: [...(editProto.steps || []), { day: "", focus: "" }] })}>＋ שלב</button>
                      <button className="btn btn-primary" style={{ fontSize: "0.8rem", flex: 1 }} onClick={saveProtocol}>💾 שמור</button>
                      <button className="btn btn-secondary" style={{ fontSize: "0.8rem" }} onClick={() => setEditProto(null)}>ביטול</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{p.name}{p.enabled === false ? " (כבוי)" : ""}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        {(p.steps || []).map(st => st.day === 0 ? "📄 יום הטיפול" : `יום ${st.day}`).join(" · ")}
                        {p.match?.length ? ` · ${p.match.slice(0, 3).join(", ")}${p.match.length > 3 ? "…" : ""}` : ""}
                      </div>
                    </div>
                    <button className="btn btn-secondary" style={{ fontSize: "0.7rem", padding: "3px 8px" }}
                      onClick={() => setEditProto({ ...p, steps: (p.steps || []).map(st => ({ ...st })) })}>ערוך</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {pending.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: 8, fontSize: "0.95rem" }}>מעקבים ממתינים</h3>
          {pending.map(f => (
            <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
              <span>{f.name} · {f.treatment || "טיפול"}{f.stage ? <span className="badge badge-info" style={{ marginRight: 6, fontSize: "0.65rem" }}>{STAGE_LABEL[f.stage] || f.stage}{f.dayOffset ? ` · יום ${f.dayOffset}` : ""}</span> : null}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {f.scheduledFor && <span style={{ color: "var(--text-secondary)" }}>{fmtDate(f.scheduledFor)}</span>}
                <span className={`badge ${FOLLOWUP_STATUS[f.status]?.badge || "badge-info"}`}>{FOLLOWUP_STATUS[f.status]?.label || f.status}</span>
                <button className="btn btn-secondary" style={{ fontSize: "0.7rem", padding: "3px 8px" }} onClick={() => sendPendingNow(f)}>שלח עכשיו</button>
                <button className="btn btn-danger" style={{ fontSize: "0.7rem", padding: "3px 8px" }}
                  onClick={async () => { if (window.confirm(`לבטל את המעקב של ${f.name}?`)) { await updateDoc(doc(db, "whatsappFollowups", f.id), { status: "cancelled", cancelledAt: serverTimestamp() }); toast.success("המעקב בוטל"); } }}>בטל</button>
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
                  {c.treatment || "טיפול"}{c.stage ? ` · ${STAGE_LABEL[c.stage] || c.stage}` : ""}{c.therapistName ? ` · ${c.therapistName}` : ""} · {fmtDate(c.updatedAt)}
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
