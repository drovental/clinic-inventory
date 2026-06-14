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


  async function incrementQty(id, amount) {
    await updateDoc(doc(db, "inventory", id), { qty: increment(amount) });
  }

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

  return { treatments, loading, addTreatment };
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
