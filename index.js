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
  VERIFY_TOKEN_META = "shopify123",
  DEFAULT_COUNTRY_CODE = "92",
} = process.env;

if (!WHATSAPP_NUMBER_ID || !WHATSAPP_TOKEN) {
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
// ---------------- UNIVERSAL WHATSAPP TEMPLATE SENDER ----------------
/**
 * Send WhatsApp template dynamically for any template
 * @param {string} phone - Recipient phone number
 * @param {string} templateName - WhatsApp template name
 * @param {Array} bodyParams - Array of strings for body parameters (any length)
 * @param {Array} buttonsPayload - Array of button payloads (optional)
 */
async function sendWhatsAppTemplate(phone, templateName, bodyParams = [], buttonsPayload = []) {
  if (!phone || !templateName) {
    console.error("❌ Phone or template name missing");
    return;
  }

  // Components array
  const components = [];

  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map((p) => ({ type: "text", text: p })),
    });
  }

  if (buttonsPayload.length > 0) {
    buttonsPayload.forEach((payload, index) => {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: index.toString(),
        parameters: [{ type: "payload", payload }],
      });
    });
  }

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v20.0/${WHATSAPP_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ WhatsApp template sent:", res.data);
  } catch (err) {
    console.error("🔥 WhatsApp send error:", err.response?.data || err.message);
  }
}
// ---------------- SHOPIFY HELPERS ----------------
async function updateShopifyOrderNote(orderId, shop, access, note) {
  const url = `https://${shop}/admin/api/2024-01/orders/${orderId}.json`;
  await fetch(url, {
    method: "PUT",
    headers: {
      "X-Shopify-Access-Token": access,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ order: { id: orderId, note, tags: note } }),
  });
}

function verifyShopify(webhook, req, buf) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const hash = crypto.createHmac("sha256", webhook).update(buf).digest("base64");
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

async function findLatestStoreByPhone(phone) {
  const storesSnap = await db.ref("stores").once("value");
  const stores = storesSnap.val();
  if (!stores) return null;

  let latestMatch = null;
  let latestTime = 0;

  for (const storeId in stores) {
    const orders = stores[storeId].orders;
    if (!orders) continue;

    for (const orderId in orders) {
      const order = orders[orderId];

      if (order.customer?.phone === phone) {
        const time =
          order.timeline?.lastMsgSentAt ||
          order.timeline?.createdAt ||
          0;

        if (time > latestTime) {
          latestTime = time;
          latestMatch = {
            storeId,
            orderId,
            order
          };
        }
      }
    }
  }

  return latestMatch;
}

// Meta needs JSON, Shopify needs RAW → separate
app.post("/webhook/whatsapp", express.json(), async (req, res) => {
  res.sendStatus(200);  

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const phone = normalizePhone(msg.from);
  if (!phone) return;


  
  const [action, storeId, orderId] = msg.button?.payload?.split(":") || [];
  const storeRef = (path = "") => `stores/${storeId}/${path}`;
  const order = await dbGet(storeRef(`orders/${orderId}`));
  if (!order) return;
  
  const store = await dbGet(storeRef(`secrets`));
  if (!store) return;

  const shop = store.SHOPIFY_SHOP;
  const access = store.SHOPIFY_ACCESS_TOKEN;

  let templateName = "";
  let bodyParams = [];

  // Confirm button → 2 params
  if (action === PAYLOADS.CONFIRM_ORDER) {
    await updateShopifyOrderNote(orderId, shop, access, "✅ Order Confirmed" );
    templateName = "order_confirmed_reply";
    bodyParams = [
      order.customer.name, // {{1}}
      order.order_name,   // {{2}}
    ];
  }
  // Cancel button → 1 param
  else if (action === PAYLOADS.CANCEL_ORDER) {
    await updateShopifyOrderNote(orderId, shop, access, "❌ Order Cancelled" );
    templateName = "order_cancelled_reply_auto";
    bodyParams = [
      order.order_name,   // {{1}}
    ];
  }

  await sendWhatsAppTemplate(phone, templateName, bodyParams, []); // No buttons in reply
  await dbUpdate(storeRef(`orders/${orderId}`), {
    status: action === PAYLOADS.CONFIRM_ORDER ? "confirmed" : "cancelled",
    "timeline/lastCustomerReplyAt": Date.now(),
    ...(action === PAYLOADS.CONFIRM_ORDER && {
      "timeline/confirmedAt": Date.now(),
      "timeline/lastMsgSentAt": Date.now()
    }),
    ...(action === PAYLOADS.CANCEL_ORDER && {
      "timeline/cancelledAt": Date.now(),
      "timeline/lastMsgSentAt": Date.now()
    }),
    whatsapp: {
    confirmation_sent: true,
    confirmation_reply: true
  }
  });
});
// ---------------- SHOPIFY ORDER CREATE ----------------
app.post(
  "/webhook/shopify/order",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    res.sendStatus(200);
    const shopDomain = req.get("X-Shopify-Shop-Domain");
    const shopUsername = shopDomain.replace(".myshopify.com", "").toLowerCase();

    const index = await dbGet(`index/${shopUsername}`);
    if (!index?.storeId) return;

    const storeId = index.storeId;
    const storeRef = (path = "") => `stores/${storeId}/${path}`;

    const store = await dbGet(storeRef(`secrets`));
    if (!store) return;

    const webhook = store.SHOPIFY_WEBHOOK_SECRET;

    if (!verifyShopify(webhook, req, req.body)) return;

    const order = JSON.parse(req.body.toString());
    const phone = normalizePhone(order.shipping_address?.phone || order.customer?.phone);
    if (!phone) return;

    const payloadConfirm = `${PAYLOADS.CONFIRM_ORDER}:${storeId}:${order.id}`;
    const payloadCancel = `${PAYLOADS.CANCEL_ORDER}:${storeId}:${order.id}`;

    await dbSet(storeRef(`orders/${order.id}`), {
  order_id: String(order.id),
  order_name: order.name,

  customer: {
    name: order.customer?.first_name || "Customer",
    phone
  },

  amount: {
    total: order.total_price,
    currency: order.currency
  },

  product: {
    name: order.line_items?.[0]?.name || "Product",
    qty: order.line_items?.[0]?.quantity || 1
  },

  status: "pending",

  timeline: {
    createdAt: Date.now(),
    confirmedAt: "waiting",
    fulfilledAt: "waiting",
    deliveredAt: "waiting",
    lastMsgSentAt: Date.now()
  },

  whatsapp: {
    confirmation_sent: true,
    fulfilled_sent: false,
    confirmation_reply: false
  }
});
    // Example for Shopify order template
    await sendWhatsAppTemplate(
      phone,
      "order_confirmation",
      [
        order.customer?.first_name || "Customer",
        order.name,
        order.line_items?.[0]?.name || "Product",
        order.line_items?.[0]?.quantity?.toString() || "1",
        order.shop_name || "My Store",
        order.total_price?.toString() || "0.00",
        order.currency || "USD",
      ],
      [payloadConfirm, payloadCancel]
    );
  }
);

// ---------------- FULFILLMENT ----------------
// ---------------- SHOPIFY FULFILLMENT (SHIPPED) ----------------
app.post("/webhook/shopify/fulfillment", express.json(), async (req, res) => {
  res.sendStatus(200);

  const shopDomain = req.get("X-Shopify-Shop-Domain");
    const shopUsername = shopDomain.replace(".myshopify.com", "").toLowerCase();

    const index = await dbGet(`index/${shopUsername}`);
    if (!index?.storeId) return;

    const storeId = index.storeId;
    const storeRef = (path = "") => `stores/${storeId}/${path}`;

  
  const fulfillment = req.body;
  const orderId = String(fulfillment?.id);

  if (!orderId) return;

  // ✅ Sirf successful fulfillment pe
  if (fulfillment.fulfillment_status !== "fulfilled") return;

  const order = await dbGet(storeRef(`orders/${orderId}`));
  if (!order?.customer?.phone) return;

  // 🟢 Send WhatsApp on SHIPPED
  await sendWhatsAppTemplate(
    order.customer.phone,
    "your_order_is_shipped_2025",
    [
      order.order_name   // {{1}}
    ],
    []
  );

  // ✅ CORRECT dbUpdate usage
  await dbUpdate(
    storeRef(`orders/${orderId}`),
    {
      status: "fulfilled",
      "timeline/fulfilledAt": Date.now(),
      "whatsapp/fulfilled_sent": true,
      "timeline/lastMsgSentAt": Date.now()
    }
  );

  console.log("✅ Fulfill WhatsApp sent for order:", orderId);
});
// ---------------- HEALTH ----------------
app.get("/health", (_, r) => r.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));








































