// public/client.js
// mediasoup-client bundled by esbuild → window.mediasoupClient

if (!window.mediasoupClient) {
    document.getElementById('status').textContent =
        '❌ Bundle manquant. Lancez "npm run build" et redémarrez le serveur.';
    throw new Error('window.mediasoupClient is undefined');
}

const socket = io({ transports: ['websocket', 'polling'], reconnection: true });

const state = {
    roomId: null,
    device: null,
    sendTransport: null,
    recvTransport: null,
    localStream: null,
    producers: { audio: null, video: null },
    consumers: new Map(),        // key: `${userId}-${kind}`
    pendingProducers: [],        // queued while transports not ready
};

const el = {};  // DOM refs, populated in init()

// ── JOIN ─────────────────────────────────────────────────────────────
async function joinRoom() {
    const roomId = el.roomInput.value.trim() || 'room1';
    state.roomId = roomId;
    el.joinBtn.disabled = el.roomInput.disabled = true;
    el.leaveBtn.disabled = false;
    setStatus('⏳ Connexion en cours…', 'info');

    try {
        state.localStream = await getLocalStream();
        setupSocketListeners();
        socket.emit('join-room', roomId, { name: 'User' }, (res) => {
            if (res?.error) { setStatus('❌ ' + res.error, 'error'); resetUI(); }
        });
    } catch (err) {
        console.error('joinRoom error:', err);
        setStatus('❌ ' + err.message, 'error');
        resetUI();
    }
}

// ── DEVICE ─────────────────────────────────────────────────────────────
async function loadDevice(routerRtpCapabilities) {
    state.device = new window.mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
    console.log('✅ Device loaded');
}

// ── TRANSPORT OPTIONS ─────────────────────────────────────────────────────────
// iceTransportPolicy:'relay' forces ALL media through the Metered TURN server.
// Without this, the browser tries direct UDP first — which Render's firewall
// blocks — and the connection appears to work (ICE connects over the signalling
// WebSocket) but no RTP media ever flows → black screen + no audio.
function transportOptions(params) {
    return {
        id:                 params.id,
        iceParameters:      params.iceParameters,
        iceCandidates:      params.iceCandidates,
        dtlsParameters:     params.dtlsParameters,
        iceServers:         params.iceServers,       // Metered TURN credentials
        iceTransportPolicy: 'relay',                  // force TURN, skip direct
    };
}

// ─�� SEND TRANSPORT ──────────────────────────────────────────────────────────
async function createSendTransport(params) {
    const t = state.device.createSendTransport(transportOptions(params));

    t.on('connect', ({ dtlsParameters }, cb, errback) =>
        socket.emit('transport-connect', { transportId: t.id, dtlsParameters },
            r => r?.error ? errback(new Error(r.error)) : cb())
    );

    t.on('produce', ({ kind, rtpParameters, appData }, cb, errback) =>
        socket.emit('produce', { kind, rtpParameters, appData },
            r => r?.error ? errback(new Error(r.error)) : cb({ id: r.id }))
    );

    t.on('connectionstatechange', state =>
        console.log('sendTransport connectionstate:', state)
    );

    state.sendTransport = t;
}

// ── RECV TRANSPORT ──────────────────────────────────────────────────────────
async function createRecvTransport(params) {
    const t = state.device.createRecvTransport(transportOptions(params));

    t.on('connect', ({ dtlsParameters }, cb, errback) =>
        socket.emit('transport-connect', { transportId: t.id, dtlsParameters },
            r => r?.error ? errback(new Error(r.error)) : cb())
    );

    t.on('connectionstatechange', state =>
        console.log('recvTransport connectionstate:', state)
    );

    state.recvTransport = t;
}

// ── PRODUCE ────────────────────────────────────────────────────────────
async function startProducing() {
    const audioTrack = state.localStream?.getAudioTracks()[0];
    if (audioTrack) {
        state.producers.audio = await state.sendTransport.produce({
            track: audioTrack,
            codecOptions: { opusStereo: true, opusDtx: true },
        });
        console.log('🎤 Audio producer ready');
    }

    const videoTrack = state.localStream?.getVideoTracks()[0];
    if (videoTrack) {
        state.producers.video = await state.sendTransport.produce({
            track: videoTrack,
            encodings: [
                { maxBitrate: 100000 },
                { maxBitrate: 300000 },
                { maxBitrate: 900000 },
            ],
            codecOptions: { videoGoogleStartBitrate: 1000 },
        });
        console.log('📹 Video producer ready');
    }
}

// ── CONSUME ────────────────────────────────────────────────────────────
async function consumeProducer(producerId) {
    // Queue if transports not ready yet (drained after setup completes)
    if (!state.device || !state.recvTransport) {
        if (!state.pendingProducers.includes(producerId))
            state.pendingProducers.push(producerId);
        return;
    }

    return new Promise(resolve => {
        socket.emit('consume', {
            producerId,
            rtpCapabilities: state.device.rtpCapabilities,
        }, async (params) => {
            if (params.error) {
                console.warn('consume error:', params.error);
                return resolve();
            }
            try {
                const consumer = await state.recvTransport.consume({
                    id:            params.id,
                    producerId:    params.producerId,
                    kind:          params.kind,
                    rtpParameters: params.rtpParameters,
                });

                // Use producerUserId from server response
                const userId = params.producerUserId;
                console.log('Attaching track for user:', userId, 'kind:', params.kind);
                
                attachTrack(userId, consumer, params.kind);

                // Tell server to resume (server created consumer paused)
                socket.emit('consumer-resume', { consumerId: consumer.id });
                // Also resume on client side
                await consumer.resume();

                console.log('▶️ Consumer resumed:', params.kind, 'from', userId);
                updateParticipantCount();
            } catch (err) {
                console.error('recvTransport.consume error:', err);
            }
            resolve();
        });
    });
}

// ── ATTACH TRACK TO DOM ───────────────────────────────────────────────────────
function attachTrack(userId, consumer, kind) {
    const stream = new MediaStream([consumer.track]);
    const consumerKey = `${userId}-${kind}`;  // FIX: Use proper key format

    if (kind === 'audio') {
        // Use a hidden <audio> element — no video tile, just sound
        let audio = document.getElementById(`audio-${userId}`);
        if (!audio) {
            audio = document.createElement('audio');
            audio.id = `audio-${userId}`;
            audio.autoplay = true;
            audio.style.display = 'none';
            document.body.appendChild(audio);
        }
        audio.srcObject = stream;
        audio.play().catch(() => {
            // If autoplay blocked, play on first user click
            document.addEventListener('click', () => audio.play().catch(() => {}), { once: true });
        });
        state.consumers.set(consumerKey, { consumer, kind, userId });
        return;
    }

    // Video: create or reuse a tile
    const wrapperId = `video-${userId}-video`;
    let wrapper = document.getElementById(wrapperId);
    if (!wrapper) {
        wrapper = createVideoTile(userId, false);
        el.videosContainer.appendChild(wrapper);
        updateVideoLayout();
    }

    const video = wrapper.querySelector('video');
    const placeholder = wrapper.querySelector('.video-placeholder');
    video.srcObject = stream;

    // Autoplay trick: mute first (browser allows muted autoplay),
    // then immediately unmute once playing starts
    video.muted = true;
    video.play()
        .then(() => { video.muted = false; })
        .catch(err => {
            console.warn('Video autoplay blocked:', err.message);
            // Show click-to-play button as fallback
            if (!wrapper.querySelector('.play-btn')) {
                const btn = document.createElement('button');
                btn.className = 'play-btn';
                btn.textContent = '▶ Cliquez pour voir';
                btn.style.cssText = [
                    'position:absolute', 'top:50%', 'left:50%',
                    'transform:translate(-50%,-50%)',
                    'padding:8px 16px', 'background:#4ade80',
                    'color:#000', 'border:none', 'border-radius:6px',
                    'cursor:pointer', 'font-weight:bold', 'z-index:10',
                ].join(';');
                btn.onclick = () => {
                    video.muted = false;
                    video.play().then(() => btn.remove()).catch(() => {});
                };
                wrapper.appendChild(btn);
            }
        });

    if (placeholder) placeholder.style.display = 'none';
    state.consumers.set(consumerKey, { consumer, kind, userId });
}

// ── SOCKET LISTENERS ─────────────────────────────────────────────────────────
function setupSocketListeners() {
    socket.off('router-capabilities');
    socket.off('existing-producers');
    socket.off('new-producer');
    socket.off('user-disconnected');

    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        try {
            await loadDevice(routerRtpCapabilities);

            // Request both transports in parallel for speed
            const [sendParams, recvParams] = await Promise.all([
                new Promise((res, rej) =>
                    socket.emit('create-send-transport',
                        p => p.error ? rej(new Error(p.error)) : res(p))),
                new Promise((res, rej) =>
                    socket.emit('create-recv-transport',
                        p => p.error ? rej(new Error(p.error)) : res(p))),
            ]);

            await createSendTransport(sendParams);
            await createRecvTransport(recvParams);
            await startProducing();

            // Drain producers that arrived before we were ready
            const pending = [...state.pendingProducers];
            state.pendingProducers = [];
            console.log('🔄 Draining', pending.length, 'pending producer(s)');
            for (const id of pending) await consumeProducer(id);

            el.toggleAudio.disabled = el.toggleVideo.disabled = false;
            setStatus('✅ Connecté à "' + state.roomId + '"', 'success');
        } catch (err) {
            console.error('Setup error:', err);
            setStatus('❌ ' + err.message, 'error');
        }
    });

    socket.on('existing-producers', async (list) => {
        console.log('📦', list.length, 'existing producer(s)');
        for (const { producerId } of list) await consumeProducer(producerId);
    });

    socket.on('new-producer', async ({ producerId, userId }) => {
        if (userId === socket.id) return;
        console.log('🆕 New producer from', userId);
        await consumeProducer(producerId);
    });

    socket.on('user-disconnected', (userId) => {
        console.log('👋', userId, 'disconnected');
        
        // Remove video element
        const videoElement = document.getElementById(`video-${userId}-video`);
        if (videoElement) videoElement.remove();
        
        // Remove audio element
        const audioElement = document.getElementById(`audio-${userId}`);
        if (audioElement) audioElement.remove();
        
        // Clean up consumers with proper key matching
        for (const key of [...state.consumers.keys()]) {
            if (key.startsWith(`${userId}-`)) {
                state.consumers.get(key)?.consumer?.close();
                state.consumers.delete(key);
            }
        }
        updateParticipantCount();
        updateVideoLayout();
    });
}

// ── LOCAL STREAM ───────────────────────────────────────────────────────────
async function getLocalStream() {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    el.videosContainer.innerHTML = '';
    const wrapper = createVideoTile('local', true);
    const video = wrapper.querySelector('video');
    const placeholder = wrapper.querySelector('.video-placeholder');
    video.srcObject = stream;
    video.muted = true;
    video.play().catch(() => {});
    if (placeholder) placeholder.style.display = 'none';
    el.videosContainer.appendChild(wrapper);
    updateVideoLayout();
    return stream;
}

// ── DOM HELPERS ───────────────────────────────────────────────────────────
function createVideoTile(userId, isLocal) {
    const wrapper = document.createElement('div');
    wrapper.id = `video-${userId}-video`;
    wrapper.className = 'video-wrapper ' + (isLocal ? 'local' : 'remote');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;

    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.textContent = isLocal ? '👤' : '👥';

    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';
    overlay.innerHTML = '<span class="user-label">' +
        (isLocal ? 'Moi' : 'User ' + userId.slice(-4)) + '</span>';

    wrapper.append(video, placeholder, overlay);
    return wrapper;
}

function updateVideoLayout() {
    const n = el.videosContainer.querySelectorAll('.video-wrapper').length;
    el.videosContainer.style.gridTemplateColumns =
        n <= 1 ? '1fr' : n <= 4 ? 'repeat(2,1fr)' : 'repeat(3,1fr)';
}

function updateParticipantCount() {
    const users = new Set([...state.consumers.values()].map(c => c.userId));
    const n = users.size + 1;
    el.roomInfo.textContent = '👥 ' + n + ' participant' + (n > 1 ? 's' : '');
}

function setStatus(msg, type) {
    el.status.textContent = msg;
    el.status.className = 'status ' + (type || 'info');
}

function resetUI() {
    el.joinBtn.disabled = el.roomInput.disabled = false;
    el.leaveBtn.disabled = true;
}

// ── LEAVE ─────────────────────────────────────────────────────────────
function leaveRoom() {
    state.localStream?.getTracks().forEach(t => t.stop());
    state.producers.audio?.close();
    state.producers.video?.close();
    for (const { consumer } of state.consumers.values()) consumer?.close();
    state.sendTransport?.close();
    state.recvTransport?.close();

    state.roomId = state.device = state.sendTransport = state.recvTransport =
        state.localStream = null;
    state.producers = { audio: null, video: null };
    state.consumers.clear();
    state.pendingProducers = [];

    el.videosContainer.innerHTML = '';
    el.toggleAudio.disabled = el.toggleVideo.disabled = true;
    el.toggleAudio.textContent = '🔊 Audio ON';
    el.toggleVideo.textContent = '📹 Vidéo ON';
    el.toggleAudio.classList.remove('muted');
    el.toggleVideo.classList.remove('muted');
    el.roomInfo.textContent = '';
    resetUI();
    setStatus('🔴 Déconnecté', 'info');
}

// ── INIT ─────────────────────────────────────────────────────────────
function init() {
    el.joinBtn         = document.getElementById('joinBtn');
    el.leaveBtn        = document.getElementById('leaveBtn');
    el.roomInput       = document.getElementById('roomInput');
    el.toggleAudio     = document.getElementById('toggleAudio');
    el.toggleVideo     = document.getElementById('toggleVideo');
    el.videosContainer = document.getElementById('videosContainer');
    el.status          = document.getElementById('status');
    el.roomInfo        = document.getElementById('roomInfo');

    el.joinBtn.addEventListener('click', joinRoom);
    el.leaveBtn.addEventListener('click', () => { socket.emit('leave-room'); leaveRoom(); });

    el.toggleAudio.addEventListener('click', () => {
        const t = state.localStream?.getAudioTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        el.toggleAudio.textContent = '🔊 Audio ' + (t.enabled ? 'ON' : 'OFF');
        el.toggleAudio.classList.toggle('muted', !t.enabled);
    });

    el.toggleVideo.addEventListener('click', () => {
        const t = state.localStream?.getVideoTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        el.toggleVideo.textContent = '📹 Vidéo ' + (t.enabled ? 'ON' : 'OFF');
        el.toggleVideo.classList.toggle('muted', !t.enabled);
    });

    socket.on('connect', () => setStatus('🔌 Connecté — cliquez "Rejoindre"', 'success'));
    socket.on('disconnect', () => {
        if (state.roomId) leaveRoom();
        setStatus('🔴 Déconnecté du serveur', 'error');
    });

    setStatus('🔌 Connexion…', 'info');
}

document.addEventListener('DOMContentLoaded', init);