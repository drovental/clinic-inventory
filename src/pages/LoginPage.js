// src/pages/LoginPage.js
import React, { useState } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import toast from "react-hot-toast";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      toast.error("אימייל או סיסמה שגויים");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: "100dvh", display: "flex", alignItems: "center",
      justifyContent: "center", padding: "1rem",
      background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)"
    }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Logo area */}
        <div style={{ textAlign: "center", marginBottom: "2rem" }}>
          <div style={{
            width: 64, height: 64, borderRadius: 20, margin: "0 auto 12px",
            background: "rgba(79,70,229,0.3)", border: "1px solid rgba(79,70,229,0.5)",
            display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28
          }}>💉</div>
          <h1 style={{ color: "#fff", fontSize: "1.5rem", fontWeight: 700 }}>מלאי קליניקה</h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.875rem", marginTop: 4 }}>
            מערכת ניהול חומרי הזרקה
          </p>
        </div>

        {/* Login card */}
        <form onSubmit={handleLogin} style={{
          background: "rgba(255,255,255,0.05)", backdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "1.75rem"
        }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", color: "rgba(255,255,255,0.7)", fontSize: "0.875rem", marginBottom: 6 }}>
              אימייל
            </label>
            <input
              type="email" value={email} onChange={e => setEmail(e.target.value)}
              required placeholder="therapist@clinic.com"
              style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff" }}
            />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: "block", color: "rgba(255,255,255,0.7)", fontSize: "0.875rem", marginBottom: 6 }}>
              סיסמה
            </label>
            <input
              type="password" value={password} onChange={e => setPassword(e.target.value)}
              required placeholder="••••••••"
              style={{ background: "rgba(255,255,255,0.1)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff" }}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading}>
            {loading ? <div className="spinner" style={{ width: 18, height: 18 }} /> : "כניסה"}
          </button>
        </form>

        <p style={{ textAlign: "center", color: "rgba(255,255,255,0.3)", fontSize: "0.75rem", marginTop: "1.5rem" }}>
          פנה למנהל הקליניקה לקבלת גישה
        </p>
      </div>
    </div>
  );
}
