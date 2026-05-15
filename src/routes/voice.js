// src/routes/voice.js
import express from 'express';
import WebSocket from 'ws';
import twilio from 'twilio';

const XAI_API_KEY = process.env.XAI_API_KEY;

function ulawToPcm(ulawBuffer) {
  const pcm = new Int16Array(ulawBuffer.length);
  for (let i = 0; i < ulawBuffer.length; i++) {
    const mu = ulawBuffer[i] ^ 0xFF;
    const sign = (mu & 0x80) ? -1 : 1;
    const exponent = (mu & 0x70) >> 4;
    const mantissa = mu & 0x0F;
    pcm[i] = sign * (((mantissa << 4) + 0x08) << (exponent + 3));
  }
  return Buffer.from(pcm.buffer);
}

function pcmToUlaw(pcmBuffer) {
  return pcmBuffer;
}

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
    console.log('📞 New phone call connected - starting Milo');

    const xaiWs = new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    });

    let xaiReady = false;
    let audioBuffer = [];

    xaiWs.on('open', () => {
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
            // ... add all your other tools (get_order_status, get_subscription_details, etc.)

            {
              "type": "file_search",
              "vector_store_ids": ["collection_7fbf149b-f6ea-4034-9bad-61628b626659"],
              "max_num_results": 10
            }
          ],
          input_audio_transcription: { model: "grok-2-audio" },
          audio: {
            input: { format: { type: "audio/pcm", rate: 24000 } },
            output: { format: { type: "audio/pcm", rate: 24000 } }
          }
        }
      }));
    });

    xaiWs.on('message', (data) => {
      const event = JSON.parse(data);

      if (event.type === 'session.updated') {
        xaiReady = true;
        audioBuffer.forEach(chunk => ws.send(chunk));
        audioBuffer = [];
      }

      if (event.type === 'response.output_audio.delta') {
        const audio = pcmToUlaw(Buffer.from(event.delta, 'base64'));
        ws.send(audio);
      }

      if (event.type === 'response.function_call_arguments.done') {
        console.log(`Tool called: ${event.name}`);
        // TODO: implement tool handlers (lookup_account, etc.)
        // const result = await yourToolHandler(event.name, JSON.parse(event.arguments));
        // xaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(result) } }));
        // xaiWs.send(JSON.stringify({ type: 'response.create' }));
      }
    });

    ws.on('message', (message) => {
      if (!xaiReady) {
        audioBuffer.push(message);
        return;
      }
      const pcm = ulawToPcm(message);
      xaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: pcm.toString('base64')
      }));
    });

    ws.on('close', () => xaiWs.close());
    xaiWs.on('close', () => ws.close());
  });

  // 3. Call status webhook
  router.post('/status', (req, res) => {
    console.log('📞 Call ended', req.body);
    res.sendStatus(200);
  });

  return router;
}
