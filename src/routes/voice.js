// src/routes/voice.js
import express from 'express';
import WebSocket from 'ws';
import twilio from 'twilio';
import { runTool } from './voice-tools.js';

const XAI_API_KEY = process.env.XAI_API_KEY;

const SESSION_CONFIG = {
  voice: 'rex',
  instructions: "You are Milo, customer support for Plants Basically. We sell Juicy Joint Protocol, a daily liquid supplement for joint pain relief. Speak warm, casual, direct. Sound like a real person helping a friend. Not a corporate bot. Short sentences. Natural pauses. Warm, calm, practical. You care, but direct.\n\nGoals: Resolve issues fast. Positive vibe. Look up orders. Track shipments. Status updates. Returns, exchanges, refunds per policy. Troubleshoot products step-by-step. FAQs on products, services, policies. Escalate complex stuff.\n\nBe patient. Empathetic with frustrated folks. Solutions first. Confirm fixed before end. Clear follow-up expectations if needed. Verify identity before account details. Offer options. Thank for patience, business.\n\nProduct facts: Dose 1-2 full droppers daily. Shelf life 5 years. Ingredients clinically researched, tested. plantsbasically.com. Subs with free shipping.\n\nRules: No diagnosing. No medical advice. No 'stop meds'. No 'heal', 'cure', 'treat'. Medical questions? Point to plantsbasically.com/pages/reviews. On meds, blood thinners, surgery? Consult doctor. No overpromising.\n\nHandle: Helpful. Lead with fix. Sub cancel? Ask why. Offer pause, delay, change schedule first. Shipping issue? Offer order lookup. Concise: 3-4 sentences max.\n\nAvoid: Em dashes. 'Unfortunately'. Scripted sound. Made-up info - say 'I'll look into it, follow up'.\n\nDates/times: Natural only. Take 'next Tuesday', 'tomorrow 3pm'. Confirm natural: 'Tuesday, December 15th at 3 PM'. No format lectures.\n\nUse tools for real actions. Never fake. Verify customer first with lookup_account. Then order/sub actions.",
  turn_detection: { type: 'server_vad' },
  input_audio_transcription: { model: 'grok-2-audio' },
  tools: [
    {
      type: 'file_search',
      vector_store_ids: ['collection_7fbf149b-f6ea-4034-9bad-61628b626659'],
      max_num_results: 10
    },
    {
      type: 'function', name: 'lookup_account',
      description: 'Verify and retrieve customer account details for identity confirmation.',
      parameters: { type: 'object', properties: { email: { type: 'string', description: "Customer's email address" }, phone: { type: 'string', description: "Customer's phone number (optional for verification)" } }, required: ['email'] }
    },
    {
      type: 'function', name: 'get_order_status',
      description: 'Get order details, status, shipment tracking, and delivery info. Email is optional — order number alone is enough.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'The order number (with or without #)' }, customer_email: { type: 'string', description: "Customer's email (optional — only needed if order number is ambiguous)" } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'get_subscription_details',
      description: 'Retrieve subscription details, next billing/delivery dates, and status.',
      parameters: { type: 'object', properties: { subscription_id: { type: 'string', description: 'Subscription ID (optional, can lookup by email)' }, customer_email: { type: 'string', description: "Customer's email" } }, required: ['customer_email'] }
    },
    {
      type: 'function', name: 'pause_subscription',
      description: 'Pause a subscription temporarily.',
      parameters: { type: 'object', properties: { subscription_id: { type: 'string', description: 'Subscription ID' }, customer_email: { type: 'string', description: "Customer's email" }, pause_until: { type: 'string', description: "Natural date to resume, e.g., 'next month'" } }, required: ['subscription_id', 'customer_email'] }
    },
    {
      type: 'function', name: 'reschedule_delivery',
      description: 'Change the next delivery date for a subscription.',
      parameters: { type: 'object', properties: { subscription_id: { type: 'string', description: 'Subscription ID' }, customer_email: { type: 'string', description: "Customer's email" }, new_delivery_date: { type: 'string', description: "New delivery date in natural format" } }, required: ['subscription_id', 'customer_email', 'new_delivery_date'] }
    },
    {
      type: 'function', name: 'cancel_subscription',
      description: "Cancel a customer's subscription.",
      parameters: { type: 'object', properties: { subscription_id: { type: 'string', description: 'Subscription ID' }, customer_email: { type: 'string', description: "Customer's email" } }, required: ['subscription_id', 'customer_email'] }
    },
    {
      type: 'function', name: 'initiate_return',
      description: 'Start the return or exchange process for an order.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer's email" }, reason: { type: 'string', description: 'Brief reason for return/exchange' } }, required: ['order_number', 'customer_email', 'reason'] }
    },
    {
      type: 'function', name: 'process_refund',
      description: 'Issue a refund for an eligible order or subscription.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number or subscription ID' }, customer_email: { type: 'string', description: "Customer's email" } }, required: ['order_number', 'customer_email'] }
    }
  ],
  audio: {
    input: { format: { type: 'audio/pcmu' } },
    output: { format: { type: 'audio/pcmu' } }
  }
};

// HTTP routes: /incoming webhook + /status callback
export function setupVoiceHttpRoutes() {
  const router = express.Router();

  router.post('/incoming', (req, res) => {
    const host = req.headers.host;
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/voice/stream" statusCallback="https://${host}/voice/status" />
  </Connect>
</Response>`);
  });

  router.post('/status', (req, res) => {
    console.log('[voice] call ended', req.body?.CallStatus);
    res.sendStatus(200);
  });

  return router;
}

// WebSocket handler: called directly from server.js upgrade handler
export function handleVoiceStream(ws, req) {
  console.log('[voice] call connected');

  let streamSid = null;
  let sessionReady = false;

  const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });

  // ── xAI → Twilio ────────────────────────────────────────────────────────────

  xaiWs.on('open', () => {
    console.log('[voice] xAI connected — sending session.update');
    xaiWs.send(JSON.stringify({ type: 'session.update', session: SESSION_CONFIG }));
  });

  xaiWs.on('message', (data) => {
    let event;
    try { event = JSON.parse(data); } catch { return; }

    if (event.type !== 'response.output_audio.delta') {
      console.log('[voice] xAI ←', event.type, event.error ? JSON.stringify(event.error) : '');
    }

    switch (event.type) {
      case 'session.updated':
        sessionReady = true;
        console.log('[voice] session ready — prompting Milo to greet');
        xaiWs.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Greet the caller and introduce yourself.' }] }
        }));
        xaiWs.send(JSON.stringify({ type: 'response.create' }));
        break;

      case 'response.output_audio.delta':
        if (streamSid && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
        }
        break;

      case 'input_audio_buffer.speech_started':
        if (streamSid && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'clear', streamSid }));
        }
        xaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        break;

      case 'response.function_call_arguments.done': {
        const toolName = event.name;
        const toolArgs = JSON.parse(event.arguments || '{}');
        console.log('[voice] tool called:', toolName, toolArgs);
        runTool(toolName, toolArgs).then(result => {
          console.log('[voice] tool result:', toolName, JSON.stringify(result));
          xaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) }
          }));
          xaiWs.send(JSON.stringify({ type: 'response.create' }));
        }).catch(err => {
          console.error('[voice] tool error:', toolName, err.message);
          xaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ error: err.message }) }
          }));
          xaiWs.send(JSON.stringify({ type: 'response.create' }));
        });
        break;
      }

      case 'error':
        console.error('[voice] xAI error:', JSON.stringify(event));
        break;
    }
  });

  xaiWs.on('error', (err) => console.error('[voice] xAI WS error:', err.message));
  xaiWs.on('close', (code, reason) => {
    console.log('[voice] xAI WS closed — code:', code, 'reason:', reason?.toString());
    if (ws.readyState === ws.OPEN) ws.close();
  });

  // ── Twilio → xAI ────────────────────────────────────────────────────────────

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    if (data.event === 'start') {
      streamSid = data.start.streamSid;
      console.log('[voice] Twilio stream started, sid:', streamSid);
    }

    if (data.event === 'media' && data.media?.track === 'inbound') {
      if (!sessionReady || xaiWs.readyState !== WebSocket.OPEN) return;
      xaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    }
  });

  ws.on('close', () => {
    console.log('[voice] Twilio WS closed');
    xaiWs.close();
  });

  ws.on('error', (err) => console.error('[voice] Twilio WS error:', err.message));
}
