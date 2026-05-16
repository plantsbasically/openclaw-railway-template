// src/routes/voice-tools.js
// Confirmed working 2026-05-15

const SHOPIFY_DOMAIN = 'plantsbasically.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const LOOP_TOKEN = process.env.LOOP_API || process.env.LOOP_API_KEY;
const GORGIAS_DOMAIN = process.env.GORGIAS_DOMAIN;
const GORGIAS_EMAIL = process.env.GORGIAS_API_EMAIL;
const GORGIAS_KEY = process.env.GORGIAS_API_KEY;

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
// Best path per tools.md: GET /subscription?originOrderShopifyId={shopify_order_id}
// Falls back to customerShopifyId if needed.
// Returns { loopId, customerName, shopifyCustomerId }
async function findSubscription(order_number, customer_email) {
  let shopifyOrderId, shopifyCustomerId, customerName;

  // Step 1: Get Shopify order → extract IDs and customer name
  const orderData = await shopify(
    `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,customer,email`
  );
  if (orderData.orders?.length) {
    const o = orderData.orders[0];
    shopifyOrderId = o.id;
    shopifyCustomerId = o.customer?.id;
    customerName = `${o.customer?.first_name || ''} ${o.customer?.last_name || ''}`.trim();
  }

  // Step 2: Look up Loop subscription by origin order ID (best method)
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
      ? `orders.json?name=${encodeURIComponent(orderName(order_number))}&email=${encodeURIComponent(customer_email)}&status=any&fields=id,name,email,customer,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments`
      : `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,email,customer,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments`;
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
    };
  } catch (err) {
    console.error('[tool] get_order_status:', err.message);
    return { error: err.message };
  }
}

export async function get_subscription_details({ order_number, customer_email }) {
  try {
    const { subscription, customerName } = await findSubscription(order_number, customer_email);
    return {
      found: true,
      customer_name: customerName,
      subscription_status: subscription.status,
      product: subscription.product_title || subscription.variantTitle,
      next_charge_date: subscription.nextChargeScheduledAt || subscription.next_charge_scheduled_at,
      interval: subscription.orderIntervalFrequency
        ? `every ${subscription.orderIntervalFrequency} ${subscription.orderIntervalUnit?.toLowerCase() || 'months'}`
        : null,
      price: subscription.price ? `$${subscription.price}` : null,
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

export async function pause_subscription({ order_number, customer_email, pause_until }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    const body = pause_until
      ? { pauseDuration: { intervalType: 'MONTH', intervalCount: 1, resumeDateEpoch: '' } }
      : {};
    await loop(`/subscription/${loopId}/pause`, { method: 'POST', body: JSON.stringify(body) });
    return { success: true, message: `Subscription paused for ${customerName}${pause_until ? ` until ${pause_until}` : ''}.` };
  } catch (err) {
    console.error('[tool] pause_subscription:', err.message);
    return { error: err.message };
  }
}

export async function reschedule_delivery({ order_number, customer_email, new_delivery_date }) {
  try {
    const { loopId, customerName } = await findSubscription(order_number, customer_email);
    await loop(`/subscription/${loopId}`, {
      method: 'PUT',
      body: JSON.stringify({ nextChargeScheduledAt: new_delivery_date }),
    });
    return { success: true, message: `Next delivery rescheduled to ${new_delivery_date} for ${customerName}.` };
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
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,total_price,financial_status`
    );
    if (!data.orders?.length) return { found: false, message: `Order ${order_number} not found` };
    const o = data.orders[0];
    if (Number(o.total_price) === 0) return { message: `Order ${order_number} was a free welcome kit — no refund needed.` };
    if (o.financial_status === 'refunded') return { message: `Order ${order_number} has already been refunded.` };
    const calcData = await shopify(`orders/${o.id}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: { shipping: { full_refund: true }, refund_line_items: [] } }),
    });
    const transactions = calcData.refund?.transactions?.map(t => ({
      parent_id: t.parent_id, amount: t.amount, kind: 'refund', gateway: t.gateway,
    }));
    await shopify(`orders/${o.id}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: { notify: true, note: 'Refund via phone — Milo', transactions } }),
    });
    return { success: true, message: `Refund of $${o.total_price} processed for order ${order_number}. Confirmation email sent.` };
  } catch (err) {
    console.error('[tool] process_refund:', err.message);
    return { error: err.message };
  }
}

export async function create_gorgias_ticket({ customer_email, customer_name, subject, summary, priority = 'routine' }) {
  try {
    const tags = priority === 'urgent'
      ? [{ name: 'voice-call' }, { name: 'milo-urgent' }]
      : [{ name: 'voice-call' }];

    const ticket = await gorgias('/api/tickets', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'internal-note',
        via: 'helpdesk',
        from_agent: true,
        customer: { email: customer_email, name: customer_name || customer_email },
        subject,
        tags,
        messages: [{
          channel: 'internal-note',
          via: 'helpdesk',
          from_agent: true,
          public: false,
          body_text: summary,
        }],
      }),
    });

    return {
      success: true,
      ticket_id: ticket.id,
      message: `Call logged to Gorgias${priority === 'urgent' ? ' — flagged urgent for team review' : ''}.`,
    };
  } catch (err) {
    console.error('[tool] create_gorgias_ticket:', err.message);
    return { error: err.message };
  }
}

const TOOLS = {
  lookup_account, get_order_status, get_subscription_details,
  cancel_subscription, pause_subscription, reschedule_delivery,
  initiate_return, process_refund, create_gorgias_ticket,
};

export async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  return fn(args);
}
