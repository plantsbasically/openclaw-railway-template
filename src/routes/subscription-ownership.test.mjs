import assert from "node:assert/strict";
import test from "node:test";

import { ownsSubscription, subscriptionIdsFromOrders } from "./voice-tools.js";

// Regression guard for the wrong-subscription incidents (2026-06-24, 2026-09-04).
// Loop's list endpoints ignore customer filters and return page 1 of every
// subscription in the store, so a resolved contract MUST be proven to belong to
// the caller before Milo reads it out or acts on it.

test("accepts a subscription whose customer shopifyId matches the caller", () => {
  const sub = { customer: { shopifyId: 10174039523647, email: "paul.govatos@gmail.com" } };
  assert.equal(ownsSubscription(sub, { shopifyCustomerId: 10174039523647 }), true);
});

test("accepts a subscription matched by email, case-insensitively", () => {
  const sub = { customer: { shopifyId: 1, email: "Paul.Govatos@Gmail.com" } };
  assert.equal(ownsSubscription(sub, { customer_email: "paul.govatos@gmail.com" }), true);
});

test("rejects another customer's subscription", () => {
  // The exact shape of the incident: caller is George, Loop handed back DJ McKenna.
  const strangersSub = { customer: { shopifyId: 9393810932031, email: "djmckenna71@gmail.com" } };
  assert.equal(
    ownsSubscription(strangersSub, {
      shopifyCustomerId: 10174039523647,
      customer_email: "paul.govatos@gmail.com",
    }),
    false,
  );
});

test("rejects when the subscription carries no customer at all", () => {
  assert.equal(ownsSubscription({}, { shopifyCustomerId: 123 }), false);
  assert.equal(ownsSubscription({ customer: {} }, { customer_email: "a@b.com" }), false);
});

test("rejects when we have no identity to check against", () => {
  const sub = { customer: { shopifyId: 123, email: "a@b.com" } };
  assert.equal(ownsSubscription(sub, {}), false);
});

test("pulls subscription ids out of Shopify order tags, newest first, deduped", () => {
  const orders = [
    { tags: "Billing cycle #3, Deliver every 12 WEEK, Subscription, Subscription #47538733375" },
    { tags: "Subscription #47538733375, Subscription Recurring Order" },
    { tags: "Subscription #11112222333" },
    { tags: "" },
    {},
  ];
  assert.deepEqual(subscriptionIdsFromOrders(orders), ["47538733375", "11112222333"]);
});

test("returns nothing when no order carries a subscription tag", () => {
  assert.deepEqual(subscriptionIdsFromOrders([{ tags: "Subscription Recurring Order" }]), []);
  assert.deepEqual(subscriptionIdsFromOrders([]), []);
});
