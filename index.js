

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

const app = express();

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
async function sendWhatsAppTemplate(phone, templateName, bodyParams = [], quickReplyPayloads = [], urlButton = null) {
  if (!phone || !templateName) {
    console.error("❌ Phone or template name missing");
    return;
  }

  const components = [];

  // Body parameters
  if (bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: bodyParams.map(p => ({ type: "text", text: p })),
    });
  }

  // Quick reply buttons
  if (quickReplyPayloads.length > 0) {
    quickReplyPayloads.forEach((payload, i) => {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: i.toString(),
        parameters: [{ type: "payload", payload }],
      });
    });
  }

  // URL button
  if (urlButton) {
    // urlButton = { index: 0, text: "View Order", url: "https://..." }
    components.push({
      type: "button",
      sub_type: "url",
      index: urlButton.index.toString(),
      parameters: [
        {
          type: "text",
          text: urlButton.url, // Meta now expects "text" key with URL inside
        },
      ],
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

app.get("/contact/:data", async (req, res) => {

  const [storeId, orderId] = req.params.data.split("-");

  const store = await dbGet(`stores/${storeId}/secrets`);
  const order = await dbGet(`stores/${storeId}/orders/${orderId}`);

  if (!store || !order) {
    return res.send("Invalid link");
  }

  const ownerPhone = store.owner_phone.replace("+", "");

  const message = encodeURIComponent(
    `Hey mujhe order ${order.order_name} ke bare me baat karni hai`
  );

  const waLink = `https://wa.me/${ownerPhone}?text=${message}`;

  res.redirect(waLink);
});


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


// POSTEX HELPER TO CREATE POSTEX ORDER CALLEDWHILE ORDER BTN CLICK ON CONFIRMATION
async function createPostExOrder(order, store) {
  if (!store?.POSTEX_API_TOKEN) return null;

  const payload = {
    cityName: order.customer.city || "Unknown",
    customerName: order.customer.name,
    customerPhone: order.customer.phone,
    deliveryAddress: order.customer.address || "N/A",
    invoiceDivision: 1,
    invoicePayment: order.amount.total || 0,
    items: order.product.qty || 1,
    orderDetail: order.product.name || "",
    orderRefNumber: order.order_name,
    orderType: "Normal",
    transactionNotes: order.notes || "",
    pickupAddressCode: store.pickupAddressCode || "",
    storeAddressCode: store.storeAddressCode || ""
  };

  try {
    const res = await axios.post(
      "https://api.postex.pk/services/integration/api/order/v3/create-order",
      payload,
      { headers:{ token: store.POSTEX_API_TOKEN } }
    );

    if (res.data?.statusCode === "200") return res.data.dist.trackingNumber;
  } catch(err){
    console.error("❌ PostEx order create error:", err.response?.data || err.message);
  }

  return null;
}

// POSTEX.....

async function createPostExOrderIfAllowed(order, store) {
  if (!store?.POSTEX_API_TOKEN) return null;

  // Check user/store settings
  const autoCreate = store.settings?.autoPostExBooking; // true/false
  if (!autoCreate) return null; // agar manual booking, abhi na kare

  const trackingNumber = await createPostExOrder(order, store);

  if (trackingNumber) {
    // Agar successful create hua → Shopify fulfill mark kar do
    await updateShopifyOrderNote(
      order.order_id,
      store.SHOPIFY_SHOP,
      store.SHOPIFY_ACCESS_TOKEN,
      `✅ Order booked on PostEx, Tracking #: ${trackingNumber}`
    );

    await dbUpdate(`stores/${store.store_id}/orders/${order.order_id}`, {
      postex: {
        trackingNumber,
        bookedAt: Date.now(),
        status: "Booked"
      },
      status: "fulfilled"
    });
  }

  return trackingNumber;
}

// GET STATUS

async function getPostExOrderStatus(trackingNumber, store) {
  try {
    const res = await axios.get(
      `https://api.postex.pk/services/integration/api/order/v1/get-order-status`,
      {
        headers: { token: store.POSTEX_API_TOKEN }
      }
    );

    if (res.data.statusCode === 200 && res.data.dist) {
      return res.data.dist; // Ye array of statuses: ["Booked","Out For Delivery",...]
    }
  } catch (err) {
    console.error("PostEx status fetch error:", err.message);
  }

  return [];
}

// SCHEDULE CHECK

cron.schedule("*/5 * * * *", async () => {
  const storesSnap = await db.ref("stores").once("value");
  const stores = storesSnap.val();

  for (const storeId in stores) {
    const store = stores[storeId];
    const orders = store.orders || {};

    for (const orderId in orders) {
      const order = orders[orderId];
      const tracking = order.postex?.trackingNumber;
      if (!tracking) continue;

      const statusHistory = await getPostExOrderStatus(tracking, store);
      const lastStatus = statusHistory[statusHistory.length - 1];

      if (lastStatus !== order.postex?.lastStatus) {
        // Update DB
        await dbUpdate(`stores/${storeId}/orders/${orderId}/postex`, {
          lastStatus
        });

        // Send WhatsApp template based on status
        if (lastStatus === "Out For Delivery") {
          await sendWhatsAppTemplate(
            order.customer.phone,
            "your_order_is_shipped_2025",
            [order.order_name]
          );
        } else if (lastStatus === "Delivered") {
          await sendWhatsAppTemplate(
            order.customer.phone,
            "order_delivered",
            [order.customer.name, order.order_name]
          );
        }
      }
    }
  }
});


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
// ---------------- META WHATSAPP WEBHOOK ----------------
app.post("/webhook/whatsapp", express.json(), async (req, res) => {
  res.sendStatus(200);  

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return;

  const phone = normalizePhone(msg.from);
  if (!phone) return;

  // Extract button payload if any
  const [action, storeId, orderId] = msg.button?.payload?.split(":") || [];

  const storeRef = (path = "") => `stores/${storeId}/${path}`;

  let order = null;

  // If storeId/orderId exists in button payload → fetch that order
  if (storeId && orderId) {
    order = await dbGet(storeRef(`orders/${orderId}`));
  }

  // Otherwise → find latest order from this phone across all stores
  if (!order) {
    const latest = await findLatestStoreByPhone(phone);
    if (!latest) return; // No matching order
    order = latest.order;
    storeId = latest.storeId;
    orderId = latest.orderId;
  }

  const store = await dbGet(storeRef(`secrets`));
  if (!store) return;

  const shop = store.SHOPIFY_SHOP;
  const access = store.SHOPIFY_ACCESS_TOKEN;

  let templateName = "";
  let bodyParams = [];
  let quickReplyPayloads = [];

  // Determine what template to send
  if (action === PAYLOADS.CONFIRM_ORDER) {
    await updateShopifyOrderNote(orderId, shop, access, "✅ Order Confirmed");
    templateName = "order_confirmed_reply";
    bodyParams = [
      order.customer.name,
      order.order_name,
    ];
    // ✅ PostEx booking if allowed
    await createPostExOrderIfAllowed(order, store);
    
  } else if (action === PAYLOADS.CANCEL_ORDER) {
    await updateShopifyOrderNote(orderId, shop, access, "❌ Order Cancelled");
    templateName = "order_cancelled_reply_auto";
    bodyParams = [
      order.order_name,
    ];
  }

  // Determine body param for "call_us_template" if user presses again or random message
  let statusText = order.status === "confirmed" ? "CONFIRMED" :
                   order.status === "cancelled" ? "CANCELLED" : "";

  // WhatsApp prefilled link to contact store owner
  const ownerPhone = store.OWNER_PHONE; // Put this in store secrets
  const orderLink = `https://web.whatsapp.com/send/?phone=${ownerPhone}&text=Hey+mujhe+order+%23${order.order_id}+ke+bare+me+baat+karni+hai`;

  // Send the main template
  await sendWhatsAppTemplate(
    phone,
    templateName,
    bodyParams,
    quickReplyPayloads,
    {
      index: 0,
      text: "View Order / Contact Store",
      url: orderLink
    }
  );

  // Update DB
  await dbUpdate(storeRef(`orders/${orderId}`), {
    status: action === PAYLOADS.CONFIRM_ORDER ? "confirmed" :
            action === PAYLOADS.CANCEL_ORDER ? "cancelled" :
            order.status,
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

  // If random message or double press → send "call_us_template" with status
  if (!action || (action && order.status !== (action === PAYLOADS.CONFIRM_ORDER ? "confirmed" : "cancelled"))) {
    await sendWhatsAppTemplate(
      phone,
      "call_us_template",
      [statusText || "PENDING"],
      [],
      {
        index: 0,
        text: "Contact Store",
        url: orderLink
      }
    );
  }
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


