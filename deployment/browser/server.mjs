
// Parkbase MVP - Voice Agent
//  SAFETY GATE: Prevents LLM from calling tools with invalid spots 
// ATOMIC UI UPDATE: Triggers immediately on tool success, independent of TTS 
import http from 'node:http'
import { aai, loadEnv, publishAgent, readAgent, required, storedAgentId } from '../../lib.mjs'

loadEnv()
required('ASSEMBLYAI_API_KEY')

// ==============================================================================
// 1. PARKBASE BACKEND SIMULATION (The "Brain")
// ==============================================================================
class ParkbaseBackend {
  constructor() {
    this.lotId = 'LOT-A';
    this.inventory = [
      { id: 'C38', level: '1', section: 'C', rate: 60, available: true, nearExit: true },
      { id: 'C12', level: '1', section: 'C', rate: 60, available: true, nearExit: false },
      { id: 'A05', level: '2', section: 'A', rate: 50, available: false, nearExit: false },
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

  checkAvailability(vehicleType) {
    const spots = this.inventory.filter(s => s.available);
    this.log('INVENTORY', `Checked ${vehicleType}. Found ${spots.length} spots.`);
    return { success: true, count: spots.length, spots: spots.map(s => s.id) };
  }

  reserveSpot(spotId, durationHours, vehicleType) {
    const spot = this.inventory.find(s => s.id === spotId);
    if (!spot || !spot.available) {
      this.log('ERROR', `Reservation failed: ${spotId} unavailable`);
      return { success: false, message: `Sorry, ${spotId} was just taken.` };
    }
    const totalAmount = spot.rate * durationHours;
    const resId = `PB-${Date.now().toString(36).toUpperCase()}`;
    spot.available = false;
    this.reservations.set(resId, { spotId, durationHours, amount: totalAmount });
    this.log('RESERVATION', `${spotId} reserved for ${durationHours}h. Total: ₹${totalAmount}`);
    return { success: true, reservationId: resId, spotId, totalAmount };
  }

  generatePaymentLink(reservationId, amount) {
    this.log('PAYMENT', `WhatsApp link generated for ${reservationId}. Amount: ₹${amount}`);
    return { link: `https://pay.parkbase.io/${reservationId}`, amount };
  }

  getNavigation(spotId) {
    const spot = this.inventory.find(s => s.id === spotId);
    if (!spot) return { error: 'Spot not found' };
    this.log('NAVIGATION', `Generated directions for ${spotId}`);
    return {
      destination: `Level ${spot.level}, Section ${spot.section}, Spot ${spot.id}`,
      walkTime: spot.nearExit ? '1 min' : '3 min',
      mapsLink: `google.navigation:q=Parkbase+Lot+${this.lotId}+Spot+${spot.id}`
    };
  }
}

const backend = new ParkbaseBackend();

// ==============================================================================
// 2. AGENT SETUP
// ==============================================================================
const AGENT = await (async () => {
  const name = process.env.AGENT || 'parkbase'
  const known = storedAgentId(name)
  if (known) {
    try {
      const agent = await aai(`/agents/${known}`)
      return { id: known, name: agent.name || 'Parkbase' }
    } catch (error) { console.error(error.message); process.exit(1) }
  }
  const agent = readAgent(name)
  try {
    const { id, created } = await publishAgent(agent, { name, reuseByName: true })
    console.log(`${created ? 'Created' : 'Updated'} "${agent.name}" from agents/${name}.jsonc`)
    return { id, name: agent.name }
  } catch (error) { console.error(error.message); process.exit(1) }
})()

console.log(`Agent: ${AGENT.id}`)

// ==============================================================================
// 3. CLIENT APP (UI & LOGIC)
// ==============================================================================
function clientApp() {
  const $ = (id) => document.getElementById(id)
  const WIRE_RATE = 24_000
  const AGENT = window.AGENT

  // --- LATENCY OBSERVABILITY ---
  let sttStart = 0, llmStart = 0, ttsStart = 0;
  function updateLatencyMetric(elementId, value) {
    const el = document.getElementById(elementId);
    if(el) el.textContent = value;
  }

  // --- ATOMIC UI UPDATERS ---
  window.updateReceipt = function(data) {
    const receipt = document.getElementById('receipt-card');
    if(!receipt) return;
    receipt.style.display = 'block';
    if(data.vehicle) document.getElementById('receipt-vehicle').textContent = data.vehicle;
    if(data.type) document.getElementById('receipt-type').textContent = data.type === '4W' ? 'Four-wheeler' : (data.type === '2W' ? 'Two-wheeler' : 'EV');
    if(data.time) document.getElementById('receipt-time').textContent = data.time;
    if(data.spot) document.getElementById('receipt-spot').textContent = data.spot;
  }

  window.showLiveLayout = function(assignedSpotId) {
    const layout = document.getElementById('live-layout');
    if(!layout) return;
    layout.style.display = 'block';
    const grid = document.getElementById('spots-grid');
    grid.innerHTML = '';
    for(let i=1; i<=24; i++) {
      const spotId = `C${i}`;
      const spotEl = document.createElement('div');
      spotEl.className = 'spot';
      spotEl.textContent = spotId;
      if(spotId === assignedSpotId) spotEl.classList.add('assigned');
      else if(i % 5 === 0) spotEl.classList.add('occupied');
      else spotEl.classList.add('available');
      grid.appendChild(spotEl);
    }
  }

  window.showWhatsAppMessage = function(link, amount) {
    const chatArea = document.getElementById('chat-area');
    const waMsg = document.createElement('div');
    waMsg.className = 'msg whatsapp';
    waMsg.innerHTML = `<span class="who-label">WhatsApp</span><div class="said" style="background:#DCF8C6; color:#1a1a1a; border:none;">✅ Reservation Confirmed!<br>Amount: ₹${amount}<br><br><button onclick="window.simulatePayment()" style="background:#25D366;color:white;border:none;padding:6px 12px;border-radius:6px;font-weight:bold;cursor:pointer;margin-top:5px;">PAY NOW</button></div>`;
    chatArea.appendChild(waMsg);
    scroll(chatArea);
    window.addSystemLog(`[PAYMENT] WhatsApp message sent`);
  }

  window.simulatePayment = function() {
    window.addSystemLog(`[PAYMENT] Payment confirmed`);
    addLine('agent', `Payment received! Generating your navigation instructions now.`);
    setTimeout(() => {
      const nav = backend.getNavigation('C38');
      if(nav && nav.mapsLink) window.showNavigationButton(nav.mapsLink, nav.destination);
    }, 1000);
  }

  window.showNavigationButton = function(link, dest) {
    const chatArea = document.getElementById('chat-area');
    const navMsg = document.createElement('div');
    navMsg.className = 'msg agent';
    navMsg.innerHTML = `<span class="who-label">Parkbase</span><div class="said">📍 ${dest}<br><a href="${link}" target="_blank" style="display:inline-block;margin-top:8px;background:#2563eb;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:0.8rem;font-weight:bold;">Open in Google Maps</a></div>`;
    chatArea.appendChild(navMsg);
    scroll(chatArea);
  }

  window.addSystemLog = function(msg) {
    const logsEl = document.getElementById('system-logs');
    if(!logsEl) return;
    const entry = document.createElement('div');
    entry.style.cssText = 'padding: 2px 0; border-bottom: 1px solid #f1f5f9; word-break: break-all; font-family: monospace; font-size: 0.7rem; color: #64748b;';
    entry.textContent = msg;
    logsEl.prepend(entry);
    if(logsEl.children.length > 15) logsEl.lastChild.remove();
  } 



  // --- AUDIO WORKLETS ---
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
   
  // --- DEMO CONTROL LOGIC (Makes the left panel buttons actually work) ---
  window.resetSystem = function() {
    backend.inventory.forEach(s => s.available = true);
    window.addSystemLog('[SYSTEM] Session reset. All spots available.');
    document.getElementById('receipt-card').style.display = 'none';
    document.getElementById('live-layout').style.display = 'none';
    const btn = document.getElementById('btn-lot-full');
    if(btn) {
      btn.textContent = '⚠️ Simulate Lot Full';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-outline');
    }
  };

  window.toggleLotFull = function() {
    const btn = document.getElementById('btn-lot-full');
    const isFull = backend.inventory.every(s => !s.available);

    if (!isFull) {
      backend.inventory.forEach(s => s.available = false);
      btn.textContent = '✅ Restore Availability';
      btn.classList.remove('btn-outline');
      btn.classList.add('btn-primary');
      window.addSystemLog('[SYSTEM] Simulated: LOT FULL. Agent will reject new bookings.');
    } else {
      window.resetSystem();
    }
  };

  window.setVehicleType = function(type, btnElement) {
    document.querySelectorAll('.vehicle-btn').forEach(b => b.classList.remove('active'));
    btnElement.classList.add('active');
    window.addSystemLog(`[SYSTEM] Default vehicle type set to: ${type}`);
  };

  window.simulateExit = function(scenario) {
    if (scenario === 'overstay') {
      window.addSystemLog('[EXIT] Overstay detected. Calculating additional ₹120 fee...');
      window.addSystemLog('[WHATSAPP] Sending updated payment link for overstay...');
    } else if (scenario === 'postpaid') {
      window.addSystemLog('[EXIT] Postpaid exit. Generating final invoice...');
    } else {
      window.addSystemLog('[EXIT] On-time exit. Gate opened successfully.');
    }
  }; 
  
  async function start() {
    $('btn').disabled = true; $('mic').disabled = true; setStatus('connecting')
    try {
      const res = await fetch('/token'); if (!res.ok) { setStatus('error', 'Token failed'); reset(); return }
      const { token } = await res.json()
      captureCtx = new AudioContext({ sampleRate: WIRE_RATE }); playbackCtx = new AudioContext({ sampleRate: WIRE_RATE })
      await Promise.all([captureCtx.resume(), playbackCtx.resume()])
      playback = await addWorklet(playbackCtx, PLAYBACK_WORKLET, 'playback'); playback.connect(playbackCtx.destination)
      const deviceId = $('mic').value
      
      // OPTIMIZED AUDIO PIPELINE
      mic = await navigator.mediaDevices.getUserMedia({ 
        audio: { 
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}), 
          channelCount: 1, 
          sampleRate: 24000, 
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: false, 
          latency: 0 
        } 
      })
      
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
          case 'session.ready': 
            ready = true; callStart = Date.now(); timer = setInterval(tick, 1000); tick(); 
            setStatus('listening'); $('btn').disabled = false; $('btn').textContent = 'End Call'; 
            break
          case 'input.speech.started':
            sttStart = performance.now();
            setStatus('listening');
            break;
          case 'reply.started':
            llmStart = performance.now();
            updateLatencyMetric('stt-lat', (llmStart - sttStart).toFixed(0));
            setStatus('speaking');
            break;
          case 'reply.audio': {
            if(ttsStart === 0) {
              ttsStart = performance.now();
              updateLatencyMetric('llm-lat', (ttsStart - llmStart).toFixed(0));
            }
            try {
              const raw = atob(msg.data);
              const bytes = new Uint8Array(raw.length);
              for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
              playback?.port.postMessage(bytes.buffer, [bytes.buffer]);
            } catch (e) { console.error('Audio decode error:', e); }
            break;
          }
          case 'reply.done':
            if(ttsStart > 0) {
              const totalLatency = performance.now() - sttStart;
              const ttsOnly = totalLatency - (ttsStart - llmStart);
              updateLatencyMetric('tts-lat', ttsOnly.toFixed(0));
              ttsStart = 0;
            }
            setStatus('listening');
            if (msg.status === 'interrupted') playback?.port.postMessage('stop');
            break;
          case 'transcript.user.delta': partial('you', msg.text); break;
          case 'transcript.agent.delta': 
            if (msg.reply_id && msg.reply_id === printedReply) break; 
            if (msg.reply_id !== liveReply) { liveReply = msg.reply_id; dropPartial('agent'); } 
            partial('agent', appendDelta(partialText.agent || '', msg.delta)); 
            break;
          case 'transcript.user': 
            // SAFETY GATE LOGIC
            const text = msg.text.toLowerCase();
            let blocked = false;
            let overridePrompt = '';
            const spotMatch = text.match(/c(\d+)/i);
            if(spotMatch) {
              const requestedSpot = `C${spotMatch[1]}`;
              const isValidSpot = backend.inventory.some(s => s.id === requestedSpot && s.available);
              if(!isValidSpot) {
                blocked = true;
                const availableSpots = backend.inventory.filter(s => s.available).map(s => s.id).join(', ');
                overridePrompt = `User requested invalid spot "${requestedSpot}". DO NOT call reserve_spot. Instead, say: "Sorry, ${requestedSpot} isn't available. I have ${availableSpots} open. Which would you prefer?"`;
                window.addSystemLog(`[SAFETY GATE] Blocked invalid spot: ${requestedSpot}`);
              }
            }
            const durationMatch = text.match(/(\d+)\s*(hour|hr)/i);
            if(durationMatch && parseInt(durationMatch[1]) > 24) {
              blocked = true;
              overridePrompt = `User requested ${durationMatch[1]} hours. Max allowed is 24h. Ask them to provide a valid duration.`;
              window.addSystemLog(`[SAFETY GATE] Blocked excessive duration: ${durationMatch[1]}h`);
            }
            if(blocked) {
              ws.send(JSON.stringify({ type: 'session.update', session: { agent_prompt_override: overridePrompt } }));
            } else {
              addLine('you', msg.text);
            }
            break;
          case 'transcript.agent': 
            printedReply = msg.reply_id ?? printedReply; 
            addLine('agent', msg.text); 
            break;
          case 'tool.call': 
            addLine('tool', `${msg.name}(${JSON.stringify(msg.arguments ?? {})})`);
            window.addSystemLog(`[TOOL CALL] ${msg.name} | Args: ${JSON.stringify(msg.arguments ?? {})}`);
            
            // ATOMIC UI UPDATES
            setTimeout(() => {
              const args = msg.arguments || {};
              let result;
              if(msg.name === 'check_parking_availability') {
                result = backend.checkAvailability(args.vehicle_type);
                window.updateReceipt({ vehicle: 'TN04DA5062', type: args.vehicle_type, time: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) });
              } else if(msg.name === 'reserve_spot') {
                result = backend.reserveSpot(args.spot_id, args.duration_hours, args.vehicle_type);
                if(result.success) {
                  window.updateReceipt({ spot: args.spot_id });
                  window.showLiveLayout(args.spot_id);
                  setTimeout(() => {
                    const pay = backend.generatePaymentLink(result.reservationId, result.totalAmount);
                    window.showWhatsAppMessage(pay.link, pay.amount);
                  }, 1500);
                }
              } else if(msg.name === 'get_navigation') {
                result = backend.getNavigation(args.spot_id);
                if(result && result.mapsLink) window.showNavigationButton(result.mapsLink, result.destination);
              }
              if(result) window.addSystemLog(`[RESULT] ${msg.name} | Success: ${result.success}`);
            }, 100);
            break;
          case 'session.ended': ws.close(); break;
          case 'session.error': setStatus('error', msg.message); break;
        }
      }
      ws.onclose = () => { setStatus('idle'); reset() }; 
      ws.onerror = () => { setStatus('error', 'Connection failed'); reset() }
    } catch (error) { setStatus('error', error.message); reset() }
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

// ==============================================================================
// 4. UI HTML SHELL
// ==============================================================================
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Parkbase MVP</title>
<style>
  :root { --primary: #2563eb; --bg: #f8fafc; --surface: #ffffff; --text: #1e293b; --border: #e2e8f0; }
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, -apple-system, sans-serif; }
  body { background: var(--bg); color: var(--text); height: 100vh; display: flex; align-items: center; justify-content: center; gap: 4rem; padding: 2rem; }
  
  .controls-panel { width: 400px; background: var(--surface); border-radius: 16px; box-shadow: 0 10px 30px -10px rgba(0,0,0,0.1); border: 1px solid var(--border); overflow: hidden; display:flex; flex-direction:column; max-height:85vh; }
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
  
  .system-logs-container { margin-top:auto; border-top:1px solid var(--border); padding-top:1rem; }
  .system-logs-container h3 { font-size: 0.75rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
  #system-logs { max-height:150px; overflow-y:auto; }
  
  .phone-wrapper { position: relative; }
  .phone-frame { width: 320px; height: 650px; background: #1e293b; border-radius: 40px; padding: 12px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); border: 4px solid #0f172a; position: relative; }
  .phone-notch { position: absolute; top: 0; left: 50%; transform: translateX(-50%); width: 120px; height: 24px; background: #0f172a; border-bottom-left-radius: 16px; border-bottom-right-radius: 16px; z-index: 10; }
  .phone-screen { width: 100%; height: 100%; background: white; border-radius: 32px; overflow: hidden; display: flex; flex-direction: column; position: relative; }
  .app-header { padding: 2rem 1.5rem 1rem; text-align: center; border-bottom: 1px solid #f1f5f9; }
  .app-header h1 { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.025em; }
  .app-header span { font-size: 0.625rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; }
  
  #chat-area { flex: 1; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; background: #f8fafc; }
  .line { display: flex; flex-direction: column; gap: 0.25rem; animation: slideUp 0.3s ease-out; }
  @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  .who { font-size: 0.625rem; font-weight: 700; opacity: 0.7; text-transform: uppercase; }
  .line.agent .who { color: var(--primary); }
  .line.you .who { color: #64748b; text-align: right; }
  .said { font-size: 0.875rem; line-height: 1.4; padding: 0.75rem 1rem; border-radius: 16px; max-width: 85%; }
  .line.agent .said { background: white; border: 1px solid var(--border); align-self: flex-start; border-bottom-left-radius: 4px; color: #334155; }
  .line.you .said { background: var(--primary); color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
  .line.tool .said { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; font-family: monospace; font-size: 0.75rem; align-self: center; max-width: 95%; border-radius: 8px; }
  .msg.whatsapp { background:transparent; border:none; align-self:center; max-width:95%; padding:0; }
  
  .status-bar { padding: 1rem; text-align: center; border-top: 1px solid var(--border); background: white; }
  .status-indicator { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; font-weight: 600; color: #64748b; margin-bottom: 0.75rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1; }
  .status.listening .dot { background: #ef4444; animation: pulse 1s infinite; }
  .status.speaking .dot { background: var(--primary); animation: pulse 1s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  #mic { width: 100%; padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; font-size: 0.875rem; margin-bottom: 0.75rem; background: white; }
  #btn { width: 100%; padding: 1rem; background: var(--primary); color: white; border: none; border-radius: 12px; font-weight: 700; font-size: 1rem; cursor: pointer; transition: all 0.2s; }
  #btn:hover:not(:disabled) { background: #1d4ed8; transform: translateY(-1px); }
  #btn:disabled { opacity: 0.5; cursor: not-allowed; }
  
  .metrics { display: flex; justify-content: space-between; padding: 0.5rem 1rem; background: #f1f5f9; font-size: 0.75rem; font-family: monospace; color: #64748b; }

  /* DYNAMIC CARDS CSS */
  .receipt-card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 1rem; margin: 0 1rem; font-family: monospace; font-size: 0.8rem; animation: slideUp 0.3s ease-out; }
  .live-layout { margin: 0 1rem 1rem 1rem; background: #f8fafc; border-radius: 12px; padding: 1rem; animation: slideUp 0.3s ease-out; }
  .spot { aspect-ratio: 1; background: white; border: 1px solid #e2e8f0; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; color: #64748b; transition: all 0.3s ease; }
  .spot.available { background: #f0fdf4; border-color: #86efac; color: #166534; }
  .spot.occupied { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
  .spot.assigned { background: #2563eb; border-color: #1d4ed8; color: white; font-weight: bold; animation: pulse-spot 2s infinite; }
  @keyframes pulse-spot { 0%, 100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.4); } 50% { box-shadow: 0 0 0 6px rgba(37, 99, 235, 0); } }
</style>
</head>
<body>
  <div class="controls-panel">
    <div class="panel-header">
      <p>Demo Walkthrough</p>
      <h2>Parkbase Controls</h2>
    </div>
    <div class="panel-body">
            <div class="control-group">
        <h3>Entry Scenarios</h3>
        <button class="btn-primary" onclick="resetSystem()">▶ New Ticket (Reset)</button>
        <button class="btn-outline" id="btn-lot-full" onclick="toggleLotFull()">⚠️ Simulate Lot Full</button>
      </div>
      <div class="control-group">
        <h3>Vehicle Type</h3>
        <div class="vehicle-grid">
          <button class="vehicle-btn active" onclick="setVehicleType('4W', this)">4W</button>
          <button class="vehicle-btn" onclick="setVehicleType('2W', this)">2W</button>
          <button class="vehicle-btn" onclick="setVehicleType('EV', this)">EV</button>
        </div>
      </div>
      <div class="control-group">
        <h3>Exit Scenarios</h3>
        <button class="btn-outline" onclick="simulateExit('overstay')">🅿️ Exit — Overstay (+₹120)</button>
        <button class="btn-outline" onclick="simulateExit('postpaid')">💳 Exit — Postpaid</button>
        <button class="btn-outline" onclick="simulateExit('ontime')">✅ Exit — On Time</button>
      </div>
      <div class="system-logs-container">
        <h3>Live System Logs</h3>
        <div id="system-logs"></div>
      </div>
    </div>
  </div>

  <div class="phone-wrapper">
    <div class="phone-frame">
      <div class="phone-notch"></div>
      <div class="phone-screen">
        <div class="app-header">
          <h1>PARKBASE</h1>
          <span>Voice Parking Assistant</span>
        </div>
        
        <div id="latency-dashboard" style="position:absolute; top:12px; right:12px; background:rgba(15, 23, 42, 0.9); color:#4ade80; padding:6px 10px; border-radius:6px; font-family:monospace; font-size:10px; z-index:100; display:flex; gap:8px;">
          <span>STT: <b id="stt-lat">--</b>ms</span>
          <span>LLM: <b id="llm-lat">--</b>ms</span>
          <span>TTS: <b id="tts-lat">--</b>ms</span>
        </div>

        <div id="chat-area">
          <div style="text-align:center; color:#94a3b8; margin-top:2rem; font-size:0.875rem;">Tap "Start Call" to begin<br>your parking journey</div>
        </div>

        <div id="receipt-card" class="receipt-card" style="display: none;">
          <div style="text-align: center; font-weight: 700; margin-bottom: 0.75rem; color: #64748b; letter-spacing: 0.1em;">PARKING RECEIPT</div>
          <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px dashed #cbd5e1;"><span style="color: #64748b; text-transform: uppercase; font-size: 0.7rem;">Vehicle No.</span><span style="color: #1e293b; font-weight: 600;" id="receipt-vehicle">TN04DA5062</span></div>
          <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px dashed #cbd5e1;"><span style="color: #64748b; text-transform: uppercase; font-size: 0.7rem;">Type</span><span style="color: #1e293b; font-weight: 600;" id="receipt-type">Four-wheeler</span></div>
          <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px dashed #cbd5e1;"><span style="color: #64748b; text-transform: uppercase; font-size: 0.7rem;">Entered</span><span style="color: #1e293b; font-weight: 600;" id="receipt-time">--</span></div>
          <div style="display: flex; justify-content: space-between; padding: 0.5rem 0;"><span style="color: #64748b; text-transform: uppercase; font-size: 0.7rem;">Spot</span><span style="color: #1e293b; font-weight: 600;" id="receipt-spot">--</span></div>
        </div>

        <div id="live-layout" class="live-layout" style="display: none;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
            <span style="font-weight: 700; color: #1e293b; font-size: 0.8rem;">First Floor · Zone C</span>
            <span style="font-size: 0.7rem; color: #64748b;">24 spots</span>
          </div>
          <div id="spots-grid" style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px;"></div>
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

// ==============================================================================
// 5. SERVER LOGIC
// ==============================================================================
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