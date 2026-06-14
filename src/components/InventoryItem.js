// src/components/InventoryItem.js
import React, { useState } from "react";

const BOTOX_CATEGORY = "בוטוקס";

export default function InventoryItem({ item, onAddStock, onEdit, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [addQty, setAddQty] = useState("");

  const isBotox = item.category === BOTOX_CATEGORY;

  const pct = Math.min(100, Math.round((item.qty / Math.max(item.threshold * 4, 1)) * 100));
  const color = item.qty <= item.threshold ? "#dc2626" : item.qty <= item.threshold * 2 ? "#d97706" : "#059669";
  const badgeClass = item.qty <= item.threshold ? "badge-danger" : item.qty <= item.threshold * 2 ? "badge-warn" : "badge-ok";
  const badgeText = item.qty <= item.threshold ? "נמוך!" : item.qty <= item.threshold * 2 ? "מעקב" : "תקין";

  // Expiry warning
  const today = new Date();
  const exp = item.expiry ? new Date(item.expiry) : null;
  const daysToExp = exp ? Math.round((exp - today) / 86400000) : null;
  const expWarn = daysToExp !== null && daysToExp < 90;

  const unitsPerVial = item.unitsPerVial || 0;
  const openVialUnits = item.openVialUnits || 0;

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.9375rem", marginBottom: 2 }}>{item.name}</div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
            {item.manufacturer && `${item.manufacturer} · `}{item.category} · <code style={{ fontSize: "0.7rem" }}>{item.barcode}</code>
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

      {/* Botox open-vial info */}
      {isBotox && (
        <div style={{
          background: "var(--accent-light)", borderRadius: "var(--radius-md)",
          padding: "8px 12px", marginBottom: 8, fontSize: "0.8rem",
          display: "flex", justifyContent: "space-between", alignItems: "center"
        }}>
          <span>
            {item.qty} בקבוקים סגורים
            {openVialUnits > 0 && ` + בקבוק פתוח: ${openVialUnits}/${unitsPerVial} יח'`}
          </span>
        </div>
      )}

      {/* Details */}
      <div style={{ display: "grid", gridTemplateColumns: isBotox ? "1fr 1fr 1fr 1fr" : "1fr 1fr 1fr", gap: 6, fontSize: "0.75rem", marginBottom: 10 }}>
        {isBotox ? (
          <div style={{ color: "var(--text-secondary)" }}>יח' לבקבוק<br /><span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{unitsPerVial || "—"}</span></div>
        ) : (
          <div style={{ color: "var(--text-secondary)" }}>נפח<br /><span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{item.volume || "—"}</span></div>
        )}
        <div style={{ color: "var(--text-secondary)" }}>סף הזמנה<br /><span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{item.threshold}</span></div>
        <div style={{ color: "var(--text-secondary)" }}>תפוגה<br />
          <span style={{ color: expWarn ? "var(--danger)" : "var(--text-primary)", fontWeight: 500 }}>
            {item.expiry || "—"}{expWarn && daysToExp < 0 ? " ⛔" : expWarn ? " ⚠️" : ""}
          </span>
        </div>
      </div>

      {/* Actions */}
      {adding ? (
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="number" min="1" value={addQty} onChange={e => setAddQty(e.target.value)}
            placeholder="כמה בקבוקים להוסיף?" autoFocus style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={() => { onAddStock(parseInt(addQty) || 1); setAdding(false); setAddQty(""); }}>
            הוסף
          </button>
          <button className="btn btn-secondary" onClick={() => setAdding(false)}>ביטול</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-secondary" style={{ flex: 1, fontSize: "0.8rem", padding: "7px" }} onClick={() => setAdding(true)}>
            ＋ הוסף {isBotox ? "בקבוקים" : "מלאי"}
          </button>
          <button
            className="btn btn-danger"
            style={{ fontSize: "0.8rem", padding: "7px 10px" }}
            onClick={() => { if (window.confirm(`למחוק "${item.name}"?`)) onDelete(); }}
          >
            🗑
          </button>
        </div>
      )}
    </div>
  );
}
