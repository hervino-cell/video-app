// mediasoup-client is bundled by esbuild (npm run build) and served at /mediasoup-client.js
// esbuild uses --global-name=mediasoupClient, so the bundle already declares
// window.mediasoupClient itself — do NOT redeclare it with const/let/var here
// or the browser will throw "Identifier already declared".
if (!window.mediasoupClient) {
    document.getElementById('status').textContent =
        '❌ mediasoup-client bundle not found. Run "npm run build" and restart the server.';
    throw new Error('window.mediasoupClient is undefined');
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
const socket = io({
    transports:  ['websocket', 'polling'],
    secure:      window.location.protocol === 'https:',
    reconnection: true
});

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
    roomId:           null,
    device:           null,
    sendTransport:    null,
    recvTransport:    null,
    localStream:      null,
    producers:        { audio: null, video: null },
    consumers:        new Map(),   // key: `${userId}-${kind}`  value: { consumer, kind, userId }
    peers:            new Map(),
    // Producers that arrived before recvTransport was ready – drained after setup
    pendingProducers: []
};

// ── DOM REFS (populated after DOMContentLoaded) ───────────────────────────────
const el = {};

// ── JOIN ──────────────────────────────────────────────────────────────────────
async function joinRoom() {
    const roomId = el.roomInput?.value.trim() || 'room1';
    state.roomId = roomId;

    el.joinBtn.disabled   = true;
    el.leaveBtn.disabled  = false;
    el.roomInput.disabled = true;
    setStatus('⏳ Connexion en cours…', 'info');

    try {
        // 1. Get local camera/mic first so the user sees themselves immediately
        state.localStream = await getLocalStream();

        // 2. Register all socket listeners BEFORE emitting join-room
        //    (router-capabilities can arrive very quickly)
        setupSocketListeners();

        // 3. Ask the server to join
        socket.emit('join-room', roomId, { name: 'User' }, (res) => {
            if (res?.error) {
                setStatus(`❌ ${res.error}`, 'error');
                resetUI();
            }
        });
    } catch (err) {
        console.error('joinRoom error:', err);
        setStatus(`❌ ${err.message}`, 'error');
        resetUI();
    }
}

// ── DEVICE ────────────────────────────────────────────────────────────────────
async function loadDevice(routerRtpCapabilities) {
    state.device = new window.mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
    console.log('✅ Device loaded');
}

// ── SEND TRANSPORT ────────────────────────────────────────────────────────────
async function createSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-send-transport', (params) => {
            if (params.error) return reject(new Error(params.error));

            const transport = state.device.createSendTransport({
                id:             params.id,
                iceParameters:  params.iceParameters,
                iceCandidates:  params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers:     params.iceServers   // TURN credentials from server
            });

            transport.on('connect', ({ dtlsParameters }, cb, errback) => {
                socket.emit('transport-connect',
                    { transportId: transport.id, dtlsParameters },
                    (res) => res?.error ? errback(new Error(res.error)) : cb()
                );
            });

            transport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('produce', { kind, rtpParameters, appData },
                    (res) => res?.error ? errback(new Error(res.error)) : cb({ id: res.id })
                );
            });

            state.sendTransport = transport;
            resolve(transport);
        });
    });
}

// ── RECV TRANSPORT ────────────────────────────────────────────────────────────
async function createRecvTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-recv-transport', (params) => {
            if (params.error) return reject(new Error(params.error));

            const transport = state.device.createRecvTransport({
                id:             params.id,
                iceParameters:  params.iceParameters,
                iceCandidates:  params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers:     params.iceServers
            });

            transport.on('connect', ({ dtlsParameters }, cb, errback) => {
                socket.emit('transport-connect',
                    { transportId: transport.id, dtlsParameters },
                    (res) => res?.error ? errback(new Error(res.error)) : cb()
                );
            });

            state.recvTransport = transport;
            resolve(transport);
        });
    });
}

// ── CONSUME A REMOTE PRODUCER ─────────────────────────────────────────────────
async function consumeProducer(producerId) {
    // If transports aren't ready yet, queue for later (drained in router-capabilities handler)
    if (!state.device || !state.recvTransport) {
        console.log(`⏳ Queuing producer ${producerId} (transports not ready yet)`);
        if (!state.pendingProducers.includes(producerId)) {
            state.pendingProducers.push(producerId);
        }
        return;
    }

    return new Promise((resolve) => {
        socket.emit('consume', {
            producerId,
            rtpCapabilities: state.device.rtpCapabilities
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
                    rtpParameters: params.rtpParameters
                });
                attachRemoteTrack(params.producerUserId, consumer, params.kind);
                updateParticipantCount();
            } catch (err) {
                console.error('recvTransport.consume error:', err);
            }
            resolve();
        });
    });
}

// ── ATTACH REMOTE TRACK TO A VIDEO ELEMENT ────────────────────────────────────
function attachRemoteTrack(userId, consumer, kind) {
    const wrapperId = `video-${userId}-${kind}`;

    // If a wrapper already exists, just swap the stream
    let wrapper = document.getElementById(wrapperId);
    if (wrapper) {
        const video = wrapper.querySelector('video');
        if (video) {
            video.srcObject = new MediaStream([consumer.track]);
            playVideo(video);
        }
        state.consumers.set(`${userId}-${kind}`, { consumer, kind, userId });
        return;
    }

    const result = createVideoElement(userId, kind, false);
    wrapper = result.wrapper;
    const { video, placeholder } = result;

    video.srcObject = new MediaStream([consumer.track]);
    video.onloadedmetadata = () => {
        playVideo(video);
        if (placeholder) placeholder.style.display = 'none';
    };

    el.videosContainer.appendChild(wrapper);
    state.consumers.set(`${userId}-${kind}`, { consumer, kind, userId });
    updateVideoLayout();
}

// Autoplay helper: browsers need the video muted to allow autoplay.
// We start muted, play, then unmute so audio comes through.
function playVideo(video) {
    video.muted = true;
    const playPromise = video.play();
    if (playPromise !== undefined) {
        playPromise
            .then(() => {
                // Unmute after playback starts so we hear the remote audio
                video.muted = false;
            })
            .catch((err) => {
                console.warn('video.play() blocked, waiting for user gesture:', err.message);
                // Add a click-to-play overlay as fallback
                const overlay = video.closest('.video-wrapper')?.querySelector('.video-overlay');
                if (overlay) {
                    const btn = document.createElement('button');
                    btn.textContent = '▶ Cliquez pour voir';
                    btn.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 16px;background:#4ade80;border:none;border-radius:6px;cursor:pointer;font-weight:bold;color:#000;z-index:10';
                    video.closest('.video-wrapper').appendChild(btn);
                    btn.onclick = () => {
                        video.muted = false;
                        video.play().then(() => btn.remove()).catch(() => {});
                    };
                }
            });
    }
}

// ── SOCKET LISTENERS ──────────────────────────────────────────────────────────
function setupSocketListeners() {
    // Remove stale listeners to avoid duplicates on re-join
    socket.off('router-capabilities');
    socket.off('existing-producers');
    socket.off('new-producer');
    socket.off('user-disconnected');

    // Step 1 – server sends router caps after we join
    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        try {
            await loadDevice(routerRtpCapabilities);
            await createSendTransport();
            await createRecvTransport();
            await startProducing();

            // Now drain any producers that arrived before we were ready
            const pending = [...state.pendingProducers];
            state.pendingProducers = [];
            console.log(`🔄 Draining ${pending.length} pending producer(s)`);
            for (const producerId of pending) {
                await consumeProducer(producerId);
            }

            el.toggleAudio.disabled = false;
            el.toggleVideo.disabled = false;
            setStatus(`✅ Connecté à "${state.roomId}"`, 'success');
        } catch (err) {
            console.error('Setup error:', err);
            setStatus(`❌ ${err.message}`, 'error');
        }
    });

    // Step 2 – server sends producers that were already in the room
    socket.on('existing-producers', async (producers) => {
        console.log(`📦 ${producers.length} existing producer(s)`);
        for (const { producerId } of producers) {
            await consumeProducer(producerId);
        }
    });

    // A new peer started producing while we're already in the room
    socket.on('new-producer', async ({ producerId, userId }) => {
        if (userId === socket.id) return; // ignore our own producers echoed back
        console.log(`🆕 New producer from ${userId} (${producerId})`);
        await consumeProducer(producerId);
    });

    // A peer left or disconnected
    socket.on('user-disconnected', (userId) => {
        console.log(`👋 ${userId} left`);
        removeVideosForUser(userId);
        state.peers.delete(userId);
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

// ── PRODUCE LOCAL TRACKS ──────────────────────────────────────────────────────
async function startProducing() {
    if (!state.localStream) return;

    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
        state.producers.audio = await state.sendTransport.produce({
            track:        audioTrack,
            codecOptions: { opusStereo: true, opusDtx: true }
        });
        console.log('🎤 Audio producer ready');
    }

    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
        state.producers.video = await state.sendTransport.produce({
            track: videoTrack,
            encodings: [
                { maxBitrate: 100_000 },
                { maxBitrate: 300_000 },
                { maxBitrate: 900_000 }
            ],
            codecOptions: { videoGoogleStartBitrate: 1000 }
        });
        console.log('📹 Video producer ready');
    }
}

// ── LOCAL STREAM ──────────────────────────────────────────────────────────────
async function getLocalStream() {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    // Clear old video tiles and show local preview
    el.videosContainer.innerHTML = '';
    const { wrapper, video, placeholder } = createVideoElement('local', 'video', true);
    video.srcObject = stream;
    video.onloadedmetadata = () => {
        video.play().catch(() => {});
        if (placeholder) placeholder.style.display = 'none';
    };
    el.videosContainer.appendChild(wrapper);
    updateVideoLayout();
    return stream;
}

// ── UI HELPERS ────────────────────────────────────────────────────────────────
function createVideoElement(userId, kind, isLocal = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `video-wrapper ${isLocal ? 'local' : 'remote'}`;
    wrapper.id        = `video-${userId}-${kind}`;

    const video    = document.createElement('video');
    video.autoplay   = true;
    video.playsInline = true;
    video.muted      = isLocal; // mute self to avoid feedback

    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.innerHTML = isLocal ? '👤' : '👥';

    const overlay  = document.createElement('div');
    overlay.className = 'video-overlay';
    overlay.innerHTML = `<div class="user-label">${isLocal ? 'Moi' : `User ${userId.slice(-4)}`}</div>`;

    wrapper.appendChild(video);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(overlay);
    return { wrapper, video, placeholder, overlay };
}

function updateVideoLayout() {
    const count = el.videosContainer.querySelectorAll('.video-wrapper').length;
    const cols  = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    el.videosContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(200px, 1fr))`;
}

function updateParticipantCount() {
    const userIds = new Set([...state.consumers.values()].map(c => c.userId));
    const count   = userIds.size + 1; // +1 for ourselves
    el.roomInfo.textContent = `👥 ${count} participant${count > 1 ? 's' : ''}`;
}

function setStatus(msg, type = 'info') {
    el.status.textContent = msg;
    el.status.className   = `status ${type}`;
}

function removeVideosForUser(userId) {
    ['audio', 'video'].forEach(k =>
        document.getElementById(`video-${userId}-${k}`)?.remove()
    );
}

function resetUI() {
    el.joinBtn.disabled   = false;
    el.leaveBtn.disabled  = true;
    el.roomInput.disabled = false;
}

// ── LEAVE ROOM ────────────────────────────────────────────────────────────────
function leaveRoom() {
    state.localStream?.getTracks().forEach(t => t.stop());

    state.producers.audio?.close();
    state.producers.video?.close();
    for (const { consumer } of state.consumers.values()) consumer?.close();

    state.sendTransport?.close();
    state.recvTransport?.close();

    // Reset state
    state.producers       = { audio: null, video: null };
    state.consumers.clear();
    state.peers.clear();
    state.pendingProducers = [];
    state.sendTransport   = null;
    state.recvTransport = null;
    state.device        = null;
    state.roomId        = null;
    state.localStream   = null;

    el.videosContainer.innerHTML    = '';
    el.toggleAudio.disabled         = true;
    el.toggleAudio.textContent      = '🔊 Audio ON';
    el.toggleAudio.classList.remove('muted');
    el.toggleVideo.disabled         = true;
    el.toggleVideo.textContent      = '📹 Vidéo ON';
    el.toggleVideo.classList.remove('muted');
    el.roomInfo.textContent         = '';

    resetUI();
    setStatus('🔴 Déconnecté', 'info');
}

// ── INIT ──────────────────────────────────────────────────────────────────────
function init() {
    el.joinBtn          = document.getElementById('joinBtn');
    el.leaveBtn         = document.getElementById('leaveBtn');
    el.roomInput        = document.getElementById('roomInput');
    el.toggleAudio      = document.getElementById('toggleAudio');
    el.toggleVideo      = document.getElementById('toggleVideo');
    el.videosContainer  = document.getElementById('videosContainer');
    el.status           = document.getElementById('status');
    el.roomInfo         = document.getElementById('roomInfo');

    // Join / Leave
    el.joinBtn.addEventListener('click',  joinRoom);
    el.leaveBtn.addEventListener('click', () => {
        socket.emit('leave-room');
        leaveRoom();
    });

    // Audio toggle
    el.toggleAudio.addEventListener('click', () => {
        const t = state.localStream?.getAudioTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        el.toggleAudio.textContent = `🔊 Audio ${t.enabled ? 'ON' : 'OFF'}`;
        el.toggleAudio.classList.toggle('muted', !t.enabled);
    });

    // Video toggle
    el.toggleVideo.addEventListener('click', () => {
        const t = state.localStream?.getVideoTracks()[0];
        if (!t) return;
        t.enabled = !t.enabled;
        el.toggleVideo.textContent = `📹 Vidéo ${t.enabled ? 'ON' : 'OFF'}`;
        el.toggleVideo.classList.toggle('muted', !t.enabled);
    });

    // Socket connection status
    socket.on('connect',    () => setStatus('🔌 Connecté au serveur — cliquez "Rejoindre"', 'success'));
    socket.on('disconnect', () => {
        if (state.roomId) leaveRoom();
        setStatus('🔴 Déconnecté du serveur', 'error');
    });

    setStatus('🔌 Connexion au serveur…', 'info');
}

document.addEventListener('DOMContentLoaded', init);