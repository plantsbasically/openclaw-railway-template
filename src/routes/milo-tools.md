# Milo Tool Reference

All tools available to Milo on inbound calls. Includes exact API endpoints for verification.

---

## Base URLs

| Service | Base URL | Auth |
|---------|----------|------|
| Shopify | `https://plantsbasically.myshopify.com/admin/api/2024-01/` | `X-Shopify-Access-Token: SHOPIFY_ADMIN_API_ACCESS_TOKEN` |
| Loop | `https://api.loopsubscriptions.com/admin/2023-10/` | `X-Loop-Token: LOOP_API_KEY` |
| Gorgias | `https://plantsbasically.gorgias.com/` | Basic auth `GORGIAS_API_EMAIL:GORGIAS_API_KEY` |
| Slack | `SLACK_WEBHOOK_URL` (env) | None |

---

## Shopify Tools

### `lookup_account`
Look up a customer by email to confirm identity.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `email` | string | yes |

**Endpoint**
```
GET /admin/api/2024-01/customers/search.json
  ?query=email:{email}
  &fields=id,email,first_name,last_name,phone,orders_count,total_spent
```

**Returns** `customer_id`, `name`, `email`, `phone`, `orders_count`

---

### `get_order_status`
Get order details, fulfillment status, tracking, and line items.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Endpoint**
```
GET /admin/api/2024-01/orders.json
  ?name={order_number}
  &status=any
  &fields=id,name,email,customer,financial_status,fulfillment_status,
          created_at,total_price,line_items,fulfillments,tags
```

**Returns** `order_number`, `customer_name`, `email`, `financial_status`, `fulfillment_status`, `total`, `date`, `tracking_number`, `tracking_url`, `items`, `tags`

---

### `update_order_address`
Update the shipping address on an unshipped order. Also updates the Loop subscription for future recurring orders.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `address1` | string | yes |
| `city` | string | yes |
| `province` | string | yes |
| `zip` | string | yes |
| `address2` | string | no |
| `country_code` | string | no (default: `US`) |

**Endpoints**
```
# 1. Fetch order
GET /admin/api/2024-01/orders.json
  ?name={order_number}&status=any
  &fields=id,name,fulfillment_status,shipping_address,customer

# 2. Update Shopify order address
PUT /admin/api/2024-01/orders/{order_id}.json
Body: { "order": { "id": ..., "shipping_address": { "address1", "city", "province", "zip", "country_code", ... } } }

# 3. Update Loop subscription address (for future orders)
PUT https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/address
Body: { "firstName", "lastName", "address1", "address2", "city", "provinceCode", "countryCode", "zip" }
```

**Guards** Returns error if order is already fulfilled.

---

### `cancel_order`
Cancel an unfulfilled Shopify order.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Endpoints**
```
# 1. Fetch order
GET /admin/api/2024-01/orders.json
  ?name={order_number}&status=any
  &fields=id,name,fulfillment_status,financial_status,total_price

# 2. Cancel
POST /admin/api/2024-01/orders/{order_id}/cancel.json
Body: { "reason": "customer", "email": true }
```

**Guards** Blocks if `fulfillment_status === 'fulfilled'` or already voided/refunded.

---

### `process_refund`
Issue a full refund on an order including all line items and shipping.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Endpoints**
```
# 1. Fetch order + line items
GET /admin/api/2024-01/orders.json
  ?name={order_number}&status=any
  &fields=id,name,total_price,financial_status,fulfillment_status,line_items

# 2. Calculate refund (get transaction amounts)
POST /admin/api/2024-01/orders/{order_id}/refunds/calculate.json
Body: {
  "refund": {
    "shipping": { "full_refund": true },
    "refund_line_items": [
      { "line_item_id": ..., "quantity": ..., "restock_type": "no_restock" }
    ]
  }
}

# 3. Create refund
POST /admin/api/2024-01/orders/{order_id}/refunds.json
Body: {
  "refund": {
    "notify": true,
    "note": "Refund via phone — Milo",
    "refund_line_items": [ { "line_item_id": ..., "quantity": ..., "restock_type": "no_restock" } ],
    "transactions": [ { "parent_id": ..., "amount": ..., "kind": "refund", "gateway": ... } ]
  }
}
```

**Guards**
- Blocks if already refunded
- Blocks if order total is $0 (free kit)
- Blocks if total > $150 — tells Milo to escalate via `notify_slack`
- Uses `restock_type: no_restock` for all cases (avoids `location_id` requirement)

---

### `initiate_return`
Flag an order for return by tagging it in Shopify. Team sends the label manually.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | yes |
| `reason` | string | yes |

**Endpoints**
```
# 1. Fetch order
GET /admin/api/2024-01/orders.json
  ?name={order_number}&status=any&fields=id,name

# 2. Tag order
PUT /admin/api/2024-01/orders/{order_id}.json
Body: { "order": { "id": ..., "note": "Return requested via phone. Reason: {reason}", "tags": "return-requested" } }
```

---

## Loop Subscription Tools

All Loop tools resolve the Loop internal subscription ID (7–8 digit integer) automatically from the order number via the `findSubscription` helper. Priority: Shopify order tag → `originOrderShopifyId` → `customerShopifyId` → email lookup.

---

### `get_subscription_details`
Read subscription status, next charge date, cadence, and price.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | no* |
| `customer_email` | string | no* |

*At least one required.

**Endpoints (in priority order)**
```
# From Shopify order tag "Subscription #shopifyId":
GET https://api.loopsubscriptions.com/admin/2023-10/subscription/shopify-{shopifySubId}

# Fallback 1:
GET https://api.loopsubscriptions.com/admin/2023-10/subscription?originOrderShopifyId={shopifyOrderId}

# Fallback 2:
GET https://api.loopsubscriptions.com/admin/2023-10/subscription?customerShopifyId={shopifyCustomerId}
```

**Returns** `subscription_status`, `product`, `next_charge_date`, `interval`, `price`, `paused_at`

---

### `cancel_subscription`
Cancel a Loop subscription.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Endpoint**
```
POST https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/cancel
Body: {
  "cancellationReason": "Other",
  "cancellationComment": "Customer requested cancellation via phone support"
}
```

---

### `pause_subscription`
Pause a subscription for 1–3 months.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |
| `pause_months` | number | no (default: `1`) |

**Endpoint**
```
POST https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/pause
Body: {
  "pauseDuration": {
    "intervalType": "MONTH",
    "intervalCount": {pause_months}
  }
}
```

---

### `resume_subscription`
Resume a previously paused subscription before the pause period expires.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Endpoint**
```
POST https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/resume
(no body required)
```

---

### `reschedule_delivery`
Move the next billing/delivery date to a specific date. Only moves the next order, not all future orders.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `new_delivery_date` | string | yes (YYYY-MM-DD) |
| `customer_email` | string | no |

**Endpoint**
```
POST https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/reschedule
Body: {
  "newBillingDateEpoch": {unix_epoch_seconds},
  "rescheduleFutureOrders": false
}
```

**Notes** Date is converted from `YYYY-MM-DD` to epoch seconds internally. `rescheduleFutureOrders: false` means only the next order moves.

---

### `update_subscription_frequency`
Change how often the subscription renews (e.g. every 4 weeks → every 8 weeks).

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `interval_count` | number | yes (e.g. `8`) |
| `customer_email` | string | no |
| `interval` | string | no (default: `WEEK`, options: `WEEK` / `MONTH` / `YEAR`) |

**Endpoint**
```
PUT https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/frequency
Body: {
  "billingPolicy": { "interval": "WEEK", "intervalCount": 8 },
  "deliveryPolicy": { "interval": "WEEK", "intervalCount": 8 },
  "discountType": "OLD"
}
```

**Notes** `discountType: OLD` preserves the existing subscribe-and-save discount.

---

### `apply_discount`
Apply a manual percentage discount to the next N subscription orders (retention save).

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `percent` | number | no (default: `5`) |
| `orders` | number | no (default: `1`) |
| `customer_email` | string | no |

**Endpoint**
```
POST https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/discount
Body: {
  "manualDiscount": {
    "title": "Milo retention discount",
    "type": "PERCENTAGE",
    "value": 5,
    "orderLimit": 1,
    "lineIds": []
  }
}
```

**Notes** `lineIds: []` applies to the whole contract (not specific lines). `null` is rejected by Loop with a 422.

---

### `change_subscription_bottles`
Swap the subscription to a different bottle count variant (1, 2, or 3 bottles per delivery).

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `bottles` | number | yes (`1`, `2`, or `3`) |
| `customer_email` | string | no |

**Endpoints**
```
# 1. Find the correct Shopify variant by title
GET /admin/api/2024-01/products/{productShopifyId}/variants.json
# Matches variant where title.toLowerCase().includes("{bottles} bottle")
# Titles: "1 BOTTLE", "2 BOTTLES", "3 BOTTLES"

# 2. Swap the subscription line
PUT https://api.loopsubscriptions.com/admin/2023-10/subscription/{loopId}/line/{lineId}/swap
Body: {
  "variantShopifyId": {target_variant_id},
  "quantity": 1,
  "pricingType": "OLD"
}
```

**Notes** `pricingType: OLD` keeps the existing discount. Line ID comes from `subscription.lines[0].id`.

---

## Communication Tools

### `send_portal_link`
Email the customer their subscription portal link so they can update their payment method.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `customer_email` | string | yes |
| `customer_name` | string | no |

**Endpoint**
```
POST https://plantsbasically.gorgias.com/api/tickets
Body: {
  "channel": "email",
  "via": "helpdesk",
  "from_agent": true,
  "customer": { "email": ..., "name": ... },
  "subject": "Your Plants Basically subscription portal",
  "messages": [{
    "channel": "email",
    "public": true,
    "body_text": "Hi {name}, here's your link: https://www.plantsbasically.com/subscriptions ...",
    "sender": { "email": GORGIAS_API_EMAIL, "name": "Plants Basically" },
    "receiver": { "email": customer_email }
  }]
}
```

**Portal URL** `https://www.plantsbasically.com/subscriptions` (redirects to `/a/loop_subscriptions/`)

---

### `notify_slack`
Send a message to the Plants Basically team in Slack.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `message` | string | yes |
| `urgent` | boolean | no (default: `false`) |

**Endpoint**
```
POST {SLACK_WEBHOOK_URL}
Body: { "text": "🚨 *Escalation needed* — @Kyle\n{message}" }   # urgent: true
Body: { "text": "📞 *Milo voice call note*\n{message}" }         # urgent: false
```

**Escalate for** refund > $150, chargeback/legal, adverse reaction, "I want a manager", replacement orders, return labels.

---

## Auto-logged (not a Milo tool)

### `logCallToGorgias`
Called automatically at the end of every call. Creates an internal-note ticket in Gorgias. Milo never calls this directly.

**Endpoint**
```
POST https://plantsbasically.gorgias.com/api/tickets
Body: {
  "channel": "phone",
  "via": "helpdesk",
  "from_agent": true,
  "customer": { "email": ..., "name": ... },
  "subject": "Milo call — {date}",
  "tags": [{ "name": "voice-call" }],
  "messages": [{
    "channel": "internal-note",
    "public": false,
    "body_text": "{transcript summary + tool results}",
    "sender": { "email": GORGIAS_API_EMAIL, "name": "Milo" }
  }]
}
```

---

## No Draft Orders Tool

There is currently no draft order tool. Replacement orders (damaged package, wrong address after shipping) are handled by escalating to Slack (`notify_slack`, `urgent: true`) so the team creates them manually.
