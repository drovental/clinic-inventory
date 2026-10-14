// src/pages/MainApp.js
import React, { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { Toaster } from "react-hot-toast";
import ScanTab from "./ScanTab";
import InventoryTab from "./InventoryTab";
import PatientsTab from "./PatientsTab";
import OrdersTab from "./OrdersTab";
import FollowupTab from "./FollowupTab";

const TABS = [
  { id: "scan",      label: "סריקה",    icon: "📷" },
  { id: "inventory", label: "מלאי",     icon: "📦" },
  { id: "patients",  label: "מטופלים",  icon: "👥" },
  { id: "orders",    label: "הזמנות",   icon: "🚚" },
  { id: "followup",  label: "מעקב",     icon: "💬" },
];

export default function MainApp({ user }) {
  const [activeTab, setActiveTab] = useState("scan");

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100dvh" }}>
      <Toaster position="top-center" toastOptions={{ duration: 3000, style: { fontFamily: "Heebo, sans-serif", direction: "rtl" } }} />

      {/* Top bar */}
      <header style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(255,255,255,0.9)", backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--border)",
        height: "var(--nav-h)", display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 1rem"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <img src="/logo.png" alt="ARIA" style={{ height: 36, width: 36, objectFit: "contain" }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.95rem", lineHeight: 1.2 }}>מלאי קליניקה</div>
            <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>{user.email}</div>
          </div>
        </div>
        <button
          onClick={() => signOut(auth)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            color: "var(--text-secondary)", fontSize: "0.8rem", padding: "6px 10px",
            borderRadius: "var(--radius-sm)"
          }}
        >
          יציאה
        </button>
      </header>

      {/* Page content */}
      <main style={{ flex: 1, padding: "1rem", paddingBottom: "calc(var(--bottom-h) + 1rem)", maxWidth: 640, width: "100%", margin: "0 auto" }}>
        {activeTab === "scan"      && <ScanTab user={user} />}
        {activeTab === "inventory" && <InventoryTab />}
        {activeTab === "patients"  && <PatientsTab />}
        {activeTab === "orders"    && <OrdersTab />}
        {activeTab === "followup"  && <FollowupTab />}
      </main>

      {/* Bottom nav */}
      <nav style={{
        position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 50,
        height: "var(--bottom-h)",
        background: "rgba(255,255,255,0.95)", backdropFilter: "blur(12px)",
        borderTop: "1px solid var(--border)",
        display: "flex", alignItems: "center", justifyContent: "space-around",
        padding: "0 0.5rem",
        paddingBottom: "env(safe-area-inset-bottom)"
      }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
              gap: 3, padding: "8px 4px", background: "none", border: "none", cursor: "pointer",
              color: activeTab === tab.id ? "var(--accent)" : "var(--text-tertiary)",
              transition: "color 0.15s"
            }}
          >
            <span style={{ fontSize: 22 }}>{tab.icon}</span>
            <span style={{ fontSize: "0.7rem", fontWeight: activeTab === tab.id ? 600 : 400 }}>
              {tab.label}
            </span>
            {activeTab === tab.id && (
              <div style={{ position: "absolute", bottom: "env(safe-area-inset-bottom,0px)", width: 24, height: 3, background: "var(--accent)", borderRadius: 2 }} />
            )}
          </button>
        ))}
      </nav>
    </div>
  );
}
