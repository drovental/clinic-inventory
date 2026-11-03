// src/components/PatientPhotos.js — before/after photos inside a patient card
import React, { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { collection, addDoc, deleteDoc, doc, onSnapshot, orderBy, query, where, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { db, storage } from "../firebase";

const TAGS = { before: "לפני", after: "אחרי" };

// Resize on the device so uploads stay ~200KB instead of 4MB
async function compress(file, maxSide = 1400, quality = 0.82) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(res, "image/jpeg", quality));
}

function fmt(ts) {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  return d ? d.toLocaleDateString("he-IL") : "";
}

export default function PatientPhotos({ patient }) {
  const [photos, setPhotos] = useState([]);
  const [tag, setTag] = useState("before");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const fileRef = useRef(null);

  useEffect(() => {
    const q = query(collection(db, "patientPhotos"), where("patientId", "==", patient.id), orderBy("createdAt", "desc"));
    return onSnapshot(q, s => setPhotos(s.docs.map(d => ({ id: d.id, ...d.data() }))));
  }, [patient.id]);

  async function onPick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const blob = await compress(file);
      const path = `patients/${patient.id}/${Date.now()}.jpg`;
      const r = ref(storage, path);
      await uploadBytes(r, blob, { contentType: "image/jpeg" });
      const url = await getDownloadURL(r);
      await addDoc(collection(db, "patientPhotos"), {
        patientId: patient.id, patientName: patient.name || "",
        path, url, tag, area: area.trim(), createdAt: serverTimestamp(),
      });
      toast.success(`תמונת "${TAGS[tag]}" נשמרה 📷`);
    } catch (err) {
      console.error(err);
      toast.error("השמירה נכשלה");
    } finally { setBusy(false); }
  }

  async function remove(p) {
    if (!window.confirm("למחוק את התמונה?")) return;
    try {
      await deleteDoc(doc(db, "patientPhotos", p.id));
      try { await deleteObject(ref(storage, p.path)); } catch {}
      setPreview(null);
    } catch (err) { console.error(err); toast.error("המחיקה נכשלה"); }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <select value={tag} onChange={e => setTag(e.target.value)} style={{ padding: 8 }}>
          <option value="before">לפני</option>
          <option value="after">אחרי</option>
        </select>
        <input placeholder="אזור (שפתיים, מצח...)" value={area} onChange={e => setArea(e.target.value)}
          style={{ padding: 8, flex: 1, minWidth: 120 }} />
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? "שומר..." : "📷 צילום"}
        </button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" onChange={onPick} style={{ display: "none" }} />
      </div>

      {photos.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 8, marginTop: 10 }}>
          {photos.map(p => (
            <div key={p.id} onClick={() => setPreview(p)} style={{ cursor: "pointer", position: "relative" }}>
              <img src={p.url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8 }} />
              <div style={{
                position: "absolute", bottom: 4, right: 4, fontSize: 11, padding: "2px 6px", borderRadius: 6,
                background: p.tag === "before" ? "#fbbf24" : "#4ade80", color: "#111",
              }}>{TAGS[p.tag] || ""}{p.area ? ` · ${p.area}` : ""}</div>
            </div>
          ))}
        </div>
      )}

      {preview && (
        <div onClick={() => setPreview(null)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", zIndex: 1000,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <img src={preview.url} alt="" style={{ maxWidth: "100%", maxHeight: "80vh", borderRadius: 10 }} />
          <div style={{ color: "#fff", marginTop: 10 }}>{TAGS[preview.tag]} {preview.area ? `· ${preview.area}` : ""} · {fmt(preview.createdAt)}</div>
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={e => { e.stopPropagation(); remove(preview); }}>🗑 מחק</button>
        </div>
      )}
    </div>
  );
}
