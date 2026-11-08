// src/hooks/useFirestore.js
import { useState, useEffect } from "react";
import {
  collection, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, writeBatch,
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

// —— Loyalty club (v2 – tiers by yearly spend, 1 point = 1 ₪) ——————————
// Earning: 2.5% of every payment (= 5 points per 200 ₪), rounded down. 1 point = 1 ₪ discount.
// Tiers (by ₪ spent in a calendar year; status is kept through the following year):
//   silver = everyone · gold ≥ 4,000 ₪ · platinum ≥ 7,000 ₪ · platinum also for 3+ successful referrals
// Points expire 24 months after they were earned (FIFO). Rules document: /takanon.html
export const EARN_RATE = 0.025;
export const SHEKELS_PER_POINT = 1;
export const POINTS_EXPIRY_MONTHS = 24;
export const REFERRAL_BONUS = 50;          // to the referrer, on the referred patient's first payment
export const JOIN_GIFT_DEFAULT = 30;       // to the new patient who was referred (editable in settings/loyalty)
export const REFERRALS_FOR_PLATINUM = 3;
export const TIERS = [
  { key: "silver",   min: 0,    label: "כסף",     color: "#9ca3af", perks: ["צבירת 2.5% מכל תשלום (5 נק׳ לכל 200 ₪)", "1 נקודה = 1 ₪ הנחה, למימוש בכל עת"] },
  { key: "gold",     min: 4000, label: "זהב",     color: "#d4af37", perks: ["כל הטבות כסף", "מתנה הביתה פעם בשנה"] },
  { key: "platinum", min: 7000, label: "פלטינום", color: "#a78bfa", perks: ["כל הטבות זהב", "מתנת יום הולדת", "קו שירות VIP", "הזמנה לטיפול פנים פעם בשנה"] },
];
// Legacy names kept so older imports don't break
export const POINTS_PER_SHEKEL = EARN_RATE;
export const SHEKELS_PER_100_POINTS = 100 * SHEKELS_PER_POINT;

export function pointsForPayment(shekels = 0) {
  return Math.floor(Number(shekels || 0) * EARN_RATE);
}
export function pointsToShekels(points = 0) {
  return Math.max(0, Math.floor(Number(points || 0))) * SHEKELS_PER_POINT;
}
export function yearSpend(patient, year = new Date().getFullYear()) {
  return Number(patient?.loyaltySpendByYear?.[String(year)] || 0);
}
function tierBySpend(spend) {
  return [...TIERS].reverse().find(t => spend >= t.min) || TIERS[0];
}
// Tier = best of: this year's spend, last year's spend (status kept one more year), referral platinum, manual override
export function getTier(patient = {}) {
  if (typeof patient === "number") return tierBySpend(0); // old call style getTier(totalEarned) – no longer meaningful
  const y = new Date().getFullYear();
  const candidates = [tierBySpend(yearSpend(patient, y)), tierBySpend(yearSpend(patient, y - 1))];
  if ((patient.referralCount || 0) >= REFERRALS_FOR_PLATINUM) candidates.push(TIERS[2]);
  if (patient.tierOverride) { const o = TIERS.find(t => t.key === patient.tierOverride); if (o) candidates.push(o); }
  return candidates.reduce((a, b) => (b.min > a.min ? b : a));
}
export function nextTierInfo(patient = {}) {
  const spend = yearSpend(patient);
  const next = TIERS.find(t => t.min > spend);
  return next ? { tier: next, missing: next.min - spend } : null;
}
export function expiryDate(from = new Date()) {
  const d = new Date(from); d.setMonth(d.getMonth() + POINTS_EXPIRY_MONTHS); return d;
}

// Renewal intervals in days, matched by keyword in product name (lowercase)
export const RENEWAL_RULES = [
  { match: ["dysport", "xeomin", "botox", "דיספורט", "קסאומין", "בוטוקס"], days: 120, label: "בוטוקס" },
  { match: ["stylage", "hallura", "belotero", "סטילאז'", "הלורה", "בלוטרו"], days: 365, label: "מילוי" },
  { match: ["radiesse", "harmonyca", "karisma", "רדיאס", "הרמוניקה", "קריזמה"], days: 365, label: "ביוסטימולטור" },
  { match: ["exosome", "dermapen", "אקסוזום", "דרמפן"], days: 90, label: "דרמפן" },
  { match: ["peel", "פילינג"], days: 60, label: "פילינג" },
];
export function getRenewalRule(productName = "") {
  const n = productName.toLowerCase();
  return RENEWAL_RULES.find(r => r.match.some(m => n.includes(m))) || null;
}

export function useLoyaltySettings() {
  const [settings, setSettings] = useState({ joinGiftPoints: JOIN_GIFT_DEFAULT });
  useEffect(() => onSnapshot(doc(db, "settings", "loyalty"), s => s.exists() && setSettings({ joinGiftPoints: JOIN_GIFT_DEFAULT, ...s.data() })), []);
  async function save(patch) { await setDoc(doc(db, "settings", "loyalty"), patch, { merge: true }); }
  return { settings, save };
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

  // Record a payment: 2.5% as points (expire in 24 months) + add the ₪ to this year's spend (tier)
  async function addPoints(patient, shekels, note = "") {
    const amount = Number(shekels || 0);
    const points = pointsForPayment(amount);
    const year = String(new Date().getFullYear());
    await addDoc(collection(db, "loyaltyTransactions"), {
      patientId: patient.id, patientName: patient.name || "",
      type: "earn", points, remaining: points, shekels: amount, note,
      expiresAt: expiryDate(), createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "patients", patient.id), {
      loyaltyPoints: increment(points),
      loyaltyTotalEarned: increment(points),
      [`loyaltySpendByYear.${year}`]: increment(amount),
      loyaltyLastPaymentAt: serverTimestamp(),
    });
    return points;
  }

  // Redeem any whole number of points (1 point = 1 ₪), consuming the oldest points first
  async function redeemPoints(patient, points, note = "") {
    const pts = Math.floor(Number(points || 0));
    const earned = transactions
      .filter(t => t.patientId === patient.id && (t.remaining || 0) > 0)
      .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
    let left = pts;
    const batch = writeBatch(db);
    for (const t of earned) {
      if (left <= 0) break;
      const take = Math.min(left, t.remaining);
      batch.update(doc(db, "loyaltyTransactions", t.id), { remaining: t.remaining - take });
      left -= take;
    }
    batch.set(doc(collection(db, "loyaltyTransactions")), {
      patientId: patient.id, patientName: patient.name || "",
      type: "redeem", points: -pts, shekels: pointsToShekels(pts), note, createdAt: serverTimestamp(),
    });
    batch.update(doc(db, "patients", patient.id), { loyaltyPoints: increment(-pts) });
    await batch.commit();
  }

  // Staff marks a tier perk as delivered (gold gift / platinum facial / platinum birthday gift)
  async function markPerk(patient, perk, year = new Date().getFullYear()) {
    await updateDoc(doc(db, "patients", patient.id), { [`loyaltyPerks.${perk}`]: year });
    await addDoc(collection(db, "loyaltyTransactions"), {
      patientId: patient.id, patientName: patient.name || "", type: "perk", perk, points: 0, shekels: 0,
      note: PERK_LABELS[perk] || perk, createdAt: serverTimestamp(),
    });
  }

  return { transactions, loading, addPoints, redeemPoints, markPerk };
}
export const PERK_LABELS = { goldGift: "מתנה שנתית הביתה (זהב)", platinumFacial: "טיפול פנים שנתי (פלטינום)", platinumBirthday: "מתנת יום הולדת (פלטינום)" };


// —— Referral program (חבר מביא חבר) ——————————————————————
export function referralCode(patientId = "") {
  return "ARIA-" + patientId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5).toUpperCase();
}
export function findByReferralCode(patients, code = "") {
  let c = code.trim().toUpperCase().replace(/\s/g, ""); if (c && !c.startsWith("ARIA-")) c = "ARIA-" + c.replace(/^ARIA/, "");
  if (!c) return null;
  return patients.find(p => referralCode(p.id) === c) || null;
}
// Called on the referred patient's first payment: referrer gets REFERRAL_BONUS, the new patient gets the joining gift.
// A referrer with 3 successful referrals becomes platinum automatically (see getTier).
export async function awardReferralIfDue(patient, allPatients = [], joinGiftPoints = JOIN_GIFT_DEFAULT) {
  if (!patient?.referredBy || patient.referralRewarded) return false;
  const referrer = allPatients.find(p => p.id === patient.referredBy);
  if (!referrer) return false;
  const gift = Math.max(0, Math.floor(Number(joinGiftPoints || 0)));
  const batch = writeBatch(db);
  if (gift > 0) {
    batch.set(doc(collection(db, "loyaltyTransactions")), {
      patientId: patient.id, patientName: patient.name || "", type: "referral",
      points: gift, remaining: gift, shekels: 0, note: `מתנת הצטרפות 🎁 (הופנית על ידי ${referrer.name || ""})`,
      expiresAt: expiryDate(), createdAt: serverTimestamp(),
    });
  }
  batch.set(doc(collection(db, "loyaltyTransactions")), {
    patientId: referrer.id, patientName: referrer.name || "", type: "referral",
    points: REFERRAL_BONUS, remaining: REFERRAL_BONUS, shekels: 0, note: `בונוס חבר מביא חבר 🤝 (הבאת את ${patient.name || ""})`,
    referredPatientId: patient.id, expiresAt: expiryDate(), createdAt: serverTimestamp(),
  });
  batch.update(doc(db, "patients", patient.id), {
    loyaltyPoints: increment(gift), loyaltyTotalEarned: increment(gift), referralRewarded: true,
  });
  batch.update(doc(db, "patients", referrer.id), {
    loyaltyPoints: increment(REFERRAL_BONUS), loyaltyTotalEarned: increment(REFERRAL_BONUS),
    referralCount: increment(1),
  });
  await batch.commit();
  return true;
}
