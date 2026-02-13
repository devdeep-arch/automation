// -------------------------------
// INDEX.JS - POSTEX + SHOPIFY + WHATSAPP INTEGRATION
// -------------------------------

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

// ---------------- CONSTANTS ----------------
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

// ---------------- WHATSAPP ----------------
async function sendWhatsAppTemplate(phone, templateName, bodyParams = [], quickReplyPayloads = [], urlButton = null) {
  if (!phone || !templateName) return;

  const components = [];
  if (bodyParams.length) components.push({ type: "body", parameters: bodyParams.map(p => ({ type: "text", text: p })) });
  if (quickReplyPayloads.length) quickReplyPayloads.forEach((p,i)=>components.push({ type:"button", sub_type:"quick_reply", index:i.toString(), parameters:[{type:"payload", payload:p}] }));
  if (urlButton) components.push({ type:"button", sub_type:"url", index:urlButton.index.toString(), parameters:[{type:"text", text:urlButton.url}] });

  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WHATSAPP_NUMBER_ID}/messages`,
      { messaging_product:"whatsapp", to:phone, type:"template", template:{ name:templateName, language:{code:"en"}, components } },
      { headers:{ Authorization:`Bearer ${WHATSAPP_TOKEN}`, "Content-Type":"application/json" } }
    );
  } catch(err) {
    console.error("❌ WhatsApp send error:", err.response?.data || err.message);
  }
}

// ---------------- SHOPIFY HELPERS ----------------
async function updateShopifyOrderNote(orderId, shop, access, note) {
  await fetch(`https://${shop}/admin/api/2024-01/orders/${orderId}.json`, {
    method:"PUT",
    headers:{ "X-Shopify-Access-Token": access, "Content-Type":"application/json" },
    body:JSON.stringify({ order:{ id:orderId, note, tags:note } })
  });
}

async function markShopifyFulfilled(orderId, shop, access, trackingNumber) {
  const url = `https://${shop}/admin/api/2024-01/fulfillments.json`;
  try {
    await axios.post(url, {
      fulfillment:{ location_id: 12345678, tracking_number: trackingNumber, notify_customer:false, line_items:[] }
    }, { headers:{ "X-Shopify-Access-Token":access, "Content-Type":"application/json" } });
  } catch(err) { console.error("❌ Shopify fulfillment error:", err.response?.data || err.message); }
}

// ---------------- POSTEX API ----------------
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
  } catch(err){ console.error("❌ PostEx order create error:", err.response?.data || err.message); }

  return null;
}

// ---------------- EXPRESS ----------------
app.use(express.json());
app.use(express.raw({type:"application/json"}));

// Health
app.get("/health", (_, r)=>r.json({ok:true}));


function verifyShopify(webhook, req, buf) {
  const hmac = req.get("X-Shopify-Hmac-Sha256");
  const hash = crypto.createHmac("sha256", webhook).update(buf).digest("base64");
  return hmac === hash;
}



// WhatsApp Webhook Verify
app.get("/webhook/whatsapp", (req,res)=>{
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===VERIFY_TOKEN_META) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// WhatsApp Button / Confirm / Cancel
app.post("/webhook/whatsapp", async (req,res)=>{
  res.sendStatus(200);

  const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if(!msg) return;

  const phone = normalizePhone(msg.from);
  if(!phone) return;

  let [action, storeId, orderId] = msg.button?.payload?.split(":")||[];
  const storeRef = (path="")=>`stores/${storeId}/${path}`;

  let order = null;
  if(storeId && orderId) order = await dbGet(storeRef(`orders/${orderId}`));
  if(!order){
    // fallback latest
    const latestSnap = await db.ref("stores").once("value");
    const stores = latestSnap.val();
    for(const sId in stores){
      for(const oId in stores[sId].orders||{}){
        const o=stores[sId].orders[oId];
        if(o.customer.phone===phone){ order=o; storeId=sId; orderId=oId; break; }
      }
    }
    if(!order) return;
  }

  const store = await dbGet(storeRef(`secrets`));
  if(!store) return;

  const shop = store.SHOPIFY_SHOP;
  const access = store.SHOPIFY_ACCESS_TOKEN;

  let templateName="", bodyParams=[];

  if(action===PAYLOADS.CONFIRM_ORDER){
    await updateShopifyOrderNote(orderId, shop, access, "✅ Order Confirmed");
    templateName = "order_confirmed_reply";
    bodyParams = [order.customer.name, order.order_name];

    const trackingNumber = await createPostExOrder(order, store);
    if(trackingNumber){
      order.trackingNumber = trackingNumber;
      await markShopifyFulfilled(orderId, shop, access, trackingNumber);
    }

    await dbUpdate(storeRef(`orders/${orderId}`), {
      status:"confirmed", "timeline/confirmedAt":Date.now(), "timeline/lastMsgSentAt":Date.now(), trackingNumber
    });
  }
  else if(action===PAYLOADS.CANCEL_ORDER){
    await updateShopifyOrderNote(orderId, shop, access, "❌ Order Cancelled");
    templateName = "order_cancelled_reply_auto";
    bodyParams=[order.order_name];
    await dbUpdate(storeRef(`orders/${orderId}`), { status:"cancelled","timeline/cancelledAt":Date.now(),"timeline/lastMsgSentAt":Date.now() });
  }

  await sendWhatsAppTemplate(phone, templateName, bodyParams);
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

// ---------------- POSTEX TRACKING CRON ----------------
cron.schedule("*/5 * * * *", async ()=>{
  const storesSnap = await db.ref("stores").once("value");
  const stores = storesSnap.val();
  if(!stores) return;

  for(const storeId in stores){
    const store=stores[storeId].secrets;
    if(!store?.POSTEX_API_TOKEN) continue;

    for(const orderId in stores[storeId].orders||{}){
      const order = stores[storeId].orders[orderId];
      if(!order.trackingNumber || order.status==="delivered") continue;

      try {
        const res = await axios.get(`https://api.postex.pk/services/integration/api/order/v1/track-order/${order.trackingNumber}`, { headers:{ token: store.POSTEX_API_TOKEN } });
        const status = res.data?.dist?.transactionStatus || "";
        let template = null;
        if(status==="Out For Delivery") template="your_order_is_shipped_2025";
        if(status==="Delivered") template="order_delivered";

        if(template) await sendWhatsAppTemplate(order.customer.phone, template, [order.order_name]);
        await dbUpdate(`stores/${storeId}/orders/${orderId}`, { status, "timeline/lastMsgSentAt":Date.now() });
      } catch(e){ console.error("❌ PostEx tracking error:", e.message); }
    }
  }
});

app.listen(PORT, ()=>console.log(`🚀 Server running on ${PORT}`));



