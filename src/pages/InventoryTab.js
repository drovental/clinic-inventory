// src/pages/InventoryTab.js
import React, { useState } from "react";
import toast from "react-hot-toast";
import { useInventory } from "../hooks/useFirestore";
import InventoryItem from "../components/InventoryItem";

const BOTOX_CATEGORY = "בוטוקס";

const EMPTY_FORM = {
  name: "", barcode: "", manufacturer: "", category: "פילר",
  volume: "", qty: "", threshold: "3", expiry: "", notes: "",
  unitsPerVial: ""
};

const CATEGORIES = ["פילר", "בוטוקס", "ביוסטימולטור", "חומצה היאלורונית", "ליפוליטי", "אחר"];

export default function InventoryTab() {
  const { items, loading, addItem, updateItem, incrementQty, deleteItem } = useInventory();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [filterCat, setFilterCat] = useState("הכל");

  const filtered = items.filter(i => {
    const matchSearch = i.name?.toLowerCase().includes(search.toLowerCase()) ||
                        i.barcode?.includes(search);
    const matchCat = filterCat === "הכל" || i.category === filterCat;
    return matchSearch && matchCat;
  });

  const totalUnits = items.reduce((s, i) => s + (i.qty || 0), 0);
  const lowCount   = items.filter(i => i.qty <= i.threshold).length;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name || !form.barcode) { toast.error("שם וברקוד חובה"); return; }
    if (items.find(i => i.barcode === form.barcode)) { toast.error("ברקוד כבר קיים במלאי"); return; }
    if (form.category === BOTOX_CATEGORY && !form.unitsPerVial) {
      toast.error("יש להזין יחידות לבקבוק"); return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        qty: parseFloat(form.qty) || 0,
        threshold: parseFloat(form.threshold) || 3,
      };
      if (form.category === BOTOX_CATEGORY) {
        payload.unitsPerVial = parseFloat(form.unitsPerVial) || 0;
        payload.openVialUnits = 0;
      }
      await addItem(payload);
      toast.success("פריט נוסף בהצלחה");
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (e) {
      toast.error("שגיאה: " + e.message);
    } finally { setSaving(false); }
  }

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: "3rem" }}><div className="spinner" /></div>;

  return (
    <div>
      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: "1rem" }}>
        {[
          { label: "פריטים", value: items.length },
          { label: "יחידות", value: totalUnits, color: "var(--success)" },
          { label: "מתחת לסף", value: lowCount, color: lowCount ? "var(--danger)" : "var(--success)" },
        ].map(s => (
          <div key={s.label} style={{
            background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)",
            padding: "12px", textAlign: "center"
          }}>
            <div style={{ fontSize: "1.5rem", fontWeight: 700, color: s.color || "var(--text-primary)" }}>{s.value}</div>
            <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Search + filter */}
      <div style={{ display: "flex", gap: 8, marginBottom: "0.75rem" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="חיפוש לפי שם / ברקוד..." style={{ flex: 1 }} />
        <select value={filterCat} onChange={e => setFilterCat(e.target.value)} style={{ width: "auto" }}>
          <option>הכל</option>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {/* Add button */}
      <button className="btn btn-primary btn-full" onClick={() => setShowForm(!showForm)} style={{ marginBottom: "1rem" }}>
        {showForm ? "✕ ביטול" : "＋ הוסף פריט חדש"}
      </button>

      {/* Add form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="card" style={{ marginBottom: "1rem" }}>
          <h3 style={{ marginBottom: "1rem" }}>פריט חדש</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div style={{ gridColumn: "1/-1" }}>
              <label>שם מוצר *</label>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Juvederm Ultra 1ml" required />
            </div>
            <div>
              <label>ברקוד *</label>
              <input value={form.barcode} onChange={e => setForm({ ...form, barcode: e.target.value })} placeholder="BC-001" required />
            </div>
            <div>
              <label>יצרן</label>
              <input value={form.manufacturer} onChange={e => setForm({ ...form, manufacturer: e.target.value })} placeholder="Allergan" />
            </div>
            <div>
              <label>קטגוריה</label>
              <select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            {form.category === BOTOX_CATEGORY ? (
              <div>
                <label>יחידות לבקבוק *</label>
                <input type="number" min="1" value={form.unitsPerVial} onChange={e => setForm({ ...form, unitsPerVial: e.target.value })} placeholder="למשל: 500 (דיספורט) / 100 (קסאומין)" required />
              </div>
            ) : (
              <div>
                <label>נפח / יחידה</label>
                <input value={form.volume} onChange={e => setForm({ ...form, volume: e.target.value })} placeholder='1.0 מ"ל' />
              </div>
            )}
            <div>
              <label>{form.category === BOTOX_CATEGORY ? "כמות בקבוקים *" : "כמות במלאי *"}</label>
              <input type="number" min="0" value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value })} placeholder="10" required />
            </div>
            <div>
              <label>סף הזמנה</label>
              <input type="number" min="0" value={form.threshold} onChange={e => setForm({ ...form, threshold: e.target.value })} />
            </div>
            <div>
              <label>תאריך תפוגה</label>
              <input type="date" value={form.expiry} onChange={e => setForm({ ...form, expiry: e.target.value })} />
            </div>
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={saving}>
            {saving ? "שומר..." : "💾 שמור פריט"}
          </button>
        </form>
      )}

      {/* Items list */}
      {filtered.length === 0 ? (
        <div className="empty-state">
          <span style={{ fontSize: 40, opacity: 0.3 }}>📦</span>
          <p>{search ? "לא נמצאו תוצאות" : "המלאי ריק — הוסף פריט ראשון"}</p>
        </div>
      ) : (
        filtered.map(item => (
          <InventoryItem
            key={item.id}
            item={item}
            onAddStock={async (n) => { await incrementQty(item.id, n); toast.success(`נוספו ${n} ${item.category === BOTOX_CATEGORY ? "בקבוקים" : "יחידות"}`); }}
            onEdit={async (data) => { await updateItem(item.id, data); toast.success("עודכן"); }}
            onDelete={async () => { await deleteItem(item.id); toast.success("נמחק"); }}
          />
        ))
      )}
    </div>
  );
}
