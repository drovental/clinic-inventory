// src/hooks/useFirestore.js
import { useState, useEffect } from "react";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, query, orderBy, serverTimestamp, increment
} from "firebase/firestore";
import { db } from "../firebase";

// ── Generic realtime listener ───────────────────────────────
export function useCollection(collectionName, orderField = "createdAt") {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, collectionName), orderBy(orderField, "desc"));
    const unsub = onSnapshot(q, snap => {
      setData(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, [collectionName, orderField]);

  return { data, loading };
}

// ── Inventory ───────────────────────────────────────────────
export function useInventory() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "inventory"), orderBy("name"));
    const unsub = onSnapshot(q, snap => {
      setItems(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addItem(item) {
    await addDoc(collection(db, "inventory"), { ...item, createdAt: serverTimestamp() });
  }

  async function updateItem(id, data) {
    await updateDoc(doc(db, "inventory", id), data);
  }

  async function decrementQty(id, amount = 1) {
    await updateDoc(doc(db, "inventory", id), { qty: increment(-amount) });
  }

  // Decrement units from an open botox vial, opening a new vial (and decrementing
  // the sealed vial count) whenever the open vial runs out.
  async function useBotoxUnits(item, unitsUsed) {
    const unitsPerVial = item.unitsPerVial || 0;
    let openVialUnits = item.openVialUnits || 0;
    let vials = item.qty || 0;
    let remaining = unitsUsed;

    // If no vial is currently open, open one now
    if (openVialUnits <= 0 && vials > 0) {
      vials -= 1;
      openVialUnits = unitsPerVial;
    }

    while (remaining > 0) {
      if (openVialUnits <= 0) {
        if (vials > 0) {
          vials -= 1;
          openVialUnits = unitsPerVial;
        } else {
          // No more vials available — go negative on the open vial to flag overdraw
          openVialUnits -= remaining;
          remaining = 0;
          break;
        }
      }
      const take = Math.min(remaining, openVialUnits);
      openVialUnits -= take;
      remaining -= take;
    }

    await updateDoc(doc(db, "inventory", item.id), { qty: vials, openVialUnits });
    return { vials, openVialUnits };
  }


  async function incrementQty(id, amount, newExpiry) { const update = { qty: increment(amount) }; if (newExpiry) { const item = items.find(i => i.id === id); const existingExpiry = item ? item.expiry : null; if (!existingExpiry || newExpiry < existingExpiry) { update.expiry = newExpiry; } } await updateDoc(doc(db, "inventory", id), update); }

  async function deleteItem(id) {
    await deleteDoc(doc(db, "inventory", id));
  }

  // Look up by barcode (client-side since inventory is small)
  function findByBarcode(barcode) {
    return items.find(i => i.barcode === barcode.trim()) || null;
  }

  return { items, loading, addItem, updateItem, decrementQty, incrementQty, deleteItem, findByBarcode, useBotoxUnits };
}

// ── Patients ────────────────────────────────────────────────
export function usePatients() {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "patients"), orderBy("name"));
    const unsub = onSnapshot(q, snap => {
      setPatients(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addPatient(patient) {
    await addDoc(collection(db, "patients"), { ...patient, createdAt: serverTimestamp() });
  }

  async function updatePatient(id, data) {
    await updateDoc(doc(db, "patients", id), data);
  }

  async function deletePatient(id) {
    await deleteDoc(doc(db, "patients", id));
  }

  return { patients, loading, addPatient, updatePatient, deletePatient };
}

// ── Treatments ──────────────────────────────────────────────
export function useTreatments() {
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "treatments"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, snap => {
      setTreatments(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addTreatment(treatment) {
    await addDoc(collection(db, "treatments"), { ...treatment, createdAt: serverTimestamp() });
  }
  async function deleteTreatment(id) {
    await deleteDoc(doc(db, "treatments", id));
  }

  return { treatments, loading, addTreatment, deleteTreatment };
}

// ── Orders ──────────────────────────────────────────────────
export function useOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "orders"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, snap => {
      setOrders(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addOrder(order) {
    await addDoc(collection(db, "orders"), { ...order, status: "ממתין לאישור", createdAt: serverTimestamp() });
  }

  async function updateOrderStatus(id, status) {
    await updateDoc(doc(db, "orders", id), { status });
  }

  return { orders, loading, addOrder, updateOrderStatus };
}


// ── Therapists (for WhatsApp follow-up alerts) ──────────────
export function useTherapists() {
  const [therapists, setTherapists] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const q = query(collection(db, "therapists"), orderBy("name"));
    const unsub = onSnapshot(q, snap => {
      setTherapists(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addTherapist(t) {
    await addDoc(collection(db, "therapists"), { ...t, createdAt: serverTimestamp() });
  }
  async function updateTherapist(id, data) {
    await updateDoc(doc(db, "therapists", id), data);
  }
  async function deleteTherapist(id) {
    await deleteDoc(doc(db, "therapists", id));
  }

  return { therapists, loading, addTherapist, updateTherapist, deleteTherapist };
}

// —— Loyalty club ————————————————————————————————————————
export const POINTS_PER_SHEKEL = 1;
export const SHEKELS_PER_100_POINTS = 10;
export const TIERS = [
  { key: "silver",  min: 0,     multiplier: 1,     label: "כסף",  color: "#9ca3af" },
  { key: "gold",    min: 5000,  multiplier: 1.25,  label: "זהב",  color: "#d4af37" },
  { key: "diamond", min: 15000, multiplier: 1.5, label: "יהלום", color: "#60a5fa" },
];
export function getTier(totalEarned = 0) {
  return [...TIERS].reverse().find(t => totalEarned >= t.min) || TIERS[0];
}
export function pointsToShekels(points = 0) {
  return Math.floor(points / 100) * SHEKELS_PER_100_POINTS;
}

// Renewal intervals in days, matched by keyword in product name (lowercase)
export const RENEWAL_RULES = [
  { match: ["dysport", "xeomin", "botox", "דיספורט", "קסאומין", "בוטוקס"], days: 120, label: "רעלן" },
  { match: ["stylage", "hallura", "belotero", "סטילאז'", "הלורה", "בלוטרו"], days: 365, label: "מילוי" },
  { match: ["radiesse", "harmonyca", "karisma", "רדיאס", "הרמוניקה", "קריזמה"], days: 365, label: "ביוסטימולטור" },
  { match: ["exosome", "dermapen", "אקסוזום", "דרמפן"], days: 90, label: "דרמפן" },
  { match: ["peel", "פילינג"], days: 60, label: "פילינג" },
];
export function getRenewalRule(productName = "") {
  const n = productName.toLowerCase();
  return RENEWAL_RULES.find(r => r.match.some(m => n.includes(m))) || null;
}

export function useLoyalty() {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const q = query(collection(db, "loyaltyTransactions"), orderBy("createdAt", "desc"));
    const unsub = onSnapshot(q, snap => {
      setTransactions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoading(false);
    });
    return unsub;
  }, []);

  async function addPoints(patient, shekels, note = "") {
    const points = Math.round(shekels * POINTS_PER_SHEKEL * (getTier(patient.loyaltyTotalEarned || 0).multiplier || 1));
    await addDoc(collection(db, "loyaltyTransactions"), {
      patientId: patient.id, patientName: patient.name || "",
      type: "earn", points, shekels, note, createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "patients", patient.id), {
      loyaltyPoints: increment(points),
      loyaltyTotalEarned: increment(points),
    });
    return points;
  }

  async function redeemPoints(patient, points, note = "") {
    await addDoc(collection(db, "loyaltyTransactions"), {
      patientId: patient.id, patientName: patient.name || "",
      type: "redeem", points: -points, shekels: pointsToShekels(points), note, createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "patients", patient.id), { loyaltyPoints: increment(-points) });
  }

  return { transactions, loading, addPoints, redeemPoints };
}


// —— Referral program ————————————————————————————————————
export const REFERRAL_BONUS = 300;
export function referralCode(patientId = "") {
  return "ARIA-" + patientId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5).toUpperCase();
}
export function findByReferralCode(patients, code = "") {
  let c = code.trim().toUpperCase().replace(/\s/g, ""); if (c && !c.startsWith("ARIA-")) c = "ARIA-" + c.replace(/^ARIA/, "");
  if (!c) return null;
  return patients.find(p => referralCode(p.id) === c) || null;
}
// Called on a patient's first payment: rewards her and the referrer once
export async function awardReferralIfDue(patient, allPatients = []) {
  if (!patient?.referredBy || patient.referralRewarded) return false;
  const referrer = allPatients.find(p => p.id === patient.referredBy);
  if (!referrer) return false;
  const note = `בונוס חבר מביא חבר 🤝`;
  await addDoc(collection(db, "loyaltyTransactions"), {
    patientId: patient.id, patientName: patient.name || "", type: "referral",
    points: REFERRAL_BONUS, shekels: 0, note: `${note} (הופנית על ידי ${referrer.name || ""})`,
    createdAt: serverTimestamp(),
  });
  await addDoc(collection(db, "loyaltyTransactions"), {
    patientId: referrer.id, patientName: referrer.name || "", type: "referral",
    points: REFERRAL_BONUS, shekels: 0, note: `${note} (הבאת את ${patient.name || ""})`,
    referredPatientId: patient.id, createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "patients", patient.id), {
    loyaltyPoints: increment(REFERRAL_BONUS), loyaltyTotalEarned: increment(REFERRAL_BONUS), referralRewarded: true,
  });
  await updateDoc(doc(db, "patients", referrer.id), {
    loyaltyPoints: increment(REFERRAL_BONUS), loyaltyTotalEarned: increment(REFERRAL_BONUS),
    referralCount: increment(1),
  });
  return true;
}
