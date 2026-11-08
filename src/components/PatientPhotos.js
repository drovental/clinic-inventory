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

const navBtn = (side) => ({
  position: "absolute", [side]: 0, top: "50%", transform: "translateY(-50%)",
  width: 44, height: 64, border: "none", borderRadius: 10, cursor: "pointer",
  background: "rgba(255,255,255,0.15)", color: "#fff", fontSize: 36, lineHeight: "64px", padding: 0,
});

function fmt(ts) {
  const d = ts?.toDate ? ts.toDate() : ts ? new Date(ts) : null;
  return d ? d.toLocaleDateString("he-IL") : "";
}

export default function PatientPhotos({ patient }) {
  const [photos, setPhotos] = useState([]);
  const [tag, setTag] = useState("before");
  const [area, setArea] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null); // index into photos, or null
  const fileRef = useRef(null);
  const touchX = useRef(null);

  const current = preview !== null ? photos[preview] : null;
  const step = (d) => setPreview((i) => (i === null || !photos.length ? i : (i + d + photos.length) % photos.length));

  // Keyboard: arrows to browse, Escape to close
  useEffect(() => {
    if (preview === null) return;
    const onKey = (e) => {
      if (e.key === "Escape") setPreview(null);
      else if (e.key === "ArrowLeft") step(1);   // RTL: left arrow = next
      else if (e.key === "ArrowRight") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, photos.length]);
  useEffect(() => { if (preview !== null && preview >= photos.length) setPreview(photos.length ? photos.length - 1 : null); }, [photos.length]);

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
            <div key={p.id} onClick={() => setPreview(photos.indexOf(p))} style={{ cursor: "pointer", position: "relative" }}>
              <img src={p.url} alt="" style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 8 }} />
              <div style={{
                position: "absolute", bottom: 4, right: 4, fontSize: 11, padding: "2px 6px", borderRadius: 6,
                background: p.tag === "before" ? "#fbbf24" : "#4ade80", color: "#111",
              }}>{TAGS[p.tag] || ""}{p.area ? ` · ${p.area}` : ""}</div>
            </div>
          ))}
        </div>
      )}

      {current && (
        <div onClick={() => setPreview(null)}
          onTouchStart={e => { touchX.current = e.touches[0].clientX; }}
          onTouchEnd={e => {
            if (touchX.current === null) return;
            const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null;
            if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); // swipe left = next (RTL)
          }}
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 1000,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16,
          }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%" }}>
            {photos.length > 1 && (
              <button type="button" aria-label="הבא" onClick={e => { e.stopPropagation(); step(1); }}
                style={navBtn("left")}>‹</button>
            )}
            <img src={current.url} alt="" onClick={e => e.stopPropagation()} style={{ maxWidth: "calc(100% - 96px)", maxHeight: "78vh", borderRadius: 10 }} />
            {photos.length > 1 && (
              <button type="button" aria-label="הקודם" onClick={e => { e.stopPropagation(); step(-1); }}
                style={navBtn("right")}>›</button>
            )}
          </div>
          <div style={{ color: "#fff", marginTop: 10, textAlign: "center" }}>
            {TAGS[current.tag]} {current.area ? `· ${current.area}` : ""} · {fmt(current.createdAt)}
            <span style={{ opacity: 0.6, marginRight: 10, fontSize: "0.85em" }}>{preview + 1} / {photos.length}</span>
          </div>
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={e => { e.stopPropagation(); remove(current); }}>🗑 מחק</button>
        </div>
      )}
    </div>
  );
}
