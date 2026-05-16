// src/routes/voice-tools.js
// Real API implementations for Milo's voice tools

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
const LOOP_API = process.env.LOOP_API;

// ── Shopify helpers ───────────────────────────────────────────────────────────

async function shopify(path, options = {}) {
  const domain = SHOPIFY_DOMAIN?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const res = await fetch(`https://${domain}/admin/api/2024-01/${path}`, {
    ...options,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${res.status}: ${text}`);
  }
  return res.json();
}

function orderName(n) {
  return String(n).startsWith('#') ? n : `#${n}`;
}

// ── Loop helpers ──────────────────────────────────────────────────────────────

async function loop(path, options = {}) {
  const res = await fetch(`https://api.lp.dev${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${LOOP_API}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loop ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function lookup_account({ email }) {
  try {
    const data = await shopify(
      `customers/search.json?query=email:${encodeURIComponent(email)}&fields=id,email,first_name,last_name,phone,orders_count,total_spent,tags`
    );
    if (!data.customers?.length) {
      return { found: false, message: `No account found for ${email}` };
    }
    const c = data.customers[0];
    return {
      found: true,
      customer_id: c.id,
      name: `${c.first_name} ${c.last_name}`.trim(),
      email: c.email,
      phone: c.phone || null,
      orders_count: c.orders_count,
      total_spent: c.total_spent,
    };
  } catch (err) {
    console.error('[tool] lookup_account error:', err.message);
    return { error: err.message };
  }
}

export async function get_order_status({ order_number, customer_email }) {
  try {
    // Look up by order number — email is optional for verification only
    const query = customer_email
      ? `orders.json?name=${encodeURIComponent(orderName(order_number))}&email=${encodeURIComponent(customer_email)}&status=any&fields=id,name,email,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments,cancel_reason`
      : `orders.json?name=${encodeURIComponent(orderName(order_number))}&status=any&fields=id,name,email,financial_status,fulfillment_status,created_at,total_price,line_items,fulfillments,cancel_reason`;
    const data = await shopify(query);
    if (!data.orders?.length) {
      return { found: false, message: `No order ${order_number} found` };
    }
    const o = data.orders[0];
    const fulfillment = o.fulfillments?.[0];
    return {
      found: true,
      order_number: o.name,
      financial_status: o.financial_status,
      fulfillment_status: o.fulfillment_status || 'unfulfilled',
      total: `$${o.total_price}`,
      created_at: new Date(o.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
      tracking_number: fulfillment?.tracking_number || null,
      tracking_url: fulfillment?.tracking_url || null,
      tracking_company: fulfillment?.tracking_company || null,
      items: o.line_items?.map(i => `${i.quantity}x ${i.name}`).join(', '),
    };
  } catch (err) {
    console.error('[tool] get_order_status error:', err.message);
    return { error: err.message };
  }
}

// Fetch active subscription ID by email — used internally so Milo never asks the customer for it
async function resolveSubscriptionId(subscription_id, customer_email) {
  if (subscription_id) return subscription_id;
  const data = await loop(`/api/v2/subscriptions?email=${encodeURIComponent(customer_email)}`);
  const subs = (data.subscriptions || data.data || []).filter(s => s.status === 'active' || s.status === 'ACTIVE');
  if (!subs.length) throw new Error(`No active subscription found for ${customer_email}`);
  return subs[0].id;
}

export async function get_subscription_details({ customer_email }) {
  try {
    const data = await loop(`/api/v2/subscriptions?email=${encodeURIComponent(customer_email)}`);
    const subs = data.subscriptions || data.data || [];
    if (!subs.length) {
      return { found: false, message: `No subscriptions found for ${customer_email}` };
    }
    return {
      found: true,
      subscriptions: subs.map(s => ({
        id: s.id,
        status: s.status,
        product: s.product_title || s.title,
        next_charge_date: s.next_charge_scheduled_at || s.next_billing_date,
        interval: s.order_interval_unit ? `every ${s.order_interval_frequency} ${s.order_interval_unit}` : null,
        price: s.price ? `$${s.price}` : null,
      })),
    };
  } catch (err) {
    console.error('[tool] get_subscription_details error:', err.message);
    return { error: err.message };
  }
}

export async function pause_subscription({ subscription_id, customer_email, pause_until }) {
  try {
    const id = await resolveSubscriptionId(subscription_id, customer_email);
    const data = await loop(`/api/v2/subscriptions/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ resume_date: pause_until }),
    });
    return { success: true, message: `Subscription paused${pause_until ? ` until ${pause_until}` : ''}` };
  } catch (err) {
    console.error('[tool] pause_subscription error:', err.message);
    return { error: err.message };
  }
}

export async function reschedule_delivery({ subscription_id, customer_email, new_delivery_date }) {
  try {
    const id = await resolveSubscriptionId(subscription_id, customer_email);
    const data = await loop(`/api/v2/subscriptions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ next_charge_scheduled_at: new_delivery_date }),
    });
    return { success: true, message: `Next delivery rescheduled to ${new_delivery_date}` };
  } catch (err) {
    console.error('[tool] reschedule_delivery error:', err.message);
    return { error: err.message };
  }
}

export async function cancel_subscription({ subscription_id, customer_email }) {
  try {
    const id = await resolveSubscriptionId(subscription_id, customer_email);
    const data = await loop(`/api/v2/subscriptions/${id}/cancel`, { method: 'POST' });
    return { success: true, message: 'Subscription cancelled' };
  } catch (err) {
    console.error('[tool] cancel_subscription error:', err.message);
    return { error: err.message };
  }
}

export async function initiate_return({ order_number, customer_email, reason }) {
  try {
    // Look up the order first to get order ID
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&email=${encodeURIComponent(customer_email)}&status=any&fields=id,name`
    );
    if (!data.orders?.length) {
      return { found: false, message: `Order ${order_number} not found for ${customer_email}` };
    }
    const orderId = data.orders[0].id;
    // Add a note to the order flagging the return request
    await shopify(`orders/${orderId}.json`, {
      method: 'PUT',
      body: JSON.stringify({
        order: {
          id: orderId,
          note: `Return/exchange requested via phone. Reason: ${reason}`,
          tags: 'return-requested',
        },
      }),
    });
    return {
      success: true,
      message: `Return request logged for order ${order_number}. Customer will receive return instructions via email within 1 business day.`,
      order_number,
    };
  } catch (err) {
    console.error('[tool] initiate_return error:', err.message);
    return { error: err.message };
  }
}

export async function process_refund({ order_number, customer_email }) {
  try {
    const data = await shopify(
      `orders.json?name=${encodeURIComponent(orderName(order_number))}&email=${encodeURIComponent(customer_email)}&status=any&fields=id,name,total_price,financial_status`
    );
    if (!data.orders?.length) {
      return { found: false, message: `Order ${order_number} not found for ${customer_email}` };
    }
    const o = data.orders[0];
    if (o.financial_status === 'refunded') {
      return { message: `Order ${order_number} has already been refunded.` };
    }
    // Calculate full refund
    const calcData = await shopify(`orders/${o.id}/refunds/calculate.json`, {
      method: 'POST',
      body: JSON.stringify({ refund: { shipping: { full_refund: true }, refund_line_items: [] } }),
    });
    const transactions = calcData.refund?.transactions?.map(t => ({
      parent_id: t.parent_id,
      amount: t.amount,
      kind: 'refund',
      gateway: t.gateway,
    }));
    await shopify(`orders/${o.id}/refunds.json`, {
      method: 'POST',
      body: JSON.stringify({
        refund: {
          notify: true,
          note: 'Refund processed via phone support by Milo',
          transactions,
        },
      }),
    });
    return {
      success: true,
      message: `Refund of $${o.total_price} processed for order ${order_number}. Customer will receive email confirmation.`,
    };
  } catch (err) {
    console.error('[tool] process_refund error:', err.message);
    return { error: err.message };
  }
}

// Tool dispatcher — maps name → function
const TOOLS = {
  lookup_account,
  get_order_status,
  get_subscription_details,
  pause_subscription,
  reschedule_delivery,
  cancel_subscription,
  initiate_return,
  process_refund,
};

export async function runTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return { error: `Unknown tool: ${name}` };
  return fn(args);
}
