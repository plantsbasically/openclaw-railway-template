// src/routes/voice.js
import express from 'express';
import WebSocket from 'ws';
import twilio from 'twilio';

const XAI_API_KEY = process.env.XAI_API_KEY;

export default function setupVoiceRoutes(wsInstance) {
  const router = express.Router();
  wsInstance.applyTo(router);

  // 1. Incoming call webhook - returns TwiML (no <Say>, Milo greets via xAI)
  router.post('/incoming', (req, res) => {
    const host = req.headers.host;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/voice/stream" statusCallback="https://${host}/voice/status" />
  </Connect>
</Response>`;
    res.type('text/xml').send(twiml);
  });

  // 2. Media Stream WebSocket (Twilio ↔ xAI)
  router.ws('/stream', (ws, req) => {
    console.log('[voice] call connected');

    let streamSid = null;
    let sessionReady = false;

    const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    // ── xAI → Twilio ──────────────────────────────────────────────────────────

    xaiWs.on('open', () => {
      console.log('[voice] xAI connected');
    });

    xaiWs.on('message', (data) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }

      if (event.type !== 'response.output_audio.delta') {
        console.log('[voice] xAI event:', event.type);
      }

      switch (event.type) {
        case 'conversation.created':
          // Send session config once xAI confirms conversation is ready
          xaiWs.send(JSON.stringify({
            type: 'session.update',
            session: {
              voice: 'rex',
              instructions: "You are Milo, customer support for Plants Basically. We sell Juicy Joint Protocol, a daily liquid supplement for joint pain relief. Speak warm, casual, direct. Sound like a real person helping a friend. Not a corporate bot. Short sentences. Natural pauses. Warm, calm, practical. You care, but direct.\n\nGoals: Resolve issues fast. Positive vibe. Look up orders. Track shipments. Status updates. Returns, exchanges, refunds per policy. Troubleshoot products step-by-step. FAQs on products, services, policies. Escalate complex stuff.\n\nBe patient. Empathetic with frustrated folks. Solutions first. Confirm fixed before end. Clear follow-up expectations if needed. Verify identity before account details. Offer options. Thank for patience, business.\n\nProduct facts: Dose 1-2 full droppers daily. Shelf life 5 years. Ingredients clinically researched, tested. plantsbasically.com. Subs with free shipping.\n\nRules: No diagnosing. No medical advice. No 'stop meds'. No 'heal', 'cure', 'treat'. Medical questions? Point to plantsbasically.com/pages/reviews. On meds, blood thinners, surgery? Consult doctor. No overpromising.\n\nHandle: Helpful. Lead with fix. Sub cancel? Ask why. Offer pause, delay, change schedule first. Shipping issue? Offer order lookup. Concise: 3-4 sentences max.\n\nAvoid: Em dashes. 'Unfortunately'. Scripted sound. Made-up info - say 'I'll look into it, follow up'.\n\nDates/times: Natural only. Take 'next Tuesday', 'tomorrow 3pm'. Confirm natural: 'Tuesday, December 15th at 3 PM'. No format lectures.\n\nUse tools for real actions. Never fake. Verify customer first with lookup_account. Then order/sub actions.",
              turn_detection: { type: 'server_vad' },
              tools: [
                {
                  type: 'function',
                  name: 'lookup_account',
                  description: 'Verify and retrieve customer account details for identity confirmation.',
                  parameters: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' } }, required: ['email'] }
                },
                // ... add your other tools here
                {
                  type: 'file_search',
                  vector_store_ids: ['collection_7fbf149b-f6ea-4034-9bad-61628b626659'],
                  max_num_results: 10
                }
              ],
              // pcmu = G.711 μ-law — no rate field, it's always 8kHz
              audio: {
                input: { format: { type: 'audio/pcmu' } },
                output: { format: { type: 'audio/pcmu' } }
              }
            }
          }));
          break;

        case 'session.updated':
          sessionReady = true;
          // Prompt Milo to greet the caller
          xaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Greet the caller and introduce yourself.' }]
            }
          }));
          xaiWs.send(JSON.stringify({ type: 'response.create' }));
          break;

        case 'response.output_audio.delta':
          // Stream audio directly to Twilio (pcmu passthrough)
          if (streamSid && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: event.delta }
            }));
          }
          break;

        case 'input_audio_buffer.speech_started':
          // User started talking — clear Twilio's playback buffer (barge-in)
          if (streamSid && ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          break;

        case 'response.function_call_arguments.done':
          console.log('[voice] tool called:', event.name);
          // TODO: implement tool handlers
          // const result = await yourHandler(event.name, JSON.parse(event.arguments));
          // xaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) } }));
          // xaiWs.send(JSON.stringify({ type: 'response.create' }));
          break;

        case 'error':
          console.error('[voice] xAI error:', event.error?.message || JSON.stringify(event));
          break;
      }
    });

    xaiWs.on('error', (err) => console.error('[voice] xAI WS error:', err.message));
    xaiWs.on('close', (code) => {
      console.log('[voice] xAI WS closed, code:', code);
      if (ws.readyState === ws.OPEN) ws.close();
    });

    // ── Twilio → xAI ──────────────────────────────────────────────────────────

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
  });

  // 3. Call status webhook
  router.post('/status', (req, res) => {
    console.log('[voice] call ended', req.body?.CallStatus);
    res.sendStatus(200);
  });

  return router;
}
