// src/routes/voice-tools.js
// Confirmed working 2026-05-15

const SHOPIFY_DOMAIN = 'plantsbasically.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const LOOP_TOKEN = process.env.LOOP_API || process.env.LOOP_API_KEY;
const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN;
const GORGIAS_EMAIL = process.env.GORGIAS_API_EMAIL;
const GORGIAS_KEY = process.env.GORGIAS_API_KEY;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_KYLE_USER_ID = process.env.SLACK_KYLE_USER_ID;

const REQUIRED_VARS = {
  SHOPIFY_ADMIN_API_ACCESS_TOKEN: SHOPIFY_TOKEN,
  LOOP_API_KEY: LOOP_TOKEN,
  GORGIAS_DOMAIN,
  GORGIAS_API_EMAIL: GORGIAS_EMAIL,
  GORGIAS_API_KEY: GORGIAS_KEY,
  SLACK_WEBHOOK_URL,
};
for (const [name, val] of Object.entries(REQUIRED_VARS)) {
  if (!val) console.warn(`[voice-tools] WARNING: ${name} is not set — tool calls will fail`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const US_PROVINCE_CODES = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS','missouri':'MO',
  'montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH','new jersey':'NJ',
  'new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND','ohio':'OH',
  'oklahoma':'OK','oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC',
  'south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT',
  'virginia':'VA','washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC',
};

function toProvinceCode(province) {
  if (!province) return '';
  if (province.length === 2) return province.toUpperCase();
  return US_PROVINCE_CODES[province.toLowerCase()] || province.substring(0, 2).toUpperCase();
}

// ── Shopify ───────────────────────────────────────────────────────────────────

async function shopify(path, options = {}) {
  const res = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-01/${path}`, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${await res.text()}`);
  return res.json();
}

function orderName(n) {
  return String(n).startsWith('#') ? n : `#${n}`;
}

// ── Gorgias ───────────────────────────────────────────────────────────────────
// Base: https://$GORGIAS_DOMAIN/api/ (NOT /api/v1/ — returns 404)
// Auth: HTTP Basic with GORGIAS_EMAIL:GORGIAS_KEY

async function gorgias(path, options = {}) {
  const credentials = Buffer.from(`${GORGIAS_EMAIL}:${GORGIAS_KEY}`).toString('base64');
  const res = await fetch(`https://${GORGIAS_DOMAIN}${path}`, {
    ...options,
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Gorgias ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Loop Subscriptions (confirmed working 2026-05-15) ────────────────────────
// Base URL: https://api.loopsubscriptions.com/admin/2023-10/
// Auth: X-Loop-Token header
// CRITICAL: always use Loop internal `id` (7-8 digits), never shopifyId

async function loop(path, options = {}) {
  const res = await fetch(`https://api.loopsubscriptions.com/admin/2023-10${path}`, {
    ...options,
    headers: {
      'X-Loop-Token': LOOP_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`Loop ${res.status}: ${await res.text()}`);
  return res.json();
}

// Find a customer's Loop subscription — ownership-verified.
//
// CRITICAL (incident 2026-09-04): Loop's LIST endpoint ignores customer filters.
// `/subscription?customerShopifyId=X` returns page 1 of EVERY subscription in the
// store regardless of X (verified: a bogus id returns the same 50 rows as no filter),
// so the old `subs.find(active) || subs[0]` fallback handed out a random customer's
// contract. For six days straight every subscription lookup returned the same
// stranger's data ("every 4 weeks, $55.00, October 8 2026") — that is also what made
// the 2026-06-24 wrong-cancellation incident possible.
//
// Only two resolution paths are trustworthy, and both are proven by test:
//   1. Shopify order tag "Subscription #<shopifyId>" → GET /subscription/shopify-<id>
//      (a direct document fetch, not a filtered list)
//   2. `/subscription?originOrderShopifyId=<id>` — this filter IS honoured
// Everything resolved is then checked against the customer we are actually helping.
// If ownership cannot be proven we return nothing; we never guess.
//
// Returns { loopId, subscription, customerName, shopifyCustomerId }

function subscriptionOwner(sub) {
  const c = sub?.customer || {};
  return { shopifyId: c.shopifyId != null ? String(c.shopifyId) : null, email: (c.email || '').toLowerCase() };
}

export function ownsSubscription(sub, { shopifyCustomerId, customer_email }) {
  const owner = subscriptionOwner(sub);
  if (shopifyCustomerId && owner.shopifyId && owner.shopifyId === String(shopifyCustomerId)) return true;
  if (customer_email && owner.email && owner.email === String(customer_email).toLowerCase()) return true;
  return false;
}

// Pull "Subscription #<shopifyId>" ids out of a set of Shopify orders, newest first.
export function subscriptionIdsFromOrders(orders) {
  const ids = [];
  for (const o of orders || []) {
    for (const tag of (o.tags || '').split(',')) {
      const t = tag.trim();
      if (t.startsWith('Subscription #')) {
        const id = t.replace('Subscription #', '').trim();
        if (id && !ids.includes(id)) ids.push(id);
      }
    }
  }
  return ids;
}

// Fetch candidate subscriptions by Shopify subscription id and return the best one
// the customer actually owns — preferring an ACTIVE contract over a cancelled one.
async function resolveOwnedSubscription(shopifySubIds, identity) {
  let fallback = null;
  for (const shopifySubId of shopifySubIds.slice(0, 10)) {
    let sub;
    try {
      const data = await loop(`/subscription/shopify-${shopifySubId}`);
      sub = data?.data;
    } catch (e) {
      console.warn(`[loop] subscription shopify-${shopifySubId} lookup failed:`, e.message);
      continue;
    }
    if (!sub?.id) continue;
    if (!ownsSubscription(sub, identity)) {
      console.warn(`[loop] REJECTED shopify-${shopifySubId} — belongs to ${subscriptionOwner(sub).email || 'unknown'}, not this caller`);
      continue;
    }
    if (sub.status?.toLowerCase() === 'active') return sub;
    if (!fallback) fallback = sub;
  }
  return fallback;
}

async function findSubscription(order_number, customer_email) {
  let shopifyOrderId, shopifyCustomerId, customerName, orderTags;

  // Step 1: Resolve the order (when we have one) → customer identity + subscription tag.
  if (order_number != null && String(order_number).trim() !== '') {
    const orderData = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,customer,email,tags`
    );
    if (orderData.orders?.length) {
      const o = orderData.orders[0];
      shopifyOrderId = o.id;
      shopifyCustomerId = o.customer?.id;
      customerName = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim();
      orderTags = o.tags || '';
    }
  }

  // Step 2: Identify the customer by email when the order didn't give us one.
  if (!shopifyCustomerId && customer_email) {
    const custData = await shopify(
      `customers/search.json?query=email:${encodeURIComponent(customer_email)}&fields=id,first_name,last_name`
    );
    const c = custData.customers?.[0];
    if (c) {
      shopifyCustomerId = c.id;
      customerName = customerName || `${c.first_name || ''} ${c.last_name || ''}`.trim();
    }
  }

  const identity = { shopifyCustomerId, customer_email };
  if (!shopifyCustomerId && !customer_email) {
    throw new Error('No customer identified — need an order number or email before looking up a subscription');
  }

  // Step 3: Subscription tag on the caller's own order — the most direct route.
  const tagIds = subscriptionIdsFromOrders([{ tags: orderTags }]);
  if (tagIds.length) {
    const sub = await resolveOwnedSubscription(tagIds, identity);
    if (sub) return { loopId: sub.id, subscription: sub, customerName, shopifyCustomerId };
  }

  // Step 4: Scan the customer's own order history for subscription tags. This is how an
  // email-only lookup finds the RIGHT contract — no unfiltered list query involved.
  if (shopifyCustomerId) {
    try {
      const hist = await shopify(
        `orders.json?customer_id=${shopifyCustomerId}&status=any&limit=50&fields=id,name,created_at,tags`
      );
      const ids = subscriptionIdsFromOrders(hist.orders);
      if (ids.length) {
        const sub = await resolveOwnedSubscription(ids, identity);
        if (sub) return { loopId: sub.id, subscription: sub, customerName, shopifyCustomerId };
      }
    } catch (e) {
      console.warn('[shopify] customer order-history lookup failed:', e.message);
    }
  }

  // Step 5: originOrderShopifyId — this Loop filter is honoured, but still verify ownership.
  if (shopifyOrderId) {
    try {
      const data = await loop(`/subscription?originOrderShopifyId=${shopifyOrderId}`);
      const subs = toArray(data).filter(s => ownsSubscription(s, identity));
      const active = subs.find(s => s.status?.toLowerCase() === 'active') || subs[0];
      if (active?.id) return { loopId: active.id, subscription: active, customerName, shopifyCustomerId };
    } catch (e) {
      console.warn('[loop] originOrderShopifyId lookup failed:', e.message);
    }
  }

  // Nothing we can prove belongs to this customer. Never fall back to a list query.
  throw new Error(
    `No subscription found for ${customer_email || `order ${order_number}`}. Do not guess — tell the customer you can't see a subscription on the account and escalate.`
  );
}

function toArray(data) {
  if (Array.isArray(data)) return data;
  if (data?.subscriptions) return data.subscriptions;
  if (data?.data) return data.data;
  if (data?.id) return [data];
  return [];
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function lookup_account({ email }) {
  try {
    const data = await shopify(
      `customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,email,first_name,last_name,phone,orders_count,total_spent`
    );
    if (!data.customers?.length) return { found: false, message: `No account found for ${email}` };
    const c = data.customers[0];
    return {
      found: true,
      customer_id: c.id,
      name: `${c.first_name} ${c.last_name}`.trim(),
      email: c.email,
      phone: c.phone || null,
      orders_count: c.orders_count,
    };
  } catch (err) {
    console.error('[tool] lookup_account:', err.message);
    return { error: err.message };
  }
}

export async function lookup_by_name({ first_name, last_name }) {
  try {
    const query = `first_name:${first_name} last_name:${last_name}`;
    const data = await shopify(
      `customers/search.json?query=${encodeURIComponent(query)}&fields=id,email,first_name,last_name,phone,orders_count`
    );
    if (!data.customers?.length) return { found: false, message: `No customers found named ${first_name} ${last_name}.` };

    // For any customer with orders, fetch their most recent order
    const results = await Promise.all(data.customers.map(async (c) => {
      let recent_order = null;
      if (c.orders_count > 0) {
        try {
          const orders = await shopify(
            `orders.json?customer_id=${c.id}&status=any&limit=1&fields=id,name,created_at,total_price,financial_status,fulfillment_status`
          );
          const o = orders.orders?.[0];
          if (o) {
            recent_order = {
              order_number: o.name,
              date: new Date(o.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
              total: `$${o.total_price}`,
              financial_status: o.financial_status,
              fulfillment_status: o.fulfillment_status || 'not yet shipped',
            };
          }
        } catch (e) {
          console.warn('[lookup_by_name] order fetch failed for', c.id, e.message);
        }
      }
      return {
        name: `${c.first_name} ${c.last_name}`.trim(),
        email: c.email,
        phone: c.phone || null,
        orders_count: c.orders_count,
        recent_order,
      };
    }));

    return { found: true, matches: results };
  } catch (err) {
    console.error('[tool] lookup_by_name:', err.message);
    return { error: err.message };
  }
}

export async function get_order_status({ order_number, customer_email }) {
  try {
    const query = customer_email
      ? `orders.json?name=${encodeURIComponent(orderName(order_number))}&email=${encodeURIComponent(customer_email)}&status=any&fields=id,name,email,customer,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments,tags`
      : `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,email,customer,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments,tags`;
    const data = await shopify(query);
    if (!data.orders?.length) return { found: false, message: `No order ${order_number} found` };
    const o = data.orders[0];
    const f = o.fulfillments?.[0];
    return {
      found: true,
      order_number: o.name,
      order_id: o.id,
      shopify_admin_url: `https://admin.shopify.com/store/plantsbasically/orders/${o.id}`,
      customer_name: `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim(),
      email: o.email,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status || 'not yet shipped',
      total: `$${o.total_price}`,
      date: new Date(o.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      tracking_number: f?.tracking_number || null,
      tracking_url: f?.tracking_url || null,
      items: o.line_items?.map(i => `${i.quantity}x ${i.name}`).join(', '),
      tags: o.tags || null,
    };
  } catch (err) {
    console.error('[tool] get_order_status:', err.message);
    return { error: err.message };
  }
}

export async function get_subscription_details({ order_number, customer_email }) {
  try {
    const { subscription, customerName } = await findSubscription(order_number, customer_email);
    const line = subscription.lines?.[0];
    const nextDate = subscription.nextBillingDateEpoch
      ? new Date(subscription.nextBillingDateEpoch * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
      : null;
    const bp = subscription.billingPolicy;
    const interval = bp?.intervalCount
      ? `every ${bp.intervalCount} ${bp.interval?.toLowerCase() || 'month'}${bp.intervalCount > 1 ? 's' : ''}`
      : null;
    return {
      found: true,
      customer_name: customerName,
      subscription_status: subscription.status,
      product: line?.productTitle || line?.name || null,
      next_charge_date: nextDate,
      interval,
      price: line?.price ? `$${line.price}` : null,
      paused_at: subscription.pausedAt || null,
    };
  } catch (err) {
    console.error('[tool] get_subscription_details:', err.message);
    return { error: err.message };
  }
}

export async function cancel_subscription({ order_number, customer_email }) {
  // SAFETY DISABLE (incident 2026-06-24): findSubscription could resolve to the WRONG
  // customer's contract when called without a verified order number (the prompt has Milo
  // cancel with email only → order_number undefined → "#undefined" order query → wrong sub).
  // This silently cancelled unrelated customers' subscriptions (e.g. DJ McKenna, cancelled
  // twice from other callers' requests). Until findSubscription verifies ownership, Milo must
  // NOT cancel directly — it escalates to the team to cancel the correct subscription manually.
  try {
    await notify_slack({
      message: `CANCELLATION REQUEST — please cancel the correct subscription manually in Loop. Email: ${customer_email || 'not provided'}. Order: ${order_number || 'not provided'}. (Auto-cancel is disabled pending the wrong-subscription fix.)`,
      urgent: true,
    });
  } catch (err) {
    console.error('[tool] cancel_subscription escalation failed:', err.message);
  }
  return {
    success: true,
    message: "I'll escalate this to a member of our team to cancel your subscription — you'll receive a confirmation email once it's processed. You won't need to do anything else.",
  };
}

// SAFETY (2026-07-11): ALL subscription mutations escalate to a human — Milo is
// informational only. findSubscription's unverified fallback resolved WRONG customers'
// contracts (cancel incident 2026-06-24, address incident 2026-07-11), so no Milo tool
// may write to Loop until ownership verification exists. Pattern: Milo captures the
// request + details, the team executes it manually in Loop.
async function escalateSubscriptionRequest(action, { order_number, customer_email }, detail = '') {
  try {
    await notify_slack({
      message: `${action} REQUEST — please handle manually in Loop. Customer email: ${customer_email || 'not provided'}. Order: ${order_number || 'not provided'}.${detail ? ` ${detail}` : ''} (Milo subscription writes are disabled pending the wrong-subscription fix.)`,
      urgent: true,
    });
  } catch (err) {
    console.error(`[tool] ${action} escalation failed:`, err.message);
  }
  return {
    success: true,
    message: "I've sent this to a member of our team to take care of — you'll receive a confirmation email once it's processed. You won't need to do anything else.",
  };
}

export async function pause_subscription({ order_number, customer_email, pause_months = 1 }) {
  return escalateSubscriptionRequest('PAUSE SUBSCRIPTION', { order_number, customer_email },
    `Pause for ${pause_months} month${Number(pause_months) > 1 ? 's' : ''}.`);
}

export async function reschedule_delivery({ order_number, customer_email, new_delivery_date }) {
  return escalateSubscriptionRequest('RESCHEDULE DELIVERY', { order_number, customer_email },
    `New delivery date: ${new_delivery_date}.`);
}

export async function initiate_return({ order_number, customer_email, reason }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found` };
    const orderId = data.orders[0].id;
    await shopify(`orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: { id: orderId, note: `Return requested via phone. Reason: ${reason}`, tags: 'return-requested' },
      }),
    });
    return { success: true, message: `Return request logged for order ${order_number}. Customer will receive instructions within 1 business day.` };
  } catch (err) {
    console.error('[tool] initiate_return:', err.message);
    return { error: err.message };
  }
}

export async function process_refund({ order_number, customer_email }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,total_price,financial_status,fulfillment_status,line_items`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found` };
    const o = data.orders[0];
    if (Number(o.total_price) === 0) return { message: `Order ${order_number} was a free welcome kit — no refund needed.` };
    if (o.financial_status === 'refunded') return { message: `Order ${order_number} has already been refunded.` };
    if (Number(o.total_price) > 150) return { success: false, message: `Order ${order_number} total is $${o.total_price} — over the $150 limit. Escalate to the team via notify_slack.` };

    // no_restock for all cases — cancel requires a location_id which varies by store config
    const refundLineItems = (o.line_items || []).map(item => ({
      line_item_id: item.id,
      quantity: item.quantity,
      restock_type: 'no_restock',
    }));

    const calcData = await shopify(`orders/${o.id}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: { shipping: { full_refund: true }, refund_line_items: refundLineItems } }),
    });
    const transactions = calcData.refund?.transactions?.map(t => ({
      parent_id: t.parent_id, amount: t.amount, kind: 'refund', gateway: t.gateway,
    }));
    await shopify(`orders/${o.id}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: { notify: true, note: 'Refund via phone — Milo', refund_line_items: refundLineItems, transactions } }),
    });
    return { success: true, message: `Refund of $${o.total_price} processed for order ${order_number}. Confirmation email sent.` };
  } catch (err) {
    console.error('[tool] process_refund:', err.message);
    return { error: err.message };
  }
}

export async function send_portal_link({ customer_email, customer_name }) {
  try {
    const name = customer_name?.split(' ')[0] || 'there';
    await gorgias('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'email',
        via: 'helpdesk',
        from_agent: true,
        customer: { email: customer_email, name: customer_name || customer_email },
        subject: 'Your Plants Basically subscription portal',
        tags: [{ name: 'voice-call' }],
        messages: [{
          channel: 'email',
          via: 'helpdesk',
          from_agent: true,
          public: true,
          body_text: `Hi ${name},\n\nHere's your link to manage your subscription — you can update your payment method, view upcoming orders, and more:\n\nhttps://www.plantsbasically.com/subscriptions\n\nLet us know if you need anything else.\n\n— The Plants Basically Team`,
          sender: { email: GORGIAS_EMAIL, name: 'Plants Basically' },
          receiver: { email: customer_email },
        }],
      }),
    });
    return { success: true, message: `Portal link sent to ${customer_email}.` };
  } catch (err) {
    console.error('[tool] send_portal_link:', err.message);
    return { error: err.message };
  }
}

export async function notify_slack({ message, urgent = false, callback_phone = null, callback_name = null }) {
  try {
    let callbackLine = '';
    if (callback_phone) {
      const host = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : 'https://openclaw-production-ad38.up.railway.app';
      const secret = encodeURIComponent(process.env.SETUP_PASSWORD || '');
      const to = encodeURIComponent(callback_phone);
      const name = encodeURIComponent(callback_name || '');
      callbackLine = `\n📞 *Call Back:* ${host}/voice/callback?to=${to}&name=${name}&s=${secret}`;
    }
    const text = urgent
      ? `🚨 *Escalation needed* — <@${SLACK_KYLE_USER_ID}>\n${message}${callbackLine}`
      : `📞 *Milo voice call note*\n${message}${callbackLine}`;
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);
    return { success: true, message: urgent ? 'Escalation sent to team.' : 'Note sent to team.' };
  } catch (err) {
    console.error('[tool] notify_slack:', err.message);
    return { error: err.message };
  }
}

// Consolidate streaming transcript — consecutive same-role turns get merged,
// keeping the last (most complete) text in each group.
function consolidateTranscript(transcript) {
  const out = [];
  for (const turn of transcript || []) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.text = turn.text;
    } else {
      out.push({ ...turn });
    }
  }
  return out;
}

// Auto-called at end of every call from voice.js — not a Milo tool
export async function logCallToGorgias(log) {
  try {
    if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_KEY) return;

    // Extract customer info from tool results
    let customerEmail, customerName, orderNumber, adminUrl;
    // The number/name Milo verified with the customer for a callback (passed to notify_slack).
    // This is the source of truth for the callback link — the Twilio caller ID can differ
    // from where the customer actually wants to be reached.
    let escalationPhone, escalationName;
    for (const t of log.tools_used || []) {
      if (t.result?.email && !customerEmail) {
        customerEmail = t.result.email;
        customerName = t.result.customer_name || t.result.name;
      }
      if (t.args?.customer_email && !customerEmail) customerEmail = t.args.customer_email;
      if (t.result?.order_number && !orderNumber) orderNumber = t.result.order_number;
      if (t.result?.shopify_admin_url && !adminUrl) adminUrl = t.result.shopify_admin_url;
      if (t.name === 'notify_slack') {
        if (t.args?.callback_phone && !escalationPhone) escalationPhone = t.args.callback_phone;
        if (t.args?.callback_name && !escalationName) escalationName = t.args.callback_name;
      }
    }

    // Outbound bridge calls show the Twilio number as caller_phone — don't use it as customer email
    const TWILIO_NUMBER = process.env.TWILIO_FROM_NUMBER || '+18888682205';
    const isOutboundBridge = log.caller_phone === TWILIO_NUMBER;
    const customerPhone = isOutboundBridge ? null : log.caller_phone;

    // Callback target the agent should dial from the Gorgias ticket. Prefer the number Milo
    // verified during the call (escalationPhone); fall back to caller ID. Never the company line.
    const callbackPhone = [escalationPhone, customerPhone].find(p => p && p !== TWILIO_NUMBER) || null;
    const callbackName = escalationName || customerName || null;

    const callerIdentifier = customerEmail || 'unknown@voice.call';
    const callerLabel = customerName || escalationName || customerPhone || 'Unknown caller';

    // Clean up transcript — dedupe streaming partials
    const turns = consolidateTranscript(log.transcript);

    // First complete caller message = reason for call
    const firstCallerText = turns.find(t => t.role === 'caller')?.text || '(not captured)';
    // Last Milo message = how the call was left
    const lastMiloText = [...turns].reverse().find(t => t.role === 'milo')?.text || '(not captured)';

    // Plain-English action labels
    const TOOL_LABELS = {
      lookup_account: 'Verified customer account',
      get_order_status: 'Pulled up order',
      get_subscription_details: 'Checked subscription',
      cancel_subscription: '🚨 Cancellation request sent to team',
      pause_subscription: '🚨 Pause request sent to team',
      resume_subscription: '🚨 Resume request sent to team',
      reschedule_delivery: '🚨 Reschedule request sent to team',
      update_subscription_frequency: '🚨 Frequency-change request sent to team',
      change_subscription_bottles: '🚨 Bottle-quantity request sent to team',
      cancel_order: 'Cancelled order',
      update_order_address: '🚨 Address-change request sent to team',
      initiate_return: 'Initiated return',
      process_refund: 'Processed refund',
      apply_discount: '🚨 Discount request sent to team',
      notify_slack: '🚨 Escalated to team via Slack',
      send_portal_link: 'Sent subscription portal link',
    };

    const actionLines = (log.tools_used || []).map(t => {
      const label = TOOL_LABELS[t.name] || t.name;
      if (t.result?.found === false) return `• ${label} — not found: ${t.result.message || ''}`;
      if (t.result?.success === false) return `• ${label} — failed: ${t.result.message || ''}`;
      if (t.result?.message) return `• ${label} — ${t.result.message}`;
      if (t.result?.order_number) return `• ${label} — Order ${t.result.order_number} (${t.result.fulfillment_status || 'unknown status'}, ${t.result.total || ''})`;
      return `• ${label}`;
    }).join('\n') || '• No actions taken';

    const minutes = Math.floor(log.duration_seconds / 60);
    const seconds = log.duration_seconds % 60;
    const duration = `${minutes}m ${seconds}s`;

    const subject = orderNumber
      ? `Milo call — ${callerLabel} — Order ${orderNumber}`
      : `Milo call — ${callerLabel}`;

    const transcriptText = turns
      .map(t => `${t.role === 'milo' ? 'Milo' : 'Customer'}: ${t.text}`)
      .join('\n');

    const railwayHost = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'https://openclaw-production-ad38.up.railway.app';
    const setupPassword = process.env.SETUP_PASSWORD || '';
    const callbackLink = callbackPhone
      ? `${railwayHost}/voice/callback?to=${encodeURIComponent(callbackPhone)}&name=${encodeURIComponent(callbackName || callerLabel)}&s=${encodeURIComponent(setupPassword)}`
      : null;

    // Note the caller ID only when it differs from the callback target, so the agent isn't misled.
    const callerIdNote = customerPhone && customerPhone !== callbackPhone
      ? `Called from: ${customerPhone}`
      : '';

    const body = [
      'CUSTOMER',
      `Name: ${callerLabel}`,
      `Email: ${customerEmail || 'not collected'}`,
      `Phone: ${callbackPhone || customerPhone || 'not collected'}`,
      callerIdNote,
      callbackLink ? `📞 Call Back: ${callbackLink}` : '',
      adminUrl ? `Order: ${adminUrl}` : '',
      '',
      'REASON FOR CALL',
      firstCallerText,
      '',
      'WHAT MILO DID',
      actionLines,
      '',
      'HOW IT WAS LEFT',
      lastMiloText,
      '',
      '---',
      `Duration: ${duration}  ·  Call ID: ${log.call_id}`,
      '',
      'FULL TRANSCRIPT',
      transcriptText,
    ].filter(l => l !== undefined).join('\n');

    // messages is required (minItems:1) per Gorgias API spec — must be included in creation
    const ticket = await gorgias('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'phone',
        via: 'helpdesk',
        from_agent: true,
        customer: { email: callerIdentifier, name: callerLabel },
        subject,
        tags: [{ name: 'voice-call' }],
        messages: [{
          channel: 'internal-note',
          via: 'helpdesk',
          from_agent: true,
          public: false,
          body_text: body,
          sender: { email: GORGIAS_EMAIL, name: 'Milo' },
        }],
      }),
    });
    console.log('[auto-gorgias] ticket created:', ticket.id);
    return { success: true, ticket_id: ticket.id };
  } catch (err) {
    console.error('[auto-gorgias] failed:', err.message);
    return { success: false, error: err.message };
  }
}

export async function cancel_order({ order_number, customer_email }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,fulfillment_status,financial_status,total_price`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found.` };
    const o = data.orders[0];
    if (o.fulfillment_status === 'fulfilled') {
      return { success: false, message: `Order ${order_number} has already shipped and cannot be cancelled. Offer a return instead.` };
    }
    if (o.financial_status === 'voided' || o.financial_status === 'refunded') {
      return { success: false, message: `Order ${order_number} is already cancelled or refunded.` };
    }
    await shopify(`orders/${o.id}/cancel.json`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'customer', email: true }),
    });
    return { success: true, message: `Order ${order_number} cancelled. Customer will receive a confirmation email.` };
  } catch (err) {
    console.error('[tool] cancel_order:', err.message);
    return { error: err.message };
  }
}

// SAFETY CHANGE (2026-07-11): Milo no longer writes shipping addresses directly.
// Two incidents drove this: (1) an incomplete spoken address ("2437 Unit Number 1" — no
// street name) was saved verbatim and shipped to the wrong place, overwriting a human
// agent's earlier correction (order 116037); (2) the Loop subscription side-effect used
// findSubscription's unverified fallback and could overwrite a STRANGER's subscription
// address — same wrong-contract class as the cancel bug. Now this tool tags + notes the
// order and escalates urgently so a human agent verifies and applies the address.
export async function update_order_address({ order_number, address1, address2 = '', city, province, zip, country_code = 'US' }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,note,tags,fulfillment_status,shipping_address,customer,email`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found.` };
    const o = data.orders[0];
    const customerName = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim();
    const formatted = [address1, address2, city, province, zip].filter(Boolean).join(', ');
    const adminUrl = `https://admin.shopify.com/store/plantsbasically/orders/${o.id}`;

    if (o.fulfillment_status === 'fulfilled') {
      return { success: false, message: `Order ${order_number} has already shipped — address cannot be changed. Notify the team to arrange a replacement to the correct address.` };
    }

    // Note + tag the order so anyone opening it sees the pending change
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const noteLine = `[${stamp} UTC] Customer called — change shipping address to: ${formatted} BEFORE shipping. (via Milo)`;
    const newNote = o.note ? `${o.note}\n${noteLine}` : noteLine;
    const tags = (o.tags || '').split(',').map(t => t.trim()).filter(Boolean);
    if (!tags.includes('address-change-requested')) tags.push('address-change-requested');
    await shopify(`orders/${o.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ order: { id: o.id, note: newNote, tags: tags.join(', ') } }),
    });

    // Escalate to the team to verify + apply the address
    try {
      await notify_slack({
        message: `ADDRESS CHANGE REQUEST — order ${order_number} (${customerName}, ${o.email || 'no email'}) has NOT shipped yet. Customer wants it sent to: ${formatted}. Please verify the address is real/complete and update the order before it ships. ${adminUrl}`,
        urgent: true,
      });
    } catch (e) {
      console.error('[tool] update_order_address escalation failed:', e.message);
    }

    return {
      success: true,
      message: `I've flagged this for our team with the new address — an agent will verify it and update the order before it ships. You'll get a confirmation once it's changed. New address on file for the team: ${formatted}.`,
    };
  } catch (err) {
    console.error('[tool] update_order_address:', err.message);
    return { error: err.message };
  }
}

export async function update_subscription_frequency({ order_number, customer_email, interval_count, interval = 'WEEK' }) {
  const count = Number(interval_count);
  return escalateSubscriptionRequest('CHANGE SUBSCRIPTION FREQUENCY', { order_number, customer_email },
    `New cadence: every ${count} ${interval.toLowerCase()}${count > 1 ? 's' : ''}.`);
}

export async function apply_discount({ order_number, customer_email, percent = 5, orders = 1 }) {
  return escalateSubscriptionRequest('APPLY RETENTION DISCOUNT', { order_number, customer_email },
    `${percent}% off the next ${orders} order${orders > 1 ? 's' : ''} (retention save).`);
}

export async function resume_subscription({ order_number, customer_email }) {
  return escalateSubscriptionRequest('RESUME SUBSCRIPTION', { order_number, customer_email });
}

export async function change_subscription_bottles({ order_number, customer_email, bottles }) {
  const count = Number(bottles);
  if (![1, 2, 3].includes(count)) return { error: 'bottles must be 1, 2, or 3.' };
  return escalateSubscriptionRequest('CHANGE BOTTLE QUANTITY', { order_number, customer_email },
    `New quantity: ${count} bottle${count > 1 ? 's' : ''} per delivery.`);
}

const TOOLS = {
  lookup_account, lookup_by_name, get_order_status, get_subscription_details,
  cancel_subscription, pause_subscription, resume_subscription, reschedule_delivery,
  initiate_return, process_refund, cancel_order, apply_discount, update_subscription_frequency,
  change_subscription_bottles, update_order_address, send_portal_link, notify_slack,
};

// Names the model reaches for that aren't real server tools. xAI sometimes invents
// `collections_search` when it means its own built-in file_search over the product docs
// (seen 4x in 50 calls, 2026-09-04). A bare "Unknown tool" error left Milo improvising an
// answer mid-call, so say plainly what to do instead of failing blank.
const PHANTOM_TOOLS = {
  collections_search: "That tool does not exist here. Product and ingredient knowledge is in your own file search — use that. If you still do not know the answer, say you are not certain and offer to have the team follow up. Never guess at product facts, policies, or anything about the customer's account.",
  search: 'That tool does not exist here. Use your own file search for product knowledge, or the account tools for customer data.',
  web_search: 'That tool does not exist here. Use your own file search for product knowledge, or the account tools for customer data.',
};

export async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) {
    const guidance = PHANTOM_TOOLS[name];
    if (guidance) {
      console.warn(`[tool] phantom tool called: ${name}`);
      return { error: guidance };
    }
    return { error: `Unknown tool: ${name}. Do not guess — tell the customer you'll have the team follow up.` };
  }
  return fn(args);
}
