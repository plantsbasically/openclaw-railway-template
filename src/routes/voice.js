// src/routes/voice.js
import express from 'express';
import WebSocket from 'ws';
import twilio from 'twilio';

const XAI_API_KEY = process.env.XAI_API_KEY;

export default function setupVoiceRoutes(wsInstance) {
  const router = express.Router();
  wsInstance.applyTo(router);

  // 1. Incoming call webhook - returns TwiML
  router.post('/incoming', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({ voice: 'Polly.Joanna' }, 'Thank you for calling Plants Basically. Milo is connecting you now...');

    twiml.connect().stream({
      url: `wss://${req.headers.host}/voice/stream`,
      statusCallback: `https://${req.headers.host}/voice/status`,
    });

    res.type('text/xml').send(twiml.toString());
  });

  // 2. Media Stream WebSocket (Twilio ↔ xAI)
  router.ws('/stream', (ws, req) => {
    console.log('📞 New call connected');

    let streamSid = null;
    let xaiReady = false;
    let audioBuffer = [];

    const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    xaiWs.on('error', (err) => {
      console.error('xAI WebSocket error:', err.message);
    });

    xaiWs.on('open', () => {
      console.log('xAI connected');
      xaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          voice: "rex",
          instructions: "You are Milo, customer support for Plants Basically. We sell Juicy Joint Protocol, a daily liquid supplement for joint pain relief. Speak warm, casual, direct. Sound like a real person helping a friend. Not a corporate bot. Short sentences. Natural pauses. Warm, calm, practical. You care, but direct.\n\nGoals: Resolve issues fast. Positive vibe. Look up orders. Track shipments. Status updates. Returns, exchanges, refunds per policy. Troubleshoot products step-by-step. FAQs on products, services, policies. Escalate complex stuff.\n\nBe patient. Empathetic with frustrated folks. Solutions first. Confirm fixed before end. Clear follow-up expectations if needed. Verify identity before account details. Offer options. Thank for patience, business.\n\nProduct facts: Dose 1-2 full droppers daily. Shelf life 5 years. Ingredients clinically researched, tested. plantsbasically.com. Subs with free shipping.\n\nRules: No diagnosing. No medical advice. No 'stop meds'. No 'heal', 'cure', 'treat'. Medical questions? Point to plantsbasically.com/pages/reviews. On meds, blood thinners, surgery? Consult doctor. No overpromising.\n\nHandle: Helpful. Lead with fix. Sub cancel? Ask why. Offer pause, delay, change schedule first. Shipping issue? Offer order lookup. Concise: 3-4 sentences max.\n\nAvoid: Em dashes. 'Unfortunately'. Scripted sound. Made-up info - say 'I'll look into it, follow up'.\n\nDates/times: Natural only. Take 'next Tuesday', 'tomorrow 3pm'. Confirm natural: 'Tuesday, December 15th at 3 PM'. No format lectures.\n\nUse tools for real actions. Never fake. Verify customer first with lookup_account. Then order/sub actions.",
          turn_detection: { type: "server_vad" },
          tools: [
            {
              type: "function",
              name: "lookup_account",
              description: "Verify and retrieve customer account details for identity confirmation.",
              parameters: { type: "object", properties: { email: { type: "string" }, phone: { type: "string" } }, required: ["email"] }
            },
            // ... add your other tools here
            {
              type: "file_search",
              vector_store_ids: ["collection_7fbf149b-f6ea-4034-9bad-61628b626659"],
              max_num_results: 10
            }
          ],
          input_audio_transcription: { model: "grok-2-audio" },
          // pcmu = G.711 μ-law 8kHz — exactly what Twilio Media Streams sends/expects, no conversion needed
          audio: {
            input: { format: { type: "audio/pcmu", rate: 8000 } },
            output: { format: { type: "audio/pcmu", rate: 8000 } }
          }
        }
      }));
    });

    xaiWs.on('message', (data) => {
      let event;
      try { event = JSON.parse(data); } catch { return; }

      if (event.type === 'session.updated') {
        xaiReady = true;
        audioBuffer.forEach(chunk => {
          xaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk }));
        });
        audioBuffer = [];
      }

      if (event.type === 'response.output_audio.delta' && streamSid) {
        // xAI outputs pcmu base64 → pass directly to Twilio media event
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: event.delta }
          }));
        }
      }

      if (event.type === 'response.function_call_arguments.done') {
        console.log('Tool called:', event.name);
        // TODO: implement tool handlers
        // xaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) } }));
        // xaiWs.send(JSON.stringify({ type: 'response.create' }));
      }
    });

    // Twilio sends JSON events — parse them, don't treat as raw bytes
    ws.on('message', (message) => {
      let data;
      try { data = JSON.parse(message); } catch { return; }

      if (data.event === 'start') {
        streamSid = data.start.streamSid;
        console.log('Twilio stream started, sid:', streamSid);
      }

      if (data.event === 'media') {
        // Twilio payload is already base64 pcmu — pass directly to xAI
        const payload = data.media.payload;
        if (!xaiReady) {
          audioBuffer.push(payload);
          return;
        }
        xaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      }
    });

    ws.on('close', () => {
      console.log('Twilio WS closed');
      xaiWs.close();
    });

    xaiWs.on('close', () => {
      console.log('xAI WS closed');
      if (ws.readyState === ws.OPEN) ws.close();
    });
  });

  // 3. Call status webhook
  router.post('/status', (req, res) => {
    console.log('📞 Call ended', req.body);
    res.sendStatus(200);
  });

  return router;
}
