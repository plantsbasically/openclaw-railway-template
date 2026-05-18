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

// Find Loop internal subscription ID from an order number.
// Priority: Shopify order tag "Subscription #shopifyId" → direct Loop lookup via shopify-{id}
// Falls back to originOrderShopifyId, then customerShopifyId.
// Returns { loopId, customerName, shopifyCustomerId }
async function findSubscription(order_number, customer_email) {
  let shopifyOrderId, shopifyCustomerId, customerName, orderTags;

  // Step 1: Get Shopify order → extract IDs, customer name, and tags
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

  // Step 2: Best method — parse "Subscription #shopifyId" tag and look up directly
  // Loop accepts shopify-{shopifyId} path format per API docs
  const subTag = orderTags?.split(',').map(t => t.trim()).find(t => t.startsWith('Subscription #'));
  if (subTag) {
    const shopifySubId = subTag.replace('Subscription #', '').trim();
    try {
      const data = await loop(`/subscription/shopify-${shopifySubId}`);
      const sub = data?.data;
      if (sub?.id) {
        console.log('[loop] found via order tag shopify-' + shopifySubId + ' → loopId', sub.id);
        return { loopId: sub.id, subscription: sub, customerName, shopifyCustomerId };
      }
    } catch (e) {
      console.warn('[loop] shopify subscription tag lookup failed:', e.message);
    }
  }

  // Step 3: Fall back to originOrderShopifyId
  if (shopifyOrderId) {
    try {
      const data = await loop(`/subscription?originOrderShopifyId=${shopifyOrderId}`);
      const subs = toArray(data);
      const active = subs.find(s => s.status?.toLowerCase() === 'active') || subs[0];
      if (active?.id) return { loopId: active.id, subscription: active, customerName, shopifyCustomerId };
    } catch (e) {
      console.warn('[loop] originOrderShopifyId lookup failed:', e.message);
    }
  }

  // Step 3: Fall back to customer's Shopify ID
  if (shopifyCustomerId) {
    const data = await loop(`/subscription?customerShopifyId=${shopifyCustomerId}`);
    const subs = toArray(data);
    const active = subs.find(s => s.status?.toLowerCase() === 'active') || subs[0];
    if (active?.id) return { loopId: active.id, subscription: active, customerName, shopifyCustomerId };
  }

  // Step 4: Last resort — look up by email if provided
  if (customer_email) {
    const custData = await shopify(`customers/search.json?query=email:${encodeURIComponent(customer_email)}&fields=id`);
    if (custData.customers?.length) {
      const custId = custData.customers[0].id;
      const data = await loop(`/subscription?customerShopifyId=${custId}`);
      const subs = toArray(data);
      const active = subs.find(s => s.status?.toLowerCase() === 'active') || subs[0];
      if (active?.id) return { loopId: active.id, subscription: active, customerName, shopifyCustomerId: custId };
    }
  }

  throw new Error(`No subscription found for order ${order_number}`);
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
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    await loop(`/subscription/${loopId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({
        cancellationReason: 'Other',
        cancellationComment: 'Customer requested cancellation via phone support',
      }),
    });
    return { success: true, message: `Subscription cancelled for ${customerName}. They'll receive a confirmation email.` };
  } catch (err) {
    console.error('[tool] cancel_subscription:', err.message);
    return { error: err.message };
  }
}

export async function pause_subscription({ order_number, customer_email, pause_months = 1 }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    const resumeDate = new Date();
    resumeDate.setMonth(resumeDate.getMonth() + Number(pause_months));
    const body = {
      pauseDuration: {
        intervalType: 'MONTH',
        intervalCount: Number(pause_months),
      },
    };
    const result = await loop(`/subscription/${loopId}/pause`, { method: 'POST', body: JSON.stringify(body) });
    console.log('[tool] pause_subscription loopId:', loopId, 'response:', JSON.stringify(result));
    if (result?.success === false) {
      return { success: false, loop_id: loopId, loop_response: result, message: result.message || 'Loop declined the pause.' };
    }
    return { success: true, loop_id: loopId, loop_response: result, message: `Subscription paused for ${customerName} for ${pause_months} month${Number(pause_months) > 1 ? 's' : ''}. Resumes around ${resumeDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}.` };
  } catch (err) {
    console.error('[tool] pause_subscription:', err.message);
    return { error: err.message };
  }
}

export async function reschedule_delivery({ order_number, customer_email, new_delivery_date }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    const epoch = Math.floor(new Date(new_delivery_date).getTime() / 1000);
    if (isNaN(epoch)) return { error: `Invalid date: ${new_delivery_date}. Use YYYY-MM-DD format.` };
    const result = await loop(`/subscription/${loopId}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ newBillingDateEpoch: epoch, rescheduleFutureOrders: false }),
    });
    if (result?.success === false) return { success: false, message: result.message || 'Loop declined the reschedule.' };
    const formatted = new Date(new_delivery_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return { success: true, message: `Next delivery rescheduled to ${formatted} for ${customerName}.` };
  } catch (err) {
    console.error('[tool] reschedule_delivery:', err.message);
    return { error: err.message };
  }
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

    // no_restock for fulfilled orders (we don't require returns); cancel for unfulfilled (restores inventory)
    const fulfilled = o.fulfillment_status === 'fulfilled';
    const refundLineItems = (o.line_items || []).map(item => ({
      line_item_id: item.id,
      quantity: item.quantity,
      restock_type: fulfilled ? 'no_restock' : 'cancel',
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

export async function notify_slack({ message, urgent = false }) {
  try {
    const text = urgent
      ? `🚨 *Escalation needed* — <@${SLACK_KYLE_USER_ID}>\n${message}`
      : `📞 *Milo voice call note*\n${message}`;
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

// Auto-called at end of every call from voice.js — not a Milo tool
export async function logCallToGorgias(log) {
  try {
    if (!GORGIAS_DOMAIN || !GORGIAS_EMAIL || !GORGIAS_KEY) return;

    let customerEmail, customerName;
    for (const t of log.tools_used || []) {
      if (t.result?.email) { customerEmail = t.result.email; customerName = t.result.customer_name || t.result.name; break; }
      if (t.args?.customer_email) { customerEmail = t.args.customer_email; break; }
    }

    // Fall back to caller phone or a placeholder so every call gets logged
    const callerIdentifier = customerEmail || log.caller_phone || 'unknown@voice.call';
    const callerLabel = customerName || log.caller_phone || 'Unknown caller';

    const toolLines = (log.tools_used || [])
      .map(t => `• ${t.name}: ${JSON.stringify(t.result)?.substring(0, 300)}`)
      .join('\n') || 'No tools used';
    const summary = `Milo voice call — ${log.duration_seconds}s, ${log.transcript?.length || 0} turns\n\nActions:\n${toolLines}\n\nCall ID: ${log.call_id}`;

    // messages is required (minItems:1) per Gorgias API spec — must be included in creation
    const ticket = await gorgias('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'phone',
        via: 'helpdesk',
        from_agent: true,
        customer: { email: callerIdentifier, name: callerLabel },
        subject: `Milo call — ${new Date(log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        tags: [{ name: 'voice-call' }],
        messages: [{
          channel: 'internal-note',
          via: 'helpdesk',
          from_agent: true,
          public: false,
          body_text: summary,
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

export async function update_order_address({ order_number, address1, address2 = '', city, province, zip, country_code = 'US' }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,fulfillment_status,shipping_address,customer`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found.` };
    const o = data.orders[0];
    if (o.fulfillment_status === 'fulfilled') {
      return { success: false, message: `Order ${order_number} has already shipped — address cannot be changed. Notify the team to arrange a replacement to the correct address.` };
    }
    const existing = o.shipping_address || {};
    const firstName = existing.first_name || o.customer?.first_name || '';
    const lastName = existing.last_name || o.customer?.last_name || '';
    await shopify(`orders/${o.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: {
          id: o.id,
          shipping_address: {
            first_name: firstName,
            last_name: lastName,
            address1,
            address2,
            city,
            province,
            zip,
            country_code,
          },
        },
      }),
    });
    const formatted = [address1, address2, city, province, zip].filter(Boolean).join(', ');

    // Also update Loop subscription address so future recurring orders go to the same place
    let subscriptionUpdated = false;
    try {
      const { loopId } = await findSubscription(order_number, null);
      await loop(`/subscription/${loopId}/address`, {
        method: 'PUT',
        body: JSON.stringify({
          firstName,
          lastName,
          address1,
          address2: address2 || '',
          city,
          provinceCode: toProvinceCode(province),
          countryCode: country_code,
          zip,
        }),
      });
      subscriptionUpdated = true;
    } catch (e) {
      console.warn('[tool] update_order_address: Loop subscription address update skipped:', e.message);
    }

    const suffix = subscriptionUpdated
      ? 'Updated on both this order and future subscription deliveries.'
      : 'Updated on this order. No active subscription found, so no future orders affected.';
    return { success: true, message: `Shipping address updated to: ${formatted}. ${suffix}` };
  } catch (err) {
    console.error('[tool] update_order_address:', err.message);
    return { error: err.message };
  }
}

export async function update_subscription_frequency({ order_number, customer_email, interval_count, interval = 'WEEK' }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    const count = Number(interval_count);
    const policy = { interval: interval.toUpperCase(), intervalCount: count };
    const result = await loop(`/subscription/${loopId}/frequency`, {
      method: 'PUT',
      body: JSON.stringify({
        billingPolicy: policy,
        deliveryPolicy: policy,
        discountType: 'OLD',
      }),
    });
    if (result?.success === false) return { success: false, message: result.message || 'Loop declined the frequency update.' };
    const label = `every ${count} ${interval.toLowerCase()}${count > 1 ? 's' : ''}`;
    return { success: true, message: `Subscription updated to ${label} for ${customerName}.` };
  } catch (err) {
    console.error('[tool] update_subscription_frequency:', err.message);
    return { error: err.message };
  }
}

export async function apply_discount({ order_number, customer_email, percent = 5, orders = 1 }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    const result = await loop(`/subscription/${loopId}/discount`, {
      method: 'POST',
      body: JSON.stringify({
        manualDiscount: {
          title: `Milo retention discount`,
          type: 'PERCENTAGE',
          value: Number(percent),
          orderLimit: Number(orders),
          lineIds: [],
        },
      }),
    });
    if (result?.success === false) return { success: false, message: result.message || 'Loop declined the discount.' };
    return { success: true, message: `${percent}% discount applied to ${customerName}'s next ${orders} order${orders > 1 ? 's' : ''}.` };
  } catch (err) {
    console.error('[tool] apply_discount:', err.message);
    return { error: err.message };
  }
}

const TOOLS = {
  lookup_account, get_order_status, get_subscription_details,
  cancel_subscription, pause_subscription, reschedule_delivery,
  initiate_return, process_refund, cancel_order, apply_discount, update_subscription_frequency,
  update_order_address, notify_slack,
};

export async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  return fn(args);
}
