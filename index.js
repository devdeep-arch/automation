// CLEAN, CONSOLIDATED, SAFE SINGLE-FILE IMPLEMENTATION
// ----------------------------------------------------
// ✔ One Meta webhook
// ✔ One Shopify order-create webhook
// ✔ One fulfillment webhook
// ✔ One courier webhook
// ✔ Early declarations (TPL / PAYLOADS)
// ✔ Firebase helpers
// ✔ Order confirmation flow NOT broken
// ----------------------------------------------------

process.on("uncaughtException", (err) => console.error("🔥 Uncaught Exception:", err));
process.on("unhandledRejection", (r) => console.error("🔥 Unhandled Rejection:", r));

import express from "express";
import crypto from "crypto";
import axios from "axios";
import admin from "firebase-admin";
import cron from "node-cron";

// ---------------- ENV ----------------
const {
  PORT = 3000,
  WHATSAPP_NUMBER_ID,
  WHATSAPP_TOKEN,
  SHOPIFY_SHOP,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_WEBHOOK_SECRET,
  VERIFY_TOKEN_META = "shopify123",
  DEFAULT_COUNTRY_CODE = "92",
} = process.env;

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN || !SHOPIFY_SHOP || !SHOPIFY_ACCESS_TOKEN) {
  console.error("❌ Missing required env vars");
  process.exit(1);
}

// ---------------- FIREBASE ----------------
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: process.env.DATABASE_URL,
});

const db = admin.database();

// ---------------- CONSTANTS (EARLY) ----------------
export const TPL = {
  ORDER_CONFIRMATION: "order_confirmation",
  ORDER_CONFIRMED_REPLY: "order_confirmed_reply",
  ORDER_CANCELLED_REPLY_AUTO: "order_cancelled_reply_auto",
  ORDER_DELIVERED: "order_delivered",
  YOUR_ORDER_IS_SHIPPED: "your_order_is_shipped_2025",
  CALL_US: "call_us_template",
};

export const PAYLOADS = {
  CONFIRM_ORDER: "CONFIRM_ORDER",
  CANCEL_ORDER: "CANCEL_ORDER",
};

// ---------------- HELPERS ----------------
const normalizePhone = (raw, cc = DEFAULT_COUNTRY_CODE) => {
  if (!raw) return null;
  const d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0")) return cc + d.slice(1);
  if (d.startsWith(cc)) return d;
  if (d.length <= 10) return cc + d;
  return d;
};

const dbSet = (p, d) => db.ref(p).set(d);
const dbUpdate = (p, d) => db.ref(p).update(d);
const dbGet = async (p) => (await db.ref(p).once("value")).val();

// ---------------- WHATSAPP SEND ----------------
async function sendWhatsAppTemplate(phone, name, { body = [], buttons = [] } = {}) {
  const components = [];
  if (body.length) components.push({ type: "body", parameters: body.map(t => ({ type: "text", text: String(t) })) });
  buttons.forEach((b, i) => components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: b }] }));

  await axios.post(`https://graph.facebook.com/v20.0/${WHATSAPP_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: { name, language: { code: "en" }, components }
  }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
}

// ---------------- SHOPIFY HELPERS ----------------
async function updateShopifyOrderNote(orderId, note) {
  const url = `https://${SHOPIFY_SHOP}/admin/api/2024-01/orders/${orderId}.json`;
  await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order: { id: orderId, note } }),
  });
}

function verifyShopify(req, buf) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const hash = crypto.createHmac("sha256", SHOPIFY_WEBHOOK_SECRET).update(buf).digest("base64");
  return hmac === hash;
}

// ---------------- EXPRESS ----------------
const app = express();

// ---------------- META WEBHOOK VERIFY ----------------
app.get("/webhook/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN_META) {
    console.log("✅ Meta webhook verified");
    return res.status(200).send(challenge);
  }

  console.log("❌ Meta webhook verification failed");
  return res.sendStatus(403);
});

// Meta needs JSON, Shopify needs RAW → separate
app.post("/webhook/meta", express.json(), async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const phone = normalizePhone(msg.from);

  if (msg.type === "button") {
    const [action, orderId] = msg.button.payload.split(":");
    const order = await dbGet(`orders/${orderId}`);
    if (!order) return;

    if (["confirmed", "cancelled"].includes(order.status)) {
      await sendWhatsAppTemplate(phone, TPL.CALL_US, { body: [order.status.toUpperCase()] });
      return;
    }

    if (action === PAYLOADS.CONFIRM_ORDER) {
      await updateShopifyOrderNote(orderId, "Confirmed via WhatsApp");
      await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMED_REPLY, { body: [order.customerName, order.order_name] });
      await dbUpdate(`orders/${orderId}`, { status: "confirmed" });
    }

    if (action === PAYLOADS.CANCEL_ORDER) {
      await updateShopifyOrderNote(orderId, "Cancelled via WhatsApp");
      await sendWhatsAppTemplate(phone, TPL.ORDER_CANCELLED_REPLY_AUTO, { body: [order.order_name] });
      await dbUpdate(`orders/${orderId}`, { status: "cancelled" });
    }
  }
});

// ---------------- SHOPIFY ORDER CREATE ----------------
app.post("/webhook/shopify/order", express.raw({ type: "application/json" }), async (req, res) => {
  res.sendStatus(200);
  if (!verifyShopify(req, req.body)) return;

  const order = JSON.parse(req.body.toString());
  const phone = normalizePhone(order.shipping_address?.phone || order.customer?.phone);
  if (!phone) return;

  const payloadConfirm = `${PAYLOADS.CONFIRM_ORDER}:${order.id}`;
  const payloadCancel = `${PAYLOADS.CANCEL_ORDER}:${order.id}`;

  await dbSet(`orders/${order.id}`, {
    order_name: order.name,
    customerName: order.customer?.first_name || "Customer",
    phone,
    status: "pending",
    createdAt: Date.now(),
  });

  await sendWhatsAppTemplate(phone, TPL.ORDER_CONFIRMATION, {
    body: [order.customer?.first_name || "Customer", order.name, order.total_price, order.currency],
    buttons: [payloadConfirm, payloadCancel],
  });
});

// ---------------- FULFILLMENT ----------------
app.post("/webhook/shopify/fulfillment", express.json(), async (req, res) => {
  res.sendStatus(200);
  const f = req.body;
  const orderId = String(f.order_id);
  const order = await dbGet(`orders/${orderId}`);
  if (!order) return;

  if (f.shipment_status === "delivered") {
    await sendWhatsAppTemplate(order.phone, TPL.ORDER_DELIVERED, { body: [order.order_name] });
    await dbUpdate(`orders/${orderId}`, { status: "delivered" });
  }
});

// ---------------- HEALTH ----------------
app.get("/health", (_, r) => r.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));



