#!/usr/bin/env node
// Parkbase MVP - Voice Agent + Simulated Backend Integration
import http from 'node:http'
import { aai, loadEnv, publishAgent, readAgent, required, storedAgentId } from '../../lib.mjs'

loadEnv()
required('ASSEMBLYAI_API_KEY', 'get one at https://www.assemblyai.com/dashboard/api-keys')

// --- PARKBASE BACKEND SIMULATION ---
class ParkbaseBackend {
  constructor() {
    this.lotId = 'LOT-A';
    this.inventory = [
      { id: 'C2', level: '1', section: 'B', rate: 60, available: true },
      { id: 'A5', level: '2', section: 'A', rate: 50, available: true },
      { id: 'D1', level: '1', section: 'D', rate: 60, available: false },
    ];
    this.reservations = new Map();
    this.logs = [];
  }

  log(type, message) {
    const entry = `[${new Date().toLocaleTimeString()}] ${type}: ${message}`;
    this.logs.unshift(entry);
    console.log(entry);
    return entry;
  }

  // 1. ANPR / LPR Simulation
  detectVehicle(plateNumber) {
    this.log('ANPR', `Vehicle detected: ${plateNumber}`);
    return { plateNumber, type: '4W', timestamp: new Date() };
  }

  // 2. Inventory Check
  checkAvailability(vehicleType) {
    const spots = this.inventory.filter(s => s.available);
    this.log('DB', `Checked availability for ${vehicleType}. Found ${spots.length} spots.`);
    return {
      spots: spots.map(s => `${s.id} (L${s.level}-${s.section}) ₹${s.rate}/hr`),
      count: spots.length
    };
  }

  // 3. Reservation Creation
  reserveSpot(spotId, durationHours, vehicleType) {
    const spot = this.inventory.find(s => s.id === spotId);
    if (!spot || !spot.available) {
      this.log('ERROR', `Reservation failed: Spot ${spotId} unavailable`);
      return { success: false, message: `Sorry, spot ${spotId} is no longer available.` };
    }
    
    const totalAmount = spot.rate * durationHours;
    const resId = `PB-${Date.now().toString(36).toUpperCase()}`;
    
    spot.available = false;
    this.reservations.set(resId, { spotId, durationHours, amount: totalAmount });
    this.log('DB', `Spot ${spotId} reserved for ${durationHours}h. Total: ₹${totalAmount}`);
    
    return { 
      success: true, 
      reservationId: resId, 
      spotId, 
      totalAmount, 
      message: `Reserved ${spotId} for ${durationHours}h. Total: ₹${totalAmount}` 
    };
  }

  // 4. Payment Link Generation
  generatePaymentLink(reservationId, amount, phone) {
    this.log('PAYMENT', `WhatsApp link generated for ${reservationId}. Amount: ₹${amount}`);
    return {
      platform: 'whatsapp',
      link: `https://pay.parkbase.io/${reservationId}`,
      message: `Pay ₹${amount} for Spot ${reservationId}. Reply PAY to confirm.`
    };
  }

  // 5. Navigation Handoff
  getNavigation(spotId) {
    const spot = this.inventory.find(s => s.id === spotId);
    if (!spot) return { error: 'Spot not found' };
    this.log('NAV', `Google Maps link generated for ${spotId}`);
    return {
      destination: `Level ${spot.level}, Section ${spot.section}, Spot ${spot.id}`,
      walkTime: '2 min',
      mapsLink: `google.navigation:q=Parkbase+Lot+${this.lotId}+Spot+${spot.id}`
    };
  }

  getLogs() { return this.logs.slice(0, 10); }
}

const backend = new ParkbaseBackend();

// --- AGENT SETUP ---
const AGENT = await (async () => {
  const name = process.env.AGENT || 'minimal'
  const known = storedAgentId(name)
  if (known) {
    try {
      const agent = await aai(`/agents/${known}`)
      return { id: known, name: agent.name || 'Parkbase' }
    } catch (error) {
      console.error(`Could not load agent ${known}: ${error.message}`)
      process.exit(1)
    }
  }
  const agent = readAgent(name)
  try {
    const { id, created } = await publishAgent(agent, { name, reuseByName: true })
    console.log(`${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`)
    return { id, name: agent.name }
  } catch (error) {
    console.error(`Could not publish agents/${name}.jsonc: ${error.message}`)
    process.exit(1)
  }
})()

console.log(`Agent: ${AGENT.id}`)

// --- CLIENT APP (PARKBASE DEMO UI) ---
function clientApp() {
  const $ = (id) => document.getElementById(id)
  const WIRE_RATE = 24_000
  const AGENT = window.AGENT

  // Audio Worklets (Unchanged from starter)
  const CAPTURE_WORKLET = `
    class CaptureProcessor extends AudioWorkletProcessor {
      constructor() { super(); this._ratio = sampleRate / ${WIRE_RATE}; this._pos = 0; this._prev = 0; }
      _toPcm(samples, len) { const pcm = new Int16Array(len); for(let i=0;i<len;i++){const s=Math.max(-1,Math.min(1,samples[i]));pcm[i]=s<0?s*0x8000:s*0x7fff;} return pcm; }
      process(inputs) { const ch = inputs[0]?.[0]; if(!ch) return true; if(this._ratio===1){const pcm=this._toPcm(ch,ch.length);this.port.postMessage(pcm.buffer,[pcm.buffer]);return true;} const n=ch.length; if(!this._src||this._src.length<n+1){this._src=new Float32Array(n+1);this._out=new Float32Array(Math.ceil((n+1)/this._ratio)+2);} const src=this._src;const out=this._out;src[0]=this._prev;src.set(ch,1);let outLen=0;let pos=this._pos;while(pos<n){const i=Math.floor(pos);const frac=pos-i;out[outLen++]=src[i]+(src[i+1]-src[i])*frac;pos+=this._ratio;} this._pos=pos-n;this._prev=ch[n-1];if(outLen){const pcm=this._toPcm(out,outLen);this.port.postMessage(pcm.buffer,[pcm.buffer]);} return true; }
    } registerProcessor('capture', CaptureProcessor);`

  const PLAYBACK_WORKLET = `
    class PlaybackProcessor extends AudioWorkletProcessor {
      constructor() { super(); this._ring=new Float32Array(sampleRate*30);this._writePos=0;this._readPos=0;this._available=0;this._step=${WIRE_RATE}/sampleRate;this._rsPos=0;this._rsPrev=0;this._drained=false;this.port.onmessage=(e)=>{if(e.data==='stop'){this._writePos=this._readPos=this._available=0;this._rsPos=this._rsPrev=0;return;} const int16=new Int16Array(e.data);if(!int16.length)return;if(this._drained){this._rsPrev=0;this._rsPos=0;this._drained=false;} if(this._step===1){for(let i=0;i<int16.length;i++)this._push(int16[i]/32768);return;} const n=int16.length;let pos=this._rsPos;while(pos<n){const i=Math.floor(pos);const frac=pos-i;const a=i===0?this._rsPrev:int16[i-1]/32768;const b=int16[i]/32768;this._push(a+(b-a)*frac);pos+=this._step;} this._rsPos=pos-n;this._rsPrev=int16[n-1]/32768;}; }
      _push(v) { if(this._available<this._ring.length){this._ring[this._writePos]=v;this._writePos=(this._writePos+1)%this._ring.length;this._available++;} }
      process(inputs, outputs) { const output=outputs[0];const out=output[0];const cap=this._ring.length;for(let i=0;i<out.length;i++){if(this._available>0){out[i]=this._ring[this._readPos];this._readPos=(this._readPos+1)%cap;this._available--;}else{out[i]=0;this._drained=true;}} for(let ch=1;ch<output.length;ch++)output[ch].set(out);return true; }
    } registerProcessor('playback', PlaybackProcessor);`

  const blobUrl = (code) => URL.createObjectURL(new Blob([code], { type: 'application/javascript' }))
  let ws, captureCtx, playbackCtx, playback, mic, callStart, timer

  async function listMics() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter(d => d.kind === 'audioinput').filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications')
    const select = $('mic'); const chosen = select.value; select.replaceChildren()
    const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Default microphone'; select.append(auto)
    inputs.forEach((device, i) => { const opt = document.createElement('option'); opt.value = device.deviceId; opt.textContent = device.label || `Mic ${i+1}`; select.append(opt) })
    if (chosen && inputs.some(d => d.deviceId === chosen)) select.value = chosen
  }
  listMics(); navigator.mediaDevices?.addEventListener?.('devicechange', listMics)

  $('btn').onclick = () => (ws?.readyState <= 1 ? stop() : start())

  async function addWorklet(ctx, code, name) {
    const url = blobUrl(code); try { await ctx.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    return new AudioWorkletNode(ctx, name)
  }

  async function start() {
    $('btn').disabled = true; $('mic').disabled = true; setStatus('connecting')
    try {
      const res = await fetch('/token'); if (!res.ok) { setStatus('error', 'Token failed'); reset(); return }
      const { token } = await res.json()
      captureCtx = new AudioContext({ sampleRate: WIRE_RATE }); playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
      await Promise.all([captureCtx.resume(), playbackCtx.resume()])
      playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback'); playback.connect(playbackCtx.destination)
      const deviceId = $('mic').value
      mic = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId } : {}), channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true, autoGainControl: false, latency: 0 } })
      listMics()
      const capture = await addWorklet(captureCtx, CAPTURE_WORKLET, 'capture'); captureCtx.createMediaStreamSource(mic).connect(capture)
      const url = new URL('wss://agents.assemblyai.com/v1/ws'); url.searchParams.set('token', token)
      ws = new WebSocket(url); let ready = false
      
      capture.port.onmessage = ({ data }) => {
        if (!ready || ws.readyState !== 1) return
        const bytes = new Uint8Array(data); let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        ws.send(JSON.stringify({ type: 'input.audio', audio: btoa(binary) }))
      }

      ws.onopen = () => { ws.send(JSON.stringify({ type: 'session.update', session: { agent_id: AGENT.id } })); }
      
      ws.onmessage = ({ data }) => {
        const msg = JSON.parse(data)
        switch (msg.type) {
          case 'session.ready': ready = true; callStart = Date.now(); timer = setInterval(tick, 1000); tick(); setStatus('listening'); $('btn').disabled = false; $('btn').textContent = 'End Call'; break
          case 'input.speech.started': playback?.port.postMessage('stop'); setStatus('listening'); break
          case 'reply.started': setStatus('speaking'); break
          case 'reply.audio': { try { const raw = atob(msg.data); const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i); playback?.port.postMessage(bytes.buffer, [bytes.buffer]); } catch(e) { console.error('Audio decode error:', e); } break; }
          case 'reply.done': setStatus('listening'); if (msg.status === 'interrupted') playback?.port.postMessage('stop'); break
          case 'transcript.user.delta': partial('you', msg.text); break
          case 'transcript.agent.delta': if (msg.reply_id && msg.reply_id === printedReply) break; if (msg.reply_id !== liveReply) { liveReply = msg.reply_id; dropPartial('agent'); } partial('agent', appendDelta(partialText.agent || '', msg.delta)); break
          case 'transcript.user': addLine('you', msg.text); break
          case 'transcript.agent': printedReply = msg.reply_id ?? printedReply; addLine('agent', msg.text); break
          case 'tool.call': 
            addLine('tool', `${msg.name}(${JSON.stringify(msg.arguments ?? {})})`); 
            // TRIGGER BACKEND SIMULATION HERE
            handleToolCall(msg.name, msg.arguments);
            break
          case 'session.ended': ws.close(); break
          case 'session.error': setStatus('error', msg.message); break
        }
      }
      ws.onclose = () => { setStatus('idle'); reset() }; ws.onerror = () => { setStatus('error', 'Connection failed'); reset() }
    } catch (error) { setStatus('error', error.message); reset() }
  }

  // --- BACKEND SIMULATION HANDLER ---
  function handleToolCall(toolName, args) {
    setTimeout(() => {
      let logMsg = '';
      switch(toolName) {
        case 'check_parking_availability':
          const avail = backend.checkAvailability(args.vehicle_type);
          logMsg = backend.logs[0];
          break;
        case 'reserve_spot':
          const res = backend.reserveSpot(args.spot_id, args.duration_hours, args.vehicle_type);
          if(res.success) {
            // Trigger WhatsApp simulation after 2s
            setTimeout(() => showWhatsAppMessage(res.reservationId, res.totalAmount), 2000);
          }
          logMsg = backend.logs[0];
          break;
        case 'get_navigation':
          const nav = backend.getNavigation(args.spot_id);
          if(nav.mapsLink) showNavigationButton(nav.mapsLink, nav.destination);
          logMsg = backend.logs[0];
          break;
      }
      if(logMsg) addSystemLog(logMsg);
    }, 500); // Simulate network latency
  }

  function showWhatsAppMessage(resId, amount) {
    const chatArea = $('chat-area');
    const waMsg = document.createElement('div');
    waMsg.className = 'msg whatsapp';
    waMsg.innerHTML = `
      <div class="who-label">WhatsApp</div>
      <div style="background:#DCF8C6;padding:10px;border-radius:12px;font-size:0.8rem;color:#1a1a1a;">
        ✅ Reservation Confirmed!<br>
        Spot: ${resId}<br>
        Amount: ₹${amount}<br><br>
        <button onclick="simulatePayment('${resId}')" style="background:#25D366;color:white;border:none;padding:6px 12px;border-radius:6px;font-weight:bold;cursor:pointer;margin-top:5px;">PAY NOW</button>
      </div>
    `;
    chatArea.appendChild(waMsg);
    scroll(chatArea);
    addSystemLog(`[PAYMENT] WhatsApp message sent for ${resId}`);
  }

  window.simulatePayment = function(resId) {
    addSystemLog(`[PAYMENT] Payment confirmed for ${resId}`);
    addLine('agent', `Payment received! I'm generating your navigation instructions now.`);
    // Trigger navigation tool call simulation
    setTimeout(() => {
      const nav = backend.getNavigation('C2'); // Default to C2 for demo
      if(nav.mapsLink) showNavigationButton(nav.mapsLink, nav.destination);
    }, 1000);
  };

  function showNavigationButton(link, dest) {
    const chatArea = $('chat-area');
    const navMsg = document.createElement('div');
    navMsg.className = 'msg agent';
    navMsg.innerHTML = `
      <div class="who-label">Parkbase</div>
      📍 ${dest}<br>
      <a href="${link}" target="_blank" style="display:inline-block;margin-top:8px;background:#2563eb;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.8rem;font-weight:bold;">Open in Google Maps</a>
    `;
    chatArea.appendChild(navMsg);
    scroll(chatArea);
  }

  function addSystemLog(msg) {
    const logsEl = $('system-logs');
    const logEntry = document.createElement('div');
    logEntry.style.cssText = 'font-family:monospace;font-size:0.7rem;color:#64748b;padding:2px 0;border-bottom:1px solid #f1f5f9;';
    logEntry.textContent = msg;
    logsEl.prepend(logEntry);
    if(logsEl.children.length > 10) logsEl.lastChild.remove();
  }

  function stop() {
    if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'session.end' })); setTimeout(() => { if (ws?.readyState === 1) ws.close() }, 3000) } else { ws?.close() }
    playback?.port.postMessage('stop'); mic?.getTracks().forEach(t => t.stop()); captureCtx?.close(); playbackCtx?.close()
    captureCtx = playbackCtx = playback = mic = null; reset(); setStatus('idle')
  }

  function reset() { clearInterval(timer); clearPartials(); $('btn').disabled = false; $('mic').disabled = false; $('btn').textContent = 'Start Call' }
  function setStatus(state, detail) { $('status').className = 'status ' + state; $('status-text').textContent = detail || state }
  
  const COST_PER_SECOND = 4.5 / 3600
  function tick() { const seconds = Math.floor((Date.now() - callStart) / 1000); $('elapsed').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); $('cost').textContent = '$' + (seconds * COST_PER_SECOND).toFixed(3) }

  // Transcript Handling
  const partialText = {}; const partialEl = {}; let liveReply = null; let printedReply = null
  const ATTACHES_LEFT = /^[.,!?;:%°)\]}…'"’”]/; const NO_SPACE_AFTER = /[([{$\-\/'"‘“]$/
  function appendDelta(text, delta) { if (!delta) return text; if (!text) return delta; if (/^\s/.test(delta) || /\s$/.test(text)) return text + delta; if (ATTACHES_LEFT.test(delta) || NO_SPACE_AFTER.test(text)) return text + delta; return text + ' ' + delta }
  function dropPartial(who) { partialEl[who]?.remove(); delete partialEl[who]; delete partialText[who] }
  function transcriptLine(who, text) { const line = document.createElement('div'); line.className = 'line ' + who; const label = document.createElement('span'); label.className = 'who'; label.textContent = who === 'agent' ? 'Parkbase' : 'You'; const body = document.createElement('span'); body.className = 'said'; body.textContent = text; line.append(label, body); return line }
  function scroll(el) { el.scrollTop = el.scrollHeight }
  function partial(who, text) { partialText[who] = text; if (partialEl[who]) { partialEl[who].querySelector('.said').textContent = text } else { partialEl[who] = transcriptLine(who, text); $('chat-area').append(partialEl[who]) } scroll($('chat-area')) }
  function addLine(who, text) { dropPartial(who); $('chat-area').append(transcriptLine(who, text)); scroll($('chat-area')) }
  function clearPartials() { for (const who of Object.keys(partialEl)) dropPartial(who); liveReply = printedReply = null }
}

// --- PARKBASE DEMO LAYOUT HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Parkbase MVP</title>
<style>
  :root { --primary: #2563eb; --bg: #f8fafc; --surface: #ffffff; --text: #1e293b; --border: #e2e8f0; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: var(--bg); color: var(--text); height: 100vh; display: flex; align-items: center; justify-content: center; gap: 4rem; padding: 2rem; }
  
  /* LEFT PANEL: CONTROLS & LOGS */
  .controls-panel { width: 400px; background: var(--surface); border-radius: 16px; box-shadow: 0 10px 30px -10px rgba(0,0,0,0.1); border: 1px solid var(--border); overflow: hidden; display:flex; flex-direction:column; max-height:80vh; }
  .panel-header { padding: 1.5rem; border-bottom: 1px solid var(--border); background: #f1f5f9; }
  .panel-header h2 { font-size: 1.25rem; font-weight: 700; color: #0f172a; }
  .panel-header p { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .panel-body { padding: 1.5rem; flex:1; overflow-y:auto; display: flex; flex-direction: column; gap: 1.5rem; }
  .control-group h3 { font-size: 0.75rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 0.75rem; letter-spacing: 0.05em; }
  .btn-primary { width: 100%; padding: 0.75rem; background: var(--primary); color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-outline { width: 100%; padding: 0.75rem; background: transparent; border: 1px solid var(--border); color: #64748b; border-radius: 8px; font-weight: 500; cursor: pointer; margin-top: 0.5rem; }
  .btn-outline:hover { background: #f8fafc; color: var(--text); }
  .vehicle-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
  .vehicle-btn { padding: 0.5rem; border: 1px solid var(--border); background: white; border-radius: 6px; font-size: 0.875rem; cursor: pointer; }
  .vehicle-btn.active { background: var(--primary); color: white; border-color: var(--primary); }
  
  /* SYSTEM LOGS */
  .system-logs-container { margin-top:auto; border-top:1px solid var(--border); padding-top:1rem; }
  .system-logs-container h3 { font-size: 0.75rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
  #system-logs { max-height:150px; overflow-y:auto; font-family:monospace; font-size:0.7rem; }
  
  /* RIGHT PANEL: PHONE MOCKUP */
  .phone-wrapper { position: relative; }
  .phone-frame { width: 320px; height: 650px; background: #1e293b; border-radius: 40px; padding: 12px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); border: 4px solid #0f172a; position: relative; }
  .phone-notch { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 120px; height: 24px; background: #0f172a; border-bottom-left-radius: 16px; border-bottom-right-radius: 16px; z-index: 10; }
  .phone-screen { width: 100%; height: 100%; background: white; border-radius: 32px; overflow: hidden; display: flex; flex-direction: column; position: relative; }
  .app-header { padding: 2rem 1.5rem 1rem; text-align: center; border-bottom: 1px solid #f1f5f9; }
  .app-header h1 { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.025em; }
  .app-header span { font-size: 0.625rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; }
  
  /* CHAT AREA INSIDE PHONE */
  #chat-area { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; background: #f8fafc; }
  .msg { max-width: 85%; padding: 0.75rem 1rem; border-radius: 16px; font-size: 0.875rem; line-height: 1.4; animation: slideUp 0.3s ease-out; }
  @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .msg.agent { background: white; border: 1px solid var(--border); align-self: flex-start; border-bottom-left-radius: 4px; color: #334155; }
  .msg.you { background: var(--primary); color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
  .msg.tool { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; font-family: monospace; font-size: 0.75rem; align-self: center; max-width: 95%; }
  .msg.whatsapp { background:transparent; border:none; align-self:center; max-width:95%; padding:0; }
  .who-label { font-size: 0.625rem; font-weight: 700; margin-bottom: 0.25rem; opacity: 0.7; text-transform: uppercase; }
  
  /* STATUS BAR & MIC */
  .status-bar { padding: 1rem; text-align: center; border-top: 1px solid var(--border); background: white; }
  .status-indicator { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; font-weight: 600; color: #64748b; margin-bottom: 0.75rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  .status.listening .dot { background: #ef4444; animation: pulse 1s infinite; }
  .status.speaking .dot { background: var(--primary); animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  #mic-select { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-size: 0.875rem; margin-bottom: 0.75rem; background: white; }
  #btn { width: 100%; padding: 1rem; background: var(--primary); color: white; border: none; border-radius: 12px; font-weight: 700; font-size: 1rem; cursor: pointer; transition: all 0.2s; }
  #btn:hover:not(:disabled) { background: #1d4ed8; transform: translateY(-1px); }
  #btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #btn.live { background: #ef4444; }
  
  /* METRICS */
  .metrics { display: flex; justify-content: space-between; padding: 0.5rem 1rem; background: #f1f5f9; font-size: 0.75rem; font-family: monospace; color: #64748b; }
</style>
</head>
<body>
  <!-- LEFT: DEMO CONTROLS -->
  <div class="controls-panel">
    <div class="panel-header">
      <p>Demo Walkthrough</p>
      <h2>Parkbase Controls</h2>
    </div>
    <div class="panel-body">
      <div class="control-group">
        <h3>Entry Scenarios</h3>
        <button class="btn-primary" onclick="alert('Session Reset!')">▶ New Ticket (Reset)</button>
        <button class="btn-outline" onclick="alert('Simulating Lot Full...')">⚠️ Simulate Lot Full</button>
      </div>
      <div class="control-group">
        <h3>Vehicle Type</h3>
        <div class="vehicle-grid">
          <button class="vehicle-btn active">Auto</button>
          <button class="vehicle-btn">4W</button>
          <button class="vehicle-btn">2W</button>
        </div>
      </div>
      <div class="control-group">
        <h3>Exit Scenarios</h3>
        <button class="btn-outline">🅿️ Exit — Overstay</button>
        <button class="btn-outline">✅ Exit — Completed</button>
      </div>
      
      <!-- SYSTEM LOGS -->
      <div class="system-logs-container">
        <h3>Live System Logs</h3>
        <div id="system-logs"></div>
      </div>
    </div>
  </div>

  <!-- RIGHT: PHONE MOCKUP -->
  <div class="phone-wrapper">
    <div class="phone-frame">
      <div class="phone-notch"></div>
      <div class="phone-screen">
        <div class="app-header">
          <h1>PARKBASE</h1>
          <span>Voice Parking Assistant</span>
        </div>
        
        <div id="chat-area">
          <div class="empty" style="text-align:center; color:#94a3b8; margin-top:2rem; font-size:0.875rem;">Tap "Start Call" to begin<br>your parking journey</div>
        </div>

        <div class="metrics">
          <span id="elapsed">0:00</span>
          <span id="cost">$0.000</span>
        </div>

        <div class="status-bar">
          <div class="status-indicator status idle" id="status">
            <span class="dot"></span>
            <span id="status-text">Ready to talk</span>
          </div>
          <select id="mic" aria-label="Microphone"><option value="">Default microphone</option></select>
          <button id="btn">Start Call</button>
        </div>
      </div>
    </div>
  </div>

<script>window.AGENT = ${JSON.stringify(AGENT).replace(/</g, '\\u003c')}</script>
<script src="/app.js"></script>
</body>
</html>`

// --- SERVER LOGIC ---
const server = http.createServer(async (req, res) => {
  if (req.url === '/agent') {
    try {
      const agent = await aai(`/agents/${AGENT.id}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(agent))
    } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: 'failed' })) }
    return
  }
  if (req.url === '/token') {
    try {
      const token = await aai('/token?product=voice_agent&expires_in_seconds=60')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(token))
    } catch (error) { res.writeHead(502); res.end(JSON.stringify({ error: 'failed' })) }
    return
  }
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('(' + clientApp.toString() + ')();')
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(HTML)
})

let port = Number(process.env.PORT) || 3000
server.on('error', (err) => { if (err.code === 'EADDRINUSE' && !process.env.PORT && port < 3010) { port += 1; server.listen(port); return; } throw err })
server.on('listening', () => console.log(`Parkbase Demo: http://localhost:${port}`))
server.listen(port)