// src/components/TreatmentCard.js
import React from "react";

export default function TreatmentCard({ treatment: t }) {
  const dateStr = t.createdAt?.toDate?.().toLocaleString("he-IL", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  }) || "";

  return (
    <div className="card" style={{ marginBottom: 8, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{t.productName}</div>
          <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: 2 }}>
            {t.patientName} · {t.dose} יח'{t.note ? ` · ${t.note}` : ""}
          </div>
          {t.therapist && (
            <div style={{ fontSize: "0.7rem", color: "var(--text-tertiary)", marginTop: 2 }}>
              {t.therapist}
            </div>
          )}
        </div>
        <div style={{ textAlign: "left", fontSize: "0.75rem", color: "var(--text-secondary)", flexShrink: 0, marginRight: 8 }}>
          {dateStr}<br />
          <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>נשאר: {t.remainingAfter}</span>
        </div>
      </div>
    </div>
  );
}
