// src/components/IqImport.js — Alma IQ report import + unmatched-report assignment
import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { collection, onSnapshot, orderBy, query, limit, doc, updateDoc, deleteDoc } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { db, storage, auth } from "../firebase";

function fmt(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  return d ? d.toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "";
}

export default function IqImport({ patients }) {
  const [reports, setReports] = useState([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [assign, setAssign] = useState({});
  const fileRef = useRef(null);

  useEffect(() => {
    const q = query(collection(db, "iqReports"), orderBy("createdAt", "desc"), limit(30));
    return onSnapshot(q, (s) => setReports(s.docs.map((d) => ({ id: d.id, ...d.data() }))));
  }, []);

  async function onPick(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    setBusy(true);
    try {
      for (const file of files) {
        const path = `iq-inbox/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`;
        await uploadBytes(ref(storage, path), file, {
          contentType: "application/pdf",
          customMetadata: { uploadedBy: auth.currentUser?.email || "" },
        });
      }
      toast.success(files.length === 1 ? "הדוח הועלה – השיוך יופיע תוך דקה" : `${files.length} דוחות הועלו`);
      setOpen(true);
    } catch (err) {
      console.error(err);
      toast.error("ההעלאה נכשלה");
    } finally { setBusy(false); }
  }

  const unmatched = reports.filter((r) => r.status === "unmatched");
  const errors = reports.filter((r) => r.status === "error");
  const recent = reports.filter((r) => r.status === "matched").slice(0, 8);

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "מעלה..." : "📄 ייבוא דוח Alma IQ"}
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple onChange={onPick} style={{ display: "none" }} />
        <button type="button" className="btn btn-secondary" style={{ fontSize: "0.8rem" }} onClick={() => setOpen(!open)}>
          {open ? "הסתר" : "היסטוריה"}{unmatched.length ? ` · ${unmatched.length} ללא שיוך` : ""}
        </button>
      </div>
      <p style={{ fontSize: "0.75rem", color: "var(--text-tertiary)", marginTop: 6 }}>
        הדוח מ-Alma IQ משויך אוטומטית לפי טלפון; 5 תמונות אור-יום נכנסות לתיק המטופל/ת, וה-PDF המלא נשמר.
      </p>

      {unmatched.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <p style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--warn)", marginBottom: 6 }}>דוחות ללא שיוך ({unmatched.length})</p>
          {unmatched.map((r) => (
            <div key={r.id} style={{ borderTop: "1px solid var(--border)", padding: "8px 0", fontSize: "0.85rem" }}>
              <div>
                <b>{r.parsed?.name || "ללא שם"}</b> · {r.parsed?.phone || "ללא טלפון"} · {r.parsed?.visitDate || ""}
                {r.pdfUrl && <> · <a href={r.pdfUrl} target="_blank" rel="noreferrer">PDF</a></>}
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <select value={assign[r.id] || ""} onChange={(e) => setAssign({ ...assign, [r.id]: e.target.value })} style={{ flex: 1 }}>
                  <option value="">— שייך למטופל/ת —</option>
                  {patients.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.phone || ""}</option>)}
                </select>
                <button type="button" className="btn btn-primary" disabled={!assign[r.id]}
                  onClick={async () => { await updateDoc(doc(db, "iqReports", r.id), { assignTo: assign[r.id] }); toast.success("משייך..."); }}>
                  שייך
                </button>
                <button type="button" className="btn btn-danger" style={{ fontSize: "0.75rem" }}
                  onClick={async () => { if (window.confirm("למחוק את הדוח?")) await deleteDoc(doc(db, "iqReports", r.id)); }}>
                  מחק
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 10, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {errors.slice(0, 3).map((r) => (
            <div key={r.id} style={{ color: "var(--danger)" }}>⚠ {fmt(r.createdAt)} · {r.error}</div>
          ))}
          {recent.map((r) => (
            <div key={r.id} style={{ borderTop: "1px solid var(--border)", padding: "6px 0" }}>
              ✓ {fmt(r.createdAt)} · <b>{r.patientName}</b> · {r.images?.length || 0} תמונות · {r.source === "email" ? "מייל" : "העלאה"}
              {r.pdfUrl && <> · <a href={r.pdfUrl} target="_blank" rel="noreferrer">PDF</a></>}
            </div>
          ))}
          {!recent.length && !errors.length && <div>אין דוחות עדיין</div>}
        </div>
      )}
    </div>
  );
}
