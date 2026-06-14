// src/firebase.js
// ─────────────────────────────────────────────────────────────
// 1. צור פרויקט ב-https://console.firebase.google.com
// 2. הוסף אפליקציית Web
// 3. העתק את ה-firebaseConfig שלך לכאן
// ─────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCFtD973C8TIPFfArd9UT7GFWUg3ZES5rs",
  authDomain: "aria-inventory.firebaseapp.com",
  projectId: "aria-inventory",
  storageBucket: "aria-inventory.firebasestorage.app",
  messagingSenderId: "294996218036",
  appId: "1:294996218036:web:2d3d1dfed452c3542187e1"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
