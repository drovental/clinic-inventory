// src/components/InventoryItem.js
import React, { useState } from "react";

export default function InventoryItem({ item, onAddStock, onEdit, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [addQty, setAddQty] = useState("");
  const [addExpiry, setAddExpiry] = useState("");

  const pct = Math.min(100, Math.round((item.qty / Math.max(item.threshold * 4, 1)) * 100));
  const color = item.qty <= item.threshold ? "#dc2626" : item.qty <= item.threshold * 2 ? "#d97706" : "#059669";
  const badgeClass = item.qty <= item.threshold ? "badge-danger" : item.qty <= item.threshold * 2 ? "badge-warn" : "badge-ok";
  const badgeText = item.qty <= item.threshold ? "🔴 אזל" : item.qty <= item.threshold * 2 ? "🟡 מלאי נמוך" : "🟢 במלאי";

  // Expiry warning
  const today = new Date();
  const exp = item.expiry ? new Date(item.expiry) : null;
  const daysToExp = exp ? Math.round((exp - today) / 86400000) : null;
  const expWarn = daysToExp !== null && daysToExp < 90;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.9375rem", marginBottom: 2 }}>{item.name}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
            {item.manufacturer && `${item.manufacturer} ֲ· `}{item.category} ֲ· <code style={{ fontSize: "0.7rem" }}>{item.barcode}</code>
          </div>
        </div>
        <span className={`badge ${badgeClass}`} style={{ flexShrink: 0, marginRight: 8 }}>{badgeText}</span>
      </div>

      {/* Progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div className="prog-wrap" style={{ flex: 1 }}>
          <div className="prog-fill" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span style={{ fontWeight: 700, fontSize: "1rem", color, minWidth: 28, textAlign: "left" }}>{item.qty}</span>
      </div>

      {/* Details */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, fontSize: "0.75rem", marginBottom: 10 }}>
          <div style={{ color: "var(--text-secondary)" }}>נפח<br /><span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{item.volume || "-"}</span></div>
          <div style={{ color: "var(--text-secondary)" }}>סף מלאי<br /><span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{item.threshold}</span></div>
          <div style={{ color: "var(--text-secondary)" }}>תוקף<br />
          <span style={{ color: expWarn ? "var(--danger)" : "var(--text-primary)", fontWeight: 500 }}>
            {item.expiry || "-"}{expWarn && daysToExp < 0 ? " 🔴" : expWarn ? " ⚠️" : ""}
          </span>
        </div>
      </div>

      {/* Actions */}
      {adding ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="number" min="1" value={addQty} onChange={e => setAddQty(e.target.value)}
            placeholder="כמות" autoFocus style={{ flex: 1 }}
            />
            <input
              type="date" value={addExpiry} onChange={e => setAddExpiry(e.target.value)}
            style={{ flex: 1 }} title="תאריך תפוגה (אופציונלי)"
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => {
              onAddStock(parseInt(addQty) || 1, addExpiry || null);
              setAdding(false); setAddQty(""); setAddExpiry("");
            }}>
              ׳”׳•׳¡׳£
            </button>
            <button className="btn btn-secondary" onClick={() => { setAdding(false); setAddExpiry(""); }}>ביטול</button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-secondary" style={{ flex: 1, fontSize: "0.8rem", padding: "7px" }} onClick={() => setAdding(true)}>
            + הוסף מלאי
          </button>
          <button
            className="btn btn-danger"
            style={{ fontSize: "0.8rem", padding: "7px 10px" }}
            onClick={() => { if (window.confirm(`למחוק את ${item.name}?`)) onDelete(); }}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}

