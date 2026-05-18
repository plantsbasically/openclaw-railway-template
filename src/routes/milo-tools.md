# Milo Tool Reference

All tools available to Milo on inbound calls. Each entry shows the function name, parameters, what API it hits, and what it returns.

---

## Shopify Tools

### `lookup_account`
Look up a customer by email to confirm identity.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `email` | string | yes |

**Returns** `customer_id`, `name`, `email`, `phone`, `orders_count`

**API** `GET /customers/search.json?query=email:{email}`

---

### `get_order_status`
Get order details, fulfillment status, tracking, and line items.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Returns** `order_number`, `customer_name`, `email`, `financial_status`, `fulfillment_status`, `total`, `date`, `tracking_number`, `tracking_url`, `items`, `tags`

**API** `GET /orders.json?name={order_number}`

---

### `update_order_address`
Update the shipping address on an unshipped order. Also updates the Loop subscription address so future recurring orders go to the same place.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `address1` | string | yes |
| `city` | string | yes |
| `province` | string | yes (full state name or 2-letter code) |
| `zip` | string | yes |
| `address2` | string | no |
| `country_code` | string | no (default: `US`) |

**Returns** success message with formatted address, notes whether subscription was also updated.

**API**
- `PUT /orders/{id}.json` (Shopify — current order)
- `PUT /subscription/{loopId}/address` (Loop — future orders)

**Guards** Returns error if order is already fulfilled.

---

### `cancel_order`
Cancel an unfulfilled Shopify order.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Returns** success or reason it can't be cancelled (already shipped, already refunded).

**API** `POST /orders/{id}/cancel.json`

**Guards** Blocks if `fulfillment_status === 'fulfilled'` or order already voided/refunded.

---

### `process_refund`
Issue a full refund on an order including line items and shipping.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Returns** success with refund amount, or reason it was blocked.

**API**
- `POST /orders/{id}/refunds/calculate.json` (calculate first)
- `POST /orders/{id}/refunds.json` (create refund)

**Guards**
- Blocks if already refunded
- Blocks if order total is $0 (free kit)
- Blocks if total > $150 — tells Milo to escalate via `notify_slack`
- Uses `restock_type: cancel` for unfulfilled orders, `no_restock` for fulfilled

---

### `initiate_return`
Flag an order for return by tagging it in Shopify. Team sends the label manually.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | yes |
| `reason` | string | yes |

**Returns** success confirmation.

**API** `PUT /orders/{id}.json` (adds note + `return-requested` tag)

---

## Loop Subscription Tools

All Loop tools use the internal Loop subscription ID (7–8 digit integer), never the Shopify subscription ID. The `findSubscription` helper resolves this automatically from the order number.

---

### `get_subscription_details`
Read subscription status, next charge date, cadence, and price.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | no* |
| `customer_email` | string | no* |

*At least one required.

**Returns** `subscription_status`, `product`, `next_charge_date`, `interval`, `price`, `paused_at`

**API** Loop subscription lookup via order tags → `GET /subscription/shopify-{id}`

---

### `cancel_subscription`
Cancel a Loop subscription.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Returns** success confirmation.

**API** `POST /subscription/{loopId}/cancel`

---

### `pause_subscription`
Pause a subscription for 1–3 months.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |
| `pause_months` | number | no (default: `1`) |

**Returns** success with resume date.

**API** `POST /subscription/{loopId}/pause`

---

### `resume_subscription`
Resume a previously paused subscription before the pause period expires.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `customer_email` | string | no |

**Returns** success confirmation.

**API** `POST /subscription/{loopId}/resume`

---

### `reschedule_delivery`
Move the next billing/delivery date to a specific date.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `new_delivery_date` | string | yes (YYYY-MM-DD) |
| `customer_email` | string | no |

**Returns** success with formatted new date.

**API** `POST /subscription/{loopId}/reschedule`

**Notes** Converts date to epoch seconds internally. Only reschedules the next order (`rescheduleFutureOrders: false`).

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

**Returns** success with new cadence label.

**API** `PUT /subscription/{loopId}/frequency`

**Notes** Uses `discountType: OLD` to preserve existing subscribe-and-save discount.

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

**Returns** success confirmation.

**API** `POST /subscription/{loopId}/discount`

---

### `change_subscription_bottles`
Swap the subscription to a different bottle count variant (1, 2, or 3 bottles per delivery).

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `order_number` | string | yes |
| `bottles` | number | yes (`1`, `2`, or `3`) |
| `customer_email` | string | no |

**Returns** success with new bottle count.

**API**
- `GET /products/{productId}/variants.json` (Shopify — find target variant by title)
- `PUT /subscription/{loopId}/line/{lineId}/swap` (Loop — swap the line)

**Notes** Matches variant by title (`"1 BOTTLE"`, `"2 BOTTLES"`, `"3 BOTTLES"`). Uses `pricingType: OLD` to keep existing discount.

---

## Communication Tools

### `send_portal_link`
Email the customer their Loop subscription portal link so they can update their payment method.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `customer_email` | string | yes |
| `customer_name` | string | no |

**Returns** success confirmation.

**API** `POST /api/tickets` (Gorgias — sends outbound email)

**Portal URL** `https://www.plantsbasically.com/a/loop_subscriptions/`

---

### `notify_slack`
Send a message to the Plants Basically team in Slack. Use for escalations that need immediate human attention.

**Parameters**
| Name | Type | Required |
|------|------|----------|
| `message` | string | yes (include customer name, email/phone, order number) |
| `urgent` | boolean | no (default: `false`) — set `true` to @mention Kyle |

**Returns** success confirmation.

**Escalate for** refund > $150, chargeback/legal, adverse reaction, "I want a manager", batch quality issue, replacement orders, return labels.

---

## Auto-logged (not a Milo tool)

### `logCallToGorgias`
Called automatically at the end of every call. Creates an internal-note ticket in Gorgias with the full transcript summary and tool results. Milo never calls this directly.
