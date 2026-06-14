// src/App.js
import React, { useState, useEffect } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth } from "./firebase";
import LoginPage from "./pages/LoginPage";
import MainApp from "./pages/MainApp";
import "./index.css";

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u));
    return unsub;
  }, []);

  if (user === undefined) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh" }}>
        <div className="spinner" />
      </div>
    );
  }

  return user ? <MainApp user={user} /> : <LoginPage />;
}
