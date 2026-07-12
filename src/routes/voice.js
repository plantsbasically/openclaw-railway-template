// src/routes/voice.js
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import twilio from 'twilio';
import { runTool, logCallToGorgias } from './voice-tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const XAI_API_KEY = process.env.XAI_API_KEY;
const SETUP_PASSWORD = process.env.SETUP_PASSWORD;
const LOG_DIR = path.join(process.env.OPENCLAW_STATE_DIR || '/data/.openclaw', 'voice-logs');

const MILO_INSTRUCTIONS = fs.readFileSync(path.join(__dirname, 'milo-prompt.md'), 'utf8');
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

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
      type: 'function', name: 'lookup_by_name',
      description: "Search for a customer by first and last name. Use when the customer can't provide an email or order number, or when email lookup returns an account with no orders. May return multiple matches — read them back to the customer to confirm which is theirs.",
      parameters: { type: 'object', properties: { first_name: { type: 'string', description: "Customer's first name" }, last_name: { type: 'string', description: "Customer's last name" } }, required: ['first_name', 'last_name'] }
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
      description: 'Request a subscription pause. This does NOT pause anything itself — it sends the request to the team, who applies it and emails a confirmation. Use order_number — never ask the customer for a subscription ID.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email (fallback)" }, pause_months: { type: 'number', description: "Number of months to pause, e.g. 1, 2, or 3. Default 1." } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'reschedule_delivery',
      description: 'Request a reschedule of the next delivery. This does NOT reschedule anything itself — it sends the request to the team, who applies it and emails a confirmation. Use order_number — never ask the customer for a subscription ID.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email (fallback)" }, new_delivery_date: { type: 'string', description: "New billing date in YYYY-MM-DD format, e.g. '2026-08-01'. Confirm the date with the customer before calling." } }, required: ['order_number', 'new_delivery_date'] }
    },
    {
      type: 'function', name: 'resume_subscription',
      description: 'Request an early resume of a paused subscription. This does NOT resume anything itself — it sends the request to the team, who applies it and emails a confirmation.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Order number' },
          customer_email: { type: 'string', description: 'Customer email (fallback)' },
        },
        required: ['order_number']
      }
    },
    {
      type: 'function', name: 'change_subscription_bottles',
      description: 'Request a change to how many bottles the customer receives per delivery (1, 2, or 3). This does NOT change anything itself — it sends the request to the team, who applies it and emails a confirmation.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Order number' },
          customer_email: { type: 'string', description: 'Customer email (fallback)' },
          bottles: { type: 'number', description: 'Number of bottles per delivery: 1, 2, or 3', enum: [1, 2, 3] },
        },
        required: ['order_number', 'bottles']
      }
    },
    {
      type: 'function', name: 'update_subscription_frequency',
      description: 'Request a change to how often a subscription renews. This does NOT change anything itself — it sends the request to the team, who applies it and emails a confirmation. Use for retention — offer every 8 weeks before cancelling. Confirm the new cadence with the customer before calling.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Order number' },
          customer_email: { type: 'string', description: 'Customer email (fallback)' },
          interval_count: { type: 'number', description: 'Number of intervals, e.g. 8 for every 8 weeks' },
          interval: { type: 'string', description: 'WEEK, MONTH, or YEAR. Default: WEEK', enum: ['WEEK', 'MONTH', 'YEAR'] },
        },
        required: ['order_number', 'interval_count']
      }
    },
    {
      type: 'function', name: 'cancel_subscription',
      description: "Cancel a subscription. Use order_number if you have it, otherwise use customer_email alone — never ask the customer for a subscription ID. Always attempt retention first (offer pause or skip).",
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number (use if available)' }, customer_email: { type: 'string', description: "Customer email — use this alone if no order number" } }, required: [] }
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
      type: 'function', name: 'apply_discount',
      description: 'Request a retention discount on a subscription. This does NOT apply anything itself — it sends the request to the team, who applies it and emails a confirmation. Use before cancelling — offer this alongside pause/cadence change.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Order number' },
          customer_email: { type: 'string', description: 'Customer email (fallback)' },
          percent: { type: 'number', description: 'Discount percentage. Default 5.' },
          orders: { type: 'number', description: 'Number of orders to apply it to. Default 1.' }
        },
        required: ['order_number']
      }
    },
    {
      type: 'function', name: 'cancel_order',
      description: 'Cancel an unfulfilled order in Shopify. If already shipped, tell customer to refuse delivery or initiate a return instead.',
      parameters: { type: 'object', properties: { order_number: { type: 'string', description: 'Order number' }, customer_email: { type: 'string', description: "Customer email" } }, required: ['order_number'] }
    },
    {
      type: 'function', name: 'update_order_address',
      description: 'Request a shipping address change on an unshipped order. This does NOT change the address itself — it notes the order and escalates to the team; a human agent verifies and applies the new address before it ships. Collect the COMPLETE address (street number AND street name, unit, city, state, zip) and read it back to the customer before calling. A bare number with no street name (e.g. "2437 Unit 1") is NOT a complete address — ask for the street name. If the order has already shipped, this will return an error — use notify_slack instead.',
      parameters: {
        type: 'object',
        properties: {
          order_number: { type: 'string', description: 'Order number (with or without #)' },
          address1: { type: 'string', description: 'Street address with BOTH number and street name (e.g. "2437 South Boulevard"), or PO Box (e.g. "PO Box 3614")' },
          address2: { type: 'string', description: 'Apt, suite, unit (optional)' },
          city: { type: 'string', description: 'City' },
          province: { type: 'string', description: 'State or province name (e.g. "California")' },
          zip: { type: 'string', description: 'ZIP or postal code' },
          country_code: { type: 'string', description: 'Two-letter country code. Default: US' }
        },
        required: ['order_number', 'address1', 'city', 'province', 'zip']
      }
    },
    {
      type: 'function', name: 'send_portal_link',
      description: "Email the customer their subscription portal link. Use when they need to update their payment method — don't escalate to Slack for this.",
      parameters: {
        type: 'object',
        properties: {
          customer_email: { type: 'string', description: "Customer's email address" },
          customer_name: { type: 'string', description: "Customer's full name" },
        },
        required: ['customer_email']
      }
    },
    {
      type: 'function', name: 'notify_slack',
      description: 'Send a message to the Plants Basically team in Slack. Use for escalations that need immediate human attention.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What happened and what needs follow-up. MUST include customer name, email or phone, and order number if known.' },
          urgent: { type: 'boolean', description: 'true to @mention Kyle directly. Use for: chargeback/legal, adverse reaction, refund over $150, manager request, batch quality issue.' },
          callback_phone: { type: 'string', description: "Customer's phone number in E.164 format (e.g. +16318386044) if they requested a callback. Adds a one-click call back link to the Slack message." },
          callback_name: { type: 'string', description: "Customer's full name — included in the callback link so the agent knows who they're calling." }
        },
        required: ['message']
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

  router.post('/incoming', express.urlencoded({ extended: false }), (req, res) => {
    const host = req.headers.host;
    const from = req.body?.From || '';
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/voice/stream" statusCallback="https://${host}/voice/status">
      <Parameter name="from" value="${from}"/>
    </Stream>
  </Connect>
</Response>`);
  });

  router.post('/status', (req, res) => {
    console.log('[voice] call ended', req.body?.CallStatus);
    res.sendStatus(200);
  });

  // Auth helper — same Basic auth as /voice/logs
  function requireAuth(req, res, next) {
    const auth = req.headers.authorization || '';
    const b64 = auth.replace(/^Basic /, '');
    const decoded = Buffer.from(b64, 'base64').toString();
    const password = decoded.split(':')[1];
    if (!SETUP_PASSWORD || password !== SETUP_PASSWORD) {
      res.set('WWW-Authenticate', 'Basic realm="Milo"');
      return res.status(401).send('Unauthorized');
    }
    next();
  }

  // Normalize a phone number to E.164 (US default) for comparison and dialing.
  // "1-888-868-2205" / "(888) 868-2205" / "+18888682205" all → "+18888682205"
  function toE164(num) {
    if (!num) return null;
    const digits = String(num).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length === 10) return `+1${digits}`;
    return `+${digits}`;
  }

  // POST /voice/dial — initiate a two-leg outbound call
  // Twilio calls the agent first; when they pick up, bridges to the customer.
  // Body: { to: "+16318386044", agent: "+15551234567" }
  // agent is optional — falls back to AGENT_PHONE_NUMBER env var
  router.post('/dial', express.json(), async (req, res) => {
    // Accept Basic auth OR a secret token in the request body
    const { to: toRaw, agent, secret } = req.body || {};
    const basicAuth = req.headers.authorization || '';
    const basicPassword = Buffer.from(basicAuth.replace(/^Basic /, ''), 'base64').toString().split(':')[1];
    if (secret !== SETUP_PASSWORD && basicPassword !== SETUP_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const to = toE164(toRaw);
      const agentPhone = toE164(agent || process.env.AGENT_PHONE_NUMBER);
      if (!to) return res.status(400).json({ error: 'to is required' });
      if (!agentPhone) return res.status(400).json({ error: 'agent phone not set — pass agent in body or set AGENT_PHONE_NUMBER env var' });
      const from = process.env.TWILIO_PHONE_NUMBER;
      if (!from) return res.status(400).json({ error: 'TWILIO_PHONE_NUMBER env var not set' });

      // Guard against the Milo loop: dialing our own Twilio number routes to
      // /incoming and the AI answers as the "agent" or "customer".
      const ownNumber = toE164(from);
      if (agentPhone === ownNumber) {
        return res.status(400).json({ error: `That's the company line (${from}) — enter your own cell number in "Your Phone Number".` });
      }
      if (to === ownNumber) {
        return res.status(400).json({ error: `The customer number is the company line (${from}) — this link is broken, don't use it.` });
      }
      if (agentPhone === to) {
        return res.status(400).json({ error: "Your number and the customer's number are the same — enter YOUR cell in \"Your Phone Number\", not the customer's." });
      }

      const bridgeUrl = `https://${req.headers.host}/voice/bridge?to=${encodeURIComponent(to)}`;
      const call = await twilioClient.calls.create({
        to: agentPhone,
        from,
        url: bridgeUrl,
      });
      console.log(`[voice/dial] agent=${agentPhone} customer=${to} sid=${call.sid}`);
      res.json({ success: true, sid: call.sid, message: `Calling your phone now — pick up and we'll connect you to ${to}` });
    } catch (err) {
      console.error('[voice/dial]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /voice/token — mint a Twilio Voice access token for browser calling
  // The callback page uses this to register the agent's browser as a softphone.
  router.post('/token', express.json(), (req, res) => {
    const { secret, name } = req.body || {};
    if (secret !== SETUP_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const appSid = process.env.TWILIO_TWIML_APP_SID;
    if (!apiKeySid || !apiKeySecret || !appSid) {
      return res.status(400).json({ error: 'Browser calling not configured — set TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID' });
    }
    const identity = `agent-${String(name || 'anon').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24) || 'anon'}`;
    const AccessToken = twilio.jwt.AccessToken;
    const token = new AccessToken(process.env.TWILIO_ACCOUNT_SID, apiKeySid, apiKeySecret, { identity, ttl: 3600 });
    token.addGrant(new AccessToken.VoiceGrant({ outgoingApplicationSid: appSid, incomingAllow: false }));
    res.json({ token: token.toJwt(), identity });
  });

  // POST /voice/agent-dial — TwiML webhook for the browser softphone.
  // The Voice SDK connect() params arrive in the body; dial the customer
  // with the company caller ID. Same own-number guard as /voice/dial.
  router.post('/agent-dial', express.urlencoded({ extended: false }), (req, res) => {
    const to = toE164(req.body?.To);
    const from = process.env.TWILIO_PHONE_NUMBER || '';
    if (!to || to === toE164(from)) {
      console.error(`[voice/agent-dial] rejected to=${req.body?.To}`);
      return res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Invalid customer number.</Say></Response>');
    }
    console.log(`[voice/agent-dial] browser agent ${req.body?.From || ''} dialing ${to}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${from}" answerOnBridge="true"><Number>${to}</Number></Dial>
</Response>`);
  });

  // POST /voice/bridge — TwiML returned when agent picks up, dials the customer
  // Twilio POSTs to this URL by default when the call is answered
  router.post('/bridge', (req, res) => {
    const to = req.query.to;
    if (!to) return res.status(400).send('Missing to');
    const callerId = process.env.TWILIO_PHONE_NUMBER || '';
    const callerIdAttr = callerId ? ` callerId="${callerId}"` : '';
    console.log(`[voice/bridge] bridging to=${to} callerId=${callerId}`);
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Connecting you now.</Say>
  <Dial${callerIdAttr}><Number>${to}</Number></Dial>
</Response>`);
  });

  // GET /voice/dashboard — call log UI
  router.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/voice-dashboard.html'));
  });

  // GET /voice/callback — agent click-to-call page (linked from Gorgias tickets)
  // No auth required on the page itself — secret token is embedded in the URL
  router.get('/callback', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/voice-callback.html'));
  });

  // GET /voice/new-call — link generator: paste any phone number, get a
  // callback link or call immediately. Bookmarked with ?s=<SETUP_PASSWORD>;
  // generated links reuse that secret so they always work.
  router.get('/new-call', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/voice-dialer.html'));
  });

  // GET /voice/logs — view recent call transcripts (password protected)
  router.get('/logs', requireAuth, (req, res) => {

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
  let responseActive = false; // track whether xAI has an active response to cancel

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

  async function endCall() {
    log.ended_at = new Date().toISOString();
    log.duration_seconds = Math.round((Date.now() - startTime) / 1000);
    const gorgiasResult = await logCallToGorgias(log);
    log.gorgias = gorgiasResult || null;
    saveCallLog(log);
    console.log(`[voice] call ended — ${log.duration_seconds}s, ${log.transcript.length} turns, saved ${callId}, gorgias:`, JSON.stringify(gorgiasResult));
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

      case 'response.created':
        responseActive = true;
        break;

      case 'response.output_audio.delta':
        responseActive = true;
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
      case 'response.cancelled':
        responseActive = false;
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
        if (responseActive) {
          responseActive = false;
          xaiWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
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
      log.caller_phone = data.start.customParameters?.from || data.start.customParameters?.From || null;
      console.log('[voice] Twilio stream started, sid:', streamSid, 'from:', log.caller_phone);
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
