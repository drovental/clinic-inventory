// src/pages/OrdersTab.js
import React from "react";
import toast from "react-hot-toast";
import { useInventory, useOrders } from "../hooks/useFirestore";

const STATUS_COLORS = {
  "ממתין לאישור": "badge-warn",
  "הוזמן": "badge-info",
  "התקבל": "badge-ok",
  "בוטל": "badge-gray",
};

export default function OrdersTab() {
  const { items } = useInventory();
  const { orders, addOrder, updateOrderStatus } = useOrders();

  const lowItems = items.filter(i => i.qty <= i.threshold);

  async function createOrder(item) {
    await addOrder({
      productId: item.id,
      productName: item.name,
      barcode: item.barcode,
      manufacturer: item.manufacturer,
      currentQty: item.qty,
      requestedQty: item.threshold * 5,
    });
    toast.success(`הזמנה נוצרה עבור ${item.name}`);
  }

  return (
    <div>
      {/* Need to order */}
      <h3 style={{ marginBottom: "0.75rem" }}>דורשים הזמנה עכשיו</h3>
      {lowItems.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "2rem", marginBottom: "1.5rem" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>כל הפריטים מעל הסף — אין צורך בהזמנה</p>
        </div>
      ) : (
        lowItems.map(item => (
          <div key={item.id} className="card" style={{ marginBottom: 10, borderRight: "3px solid var(--danger)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{item.name}</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{item.manufacturer}</div>
              </div>
              <span className="badge badge-danger">נשאר: {item.qty}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: 10 }}>
              <span>סף הזמנה: {item.threshold} | מוצע להזמין: {item.threshold * 5}</span>
            </div>
            <button
              className="btn btn-primary btn-full"
              onClick={() => createOrder(item)}
              style={{ fontSize: "0.875rem" }}
            >
              🚚 צור הזמנה
            </button>
          </div>
        ))
      )}

      {/* Order history */}
      <h3 style={{ marginBottom: "0.75rem", marginTop: "1.5rem" }}>היסטוריית הזמנות</h3>
      {orders.length === 0 ? (
        <div className="empty-state">
          <span style={{ fontSize: 40, opacity: 0.3 }}>📋</span>
          <p>אין הזמנות עדיין</p>
        </div>
      ) : orders.map(order => (
        <div key={order.id} className="card" style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>{order.productName}</div>
              <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                כמות: {order.requestedQty} יח' · {order.createdAt?.toDate?.().toLocaleDateString("he-IL") || ""}
              </div>
            </div>
            <span className={`badge ${STATUS_COLORS[order.status] || "badge-gray"}`}>{order.status}</span>
          </div>

          {/* Status actions */}
          {order.status !== "התקבל" && order.status !== "בוטל" && (
            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              {order.status === "ממתין לאישור" && (
                <button className="btn btn-secondary" style={{ fontSize: "0.75rem", padding: "5px 10px" }}
                  onClick={() => updateOrderStatus(order.id, "הוזמן")}>
                  ✉️ סמן כהוזמן
                </button>
              )}
              {order.status === "הוזמן" && (
                <button className="btn btn-secondary" style={{ fontSize: "0.75rem", padding: "5px 10px" }}
                  onClick={() => { updateOrderStatus(order.id, "התקבל"); toast.success("הזמנה התקבלה!"); }}>
                  📦 סמן כהתקבל
                </button>
              )}
              <button className="btn btn-danger" style={{ fontSize: "0.75rem", padding: "5px 10px" }}
                onClick={() => updateOrderStatus(order.id, "בוטל")}>
                ✕ בטל
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
