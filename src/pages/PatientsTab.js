// src/pages/PatientsTab.js
import React, { useState } from "react";
import toast from "react-hot-toast";
import { usePatients, useTreatments } from "../hooks/useFirestore";

const EMPTY = { name: "", phone: "", dob: "", notes: "", allergies: "" };

export default function PatientsTab() {
  const { patients, loading, addPatient, deletePatient } = usePatients();
  const { treatments, deleteTreatment } = useTreatments();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = patients.filter(p =>
    p.name?.includes(search) || p.phone?.includes(search)
  );

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name) { toast.error("שם חובה"); return; }
    if (form.phone) {
      const digits = form.phone.replace(/\D/g, "");
      const ok = /^0?5\d{8}$/.test(digits) || /^9725\d{8}$/.test(digits);
      if (!ok) { toast.error("מספר הטלפון לא תקין – נייד ישראלי הוא 10 ספרות (05X-XXXXXXX)"); return; }
    }
    setSaving(true);
    try {
      await addPatient(form);
      toast.success("מטופל נוסף");
      setForm(EMPTY);
      setShowForm(false);
    } catch (e) {
      toast.error("שגיאה: " + e.message);
    } finally { setSaving(false); }
  }

  function getPatientTreatments(patientId) {
    return treatments.filter(t => t.patientId === patientId);
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}><div className="spinner" /></div>;

  return (
    <div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="חיפוש לפי שם / טלפון..." style={{ marginBottom: "0.75rem" }} />

      <button className="btn btn-primary btn-full" onClick={() => setShowForm(!showForm)} style={{ marginBottom: "1rem" }}>
        {showForm ? "✕ ביטול" : "＋ מטופל חדש"}
      </button>

      {showForm && (
        <form onSubmit={handleSubmit} className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>מטופל חדש</h3>
          <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
            <div><label>שם מלא *</label><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="שם פרטי ושם משפחה" required /></div>
            <div><label>טלפון</label><input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="050-0000000" /></div>
            <div><label>תאריך לידה</label><input type="date" value={form.dob} onChange={e => setForm({ ...form, dob: e.target.value })} /></div>
            <div><label>אלרגיות</label><input value={form.allergies} onChange={e => setForm({ ...form, allergies: e.target.value })} placeholder="פניצלין, לידוקאין..." /></div>
            <div><label>הערות רפואיות</label><textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="מידע רלוונטי..." rows={2} /></div>
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={saving}>
            {saving ? "שומר..." : "💾 שמור מטופל"}
          </button>
        </form>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">
          <span style={{ fontSize: 40, opacity: 0.3 }}>👥</span>
          <p>{search ? "לא נמצאו מטופלים" : "אין מטופלים עדיין"}</p>
        </div>
      ) : filtered.map(p => {
        const ptTreatments = getPatientTreatments(p.id);
        const isOpen = expanded === p.id;
        return (
          <div key={p.id} className="card" style={{ marginBottom: 10 }}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
              onClick={() => setExpanded(isOpen ? null : p.id)}
            >
              <div style={{
                width: 42, height: 42, borderRadius: "50%", flexShrink: 0,
                background: "var(--accent-light)", color: "var(--accent)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: "0.9rem"
              }}>
                {p.name?.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  {p.phone}{p.allergies ? ` · ⚠️ ${p.allergies}` : ""}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="badge badge-info">{ptTreatments.length} טיפולים</span>
                <span style={{ color: "var(--text-tertiary)", fontSize: 20 }}>{isOpen ? "▲" : "▼"}</span>
              </div>
            </div>

            {isOpen && (
              <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
                {p.dob && <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: 8 }}>תאריך לידה: {p.dob}</p>}
                {p.notes && <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: 8 }}>הערות: {p.notes}</p>}

                {ptTreatments.length > 0 ? (
                  <>
                    <p style={{ fontSize: "0.8rem", fontWeight: 600, marginBottom: 6 }}>היסטוריית טיפולים:</p>
                    {ptTreatments.slice(0, 5).map(t => (
                <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
                        <span>{t.productName} — {t.dose} יח'{t.note ? ` · ${t.note}` : ""}</span>
                        <span style={{ color: "var(--text-secondary)" }}>
                          {t.createdAt?.toDate?.().toLocaleDateString("he-IL") || ""}
                        </span>
                  <button
                    className="btn btn-danger"
                    style={{ fontSize: "0.7rem", padding: "2px 8px" }}
                    onClick={async () => { if (window.confirm("למחוק טיפול זה?")) await deleteTreatment(t.id); }}
                  >
                    מחק
                  </button>
                      </div>
                    ))}
                  </>
                ) : (
                  <p style={{ fontSize: "0.8rem", color: "var(--text-tertiary)" }}>אין טיפולים עדיין</p>
                )}

                <button
                  className="btn btn-danger"
                  style={{ marginTop: 10, fontSize: "0.8rem", padding: "6px 12px" }}
                  onClick={async () => {
                    if (window.confirm(`למחוק את ${p.name}?`)) {
                      await deletePatient(p.id);
                      toast.success("נמחק");
                    }
                  }}
                >
                  🗑 מחק מטופל
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
