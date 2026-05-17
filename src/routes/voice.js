// src/routes/voice.js
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import twilio from 'twilio';
import { runTool } from './voice-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XAI_API_KEY = process.env.XAI_API_KEY;
const SETUP_PASSWORD = process.env.SETUP_PASSWORD;
const LOG_DIR = path.join(process.env.OPENCLAW_STATE_DIR || '/data/.openclaw', 'voice-logs');

const MILO_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'milo-prompt.md'), 'utf8');

function saveCallLog(log) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${log.call_id}.json`);
    fs.writeFileSync(file, JSON.stringify(log, null, 2));
  } catch (e) {
    console.error('[voice] failed to save call log:', e.message);
  }
}

const SESSION_CONFIG = {
  voice: 'rex',
  instructions: MILO_INSTRUCTIONS,
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
      description: 'Get subscription status and next delivery. Use order_number — never ask for a subscription ID.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number (preferred)' }, customer_email: { type: 'string', description: "Customer email (fallback if no order number)" } }, required: [] }
    },
    {
      type: 'function', name: 'pause_subscription',
      description: 'Pause a subscription. Use order_number — never ask the customer for a subscription ID.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email (fallback)" }, pause_months: { type: 'number', description: "Number of months to pause, e.g. 1, 2, or 3. Default 1." } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'reschedule_delivery',
      description: 'Reschedule the next delivery. Use order_number — never ask the customer for a subscription ID.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email (fallback)" }, new_delivery_date: { type: 'string', description: "New date in natural format, e.g. 'two weeks from now'" } }, required: ['order_number', 'new_delivery_date'] }
    },
    {
      type: 'function', name: 'cancel_subscription',
      description: "Cancel a subscription. Use order_number — never ask the customer for a subscription ID. Always attempt retention first (offer pause or skip).",
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email (fallback)" } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'initiate_return',
      description: 'Start the return or exchange process for an order.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer's email" }, reason: { type: 'string', description: 'Brief reason for return/exchange' } }, required: ['order_number', 'customer_email', 'reason'] }
    },
    {
      type: 'function', name: 'process_refund',
      description: 'Issue a refund for an eligible order or subscription. Only use for refunds under $150 — escalate larger refunds to Gorgias.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number or subscription ID' }, customer_email: { type: 'string', description: "Customer's email" } }, required: ['order_number', 'customer_email'] }
    },
    {
      type: 'function', name: 'cancel_order',
      description: 'Cancel an unfulfilled order in Shopify. If already shipped, tell customer to refuse delivery or initiate a return instead.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email" } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'create_gorgias_ticket',
      description: 'Log a call summary to Gorgias as an internal note. Call this at the end of every call where you took action or could not fully resolve the issue.',
      parameters: {
        type: 'object',
        properties: {
          customer_email: { type: 'string', description: "Customer's email address" },
          customer_name: { type: 'string', description: "Customer's name" },
          subject: { type: 'string', description: 'Brief subject line, e.g. "Voice call — subscription cancellation"' },
          summary: { type: 'string', description: 'What the customer called about, what actions were taken, and any pending follow-up' },
          priority: { type: 'string', enum: ['routine', 'urgent'], description: "'urgent' for: refund over $150, chargeback/legal, adverse reaction, manager request, batch issue. 'routine' for everything else." }
        },
        required: ['customer_email', 'subject', 'summary']
      }
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

  // GET /voice/logs — view recent call transcripts (password protected)
  router.get('/logs', (req, res) => {
    const auth = req.headers.authorization || '';
    const b64 = auth.replace(/^Basic /, '');
    const decoded = Buffer.from(b64, 'base64').toString();
    const password = decoded.split(':')[1];
    if (!SETUP_PASSWORD || password !== SETUP_PASSWORD) {
      res.set('WWW-Authenticate', 'Basic realm="Milo Logs"');
      return res.status(401).send('Unauthorized');
    }

    const id = req.query.id;
    try {
      if (id) {
        // Single call detail
        const file = path.join(LOG_DIR, `${id}.json`);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
        return res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
      }

      // List recent calls
      if (!fs.existsSync(LOG_DIR)) return res.json({ calls: [] });
      const files = fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, 50);

      const calls = files.map(f => {
        try {
          const log = JSON.parse(fs.readFileSync(path.join(LOG_DIR, f), 'utf8'));
          return {
            call_id: log.call_id,
            started_at: log.started_at,
            duration_seconds: log.duration_seconds,
            turns: log.transcript?.length || 0,
            tools_used: log.tools_used?.map(t => t.name) || [],
            preview: log.transcript?.find(t => t.role === 'caller')?.text?.substring(0, 80) || '',
          };
        } catch { return null; }
      }).filter(Boolean);

      res.json({ calls });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// WebSocket handler: called directly from server.js upgrade handler
export function handleVoiceStream(ws, req) {
  const callId = `call_${Date.now()}`;
  console.log('[voice] call connected', callId);

  let streamSid = null;
  let sessionReady = false;

  // Transcript log — saved to disk when call ends
  const log = {
    call_id: callId,
    started_at: new Date().toISOString(),
    ended_at: null,
    duration_seconds: null,
    transcript: [],   // { role, text, ts }
    tools_used: [],   // { name, args, result, ts }
  };

  const startTime = Date.now();

  function addTurn(role, text) {
    log.transcript.push({ role, text, ts: new Date().toISOString() });
  }

  function endCall() {
    log.ended_at = new Date().toISOString();
    log.duration_seconds = Math.round((Date.now() - startTime) / 1000);
    saveCallLog(log);
    console.log(`[voice] call ended — ${log.duration_seconds}s, ${log.transcript.length} turns, saved ${callId}`);
  }

  const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });

  // ── xAI → Twilio ────────────────────────────────────────────────────────────

  xaiWs.on('open', () => {
    console.log('[voice] xAI connected — sending session.update');
    xaiWs.send(JSON.stringify({ type: 'session.update', session: SESSION_CONFIG }));
  });

  // Buffer Milo's streaming transcript delta
  let miloBuffer = '';

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
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Greet the caller. Say hello, your name is Milo, and ask how you can help. Nothing else — no listing of capabilities, no menu of options.' }] }
        }));
        xaiWs.send(JSON.stringify({ type: 'response.create' }));
        break;

      case 'response.output_audio.delta':
        if (streamSid && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
        }
        break;

      // Collect Milo's transcript as it streams in
      case 'response.output_audio_transcript.delta':
        miloBuffer += event.delta || '';
        break;

      case 'response.output_audio_transcript.done':
      case 'response.done':
        if (miloBuffer.trim()) {
          addTurn('milo', miloBuffer.trim());
          miloBuffer = '';
        }
        break;

      // Collect caller's transcript when xAI finishes transcribing their speech
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript?.trim()) {
          addTurn('caller', event.transcript.trim());
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
        const toolEntry = { name: toolName, args: toolArgs, result: null, ts: new Date().toISOString() };
        log.tools_used.push(toolEntry);
        runTool(toolName, toolArgs).then(result => {
          toolEntry.result = result;
          console.log('[voice] tool result:', toolName, JSON.stringify(result));
          xaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) }
          }));
          xaiWs.send(JSON.stringify({ type: 'response.create' }));
        }).catch(err => {
          toolEntry.result = { error: err.message };
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
      log.stream_sid = streamSid;
      log.call_sid = data.start.callSid;
      console.log('[voice] Twilio stream started, sid:', streamSid);
    }

    if (data.event === 'media' && data.media?.track === 'inbound') {
      if (!sessionReady || xaiWs.readyState !== WebSocket.OPEN) return;
      xaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }));
    }
  });

  ws.on('close', () => {
    console.log('[voice] Twilio WS closed');
    endCall();
    xaiWs.close();
  });

  ws.on('error', (err) => console.error('[voice] Twilio WS error:', err.message));
}
