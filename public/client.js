const mediasoupClient = window.mediasoupClient;

const socket = io({
    transports: ['websocket', 'polling'],
    secure: window.location.protocol === 'https:',
    reconnection: true
});

const state = {
    roomId: null, device: null, sendTransport: null, recvTransport: null,
    localStream: null, producers: { audio: null, video: null },
    consumers: new Map(), peers: new Map()
};

const elements = {};
function getElements() {
    return {
        joinBtn:         document.getElementById('joinBtn'),
        leaveBtn:        document.getElementById('leaveBtn'),
        roomInput:       document.getElementById('roomInput'),
        toggleAudio:     document.getElementById('toggleAudio'),
        toggleVideo:     document.getElementById('toggleVideo'),
        videosContainer: document.getElementById('videosContainer'),
        status:          document.getElementById('status'),
        roomInfo:        document.getElementById('roomInfo')
    };
}

// ─── JOIN ────────────────────────────────────────────────────────────────────
async function joinRoom() {
    const roomId = elements.roomInput?.value.trim() || 'room1';
    state.roomId = roomId;

    if (elements.joinBtn)   elements.joinBtn.disabled   = true;
    if (elements.leaveBtn)  elements.leaveBtn.disabled  = false;
    if (elements.roomInput) elements.roomInput.disabled = true;
    setStatus('⏳ Connexion en cours…', 'info');

    try {
        state.localStream = await getLocalStream();
        setupSocketListeners();
        socket.emit('join-room', roomId, { name: 'User' }, (res) => {
            if (res?.error) { setStatus(`❌ ${res.error}`, 'error'); resetUI(); }
        });
    } catch (err) {
        console.error('joinRoom error:', err);
        setStatus(`❌ ${err.message}`, 'error');
        resetUI();
    }
}

// ─── DEVICE ──────────────────────────────────────────────────────────────────
async function loadDevice(routerRtpCapabilities) {
    state.device = new mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
}

// ─── TRANSPORTS ──────────────────────────────────────────────────────────────
async function createSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-send-transport', (params) => {
            if (params.error) return reject(new Error(params.error));

            // iceServers comes from server (contains TURN credentials)
            state.sendTransport = state.device.createSendTransport({
                id:             params.id,
                iceParameters:  params.iceParameters,
                iceCandidates:  params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers:     params.iceServers   // TURN from server
            });

            state.sendTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                socket.emit('transport-connect', {
                    transportId: state.sendTransport.id, dtlsParameters
                }, (res) => res?.error ? errback(new Error(res.error)) : cb());
            });

            state.sendTransport.on('produce', ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('produce', { kind, rtpParameters, appData },
                    (res) => res?.error ? errback(new Error(res.error)) : cb({ id: res.id }));
            });

            resolve(state.sendTransport);
        });
    });
}

async function createRecvTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-recv-transport', (params) => {
            if (params.error) return reject(new Error(params.error));

            state.recvTransport = state.device.createRecvTransport({
                id:             params.id,
                iceParameters:  params.iceParameters,
                iceCandidates:  params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers:     params.iceServers   // TURN from server
            });

            state.recvTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                socket.emit('transport-connect', {
                    transportId: state.recvTransport.id, dtlsParameters
                }, (res) => res?.error ? errback(new Error(res.error)) : cb());
            });

            resolve(state.recvTransport);
        });
    });
}

// ─── CONSUME ─────────────────────────────────────────────────────────────────
async function consumeProducer(producerId) {
    if (!state.device || !state.recvTransport) return;

    return new Promise((resolve) => {
        socket.emit('consume', {
            producerId,
            rtpCapabilities: state.device.rtpCapabilities
        }, async (params) => {
            if (params.error) { console.warn('consume error:', params.error); return resolve(); }
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

// ─── ATTACH REMOTE TRACK ─────────────────────────────────────────────────────
function attachRemoteTrack(userId, consumer, kind) {
    const wrapperId = `video-${userId}-${kind}`;
    if (document.getElementById(wrapperId)) return;

    const { wrapper, video, placeholder } = createVideoElement(userId, kind, false);
    video.srcObject = new MediaStream([consumer.track]);
    video.onloadedmetadata = () => {
        video.play().catch(() => {});
        if (placeholder) placeholder.style.display = 'none';
    };

    if (elements.videosContainer) elements.videosContainer.appendChild(wrapper);
    state.consumers.set(`${userId}-${kind}`, { consumer, kind, userId });
    updateVideoLayout();
}

// ─── SOCKET LISTENERS ────────────────────────────────────────────────────────
function setupSocketListeners() {
    socket.off('router-capabilities');
    socket.off('existing-producers');
    socket.off('new-producer');
    socket.off('user-disconnected');

    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        try {
            await loadDevice(routerRtpCapabilities);
            await createSendTransport();
            await createRecvTransport();
            await startProducing();

            if (elements.toggleAudio) elements.toggleAudio.disabled = false;
            if (elements.toggleVideo) elements.toggleVideo.disabled = false;
            setStatus(`✅ Connecté à "${state.roomId}"`, 'success');
        } catch (err) {
            console.error('Setup error:', err);
            setStatus(`❌ ${err.message}`, 'error');
        }
    });

    // Consume producers that already exist in the room
    socket.on('existing-producers', async (producers) => {
        for (const { producerId } of producers) {
            await consumeProducer(producerId);
        }
    });

    // New producer added while we're in the room
    socket.on('new-producer', async ({ producerId, userId }) => {
        if (userId === socket.id) return;
        await consumeProducer(producerId);
    });

    socket.on('user-disconnected', (userId) => {
        removeVideo(userId);
        state.peers.delete(userId);
        for (const key of [...state.consumers.keys()]) {
            if (key.startsWith(userId)) state.consumers.delete(key);
        }
        updateParticipantCount();
        updateVideoLayout();
    });
}

// ─── PRODUCE LOCAL MEDIA ─────────────────────────────────────────────────────
async function startProducing() {
    if (!state.localStream) return;

    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
        state.producers.audio = await state.sendTransport.produce({
            track: audioTrack,
            codecOptions: { opusStereo: true, opusDtx: true }
        });
    }

    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
        state.producers.video = await state.sendTransport.produce({
            track: videoTrack,
            encodings: [
                { maxBitrate: 100000 },
                { maxBitrate: 300000 },
                { maxBitrate: 900000 }
            ],
            codecOptions: { videoGoogleStartBitrate: 1000 }
        });
    }
}

// ─── LOCAL STREAM ─────────────────────────────────────────────────────────────
async function getLocalStream() {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });

    const { wrapper, video, placeholder } = createVideoElement('local', 'video', true);
    video.srcObject = stream;
    video.onloadedmetadata = () => {
        video.play().catch(() => {});
        if (placeholder) placeholder.style.display = 'none';
    };

    if (elements.videosContainer) {
        elements.videosContainer.innerHTML = '';
        elements.videosContainer.appendChild(wrapper);
    }
    updateVideoLayout();
    return stream;
}

// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function createVideoElement(userId, kind, isLocal = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `video-wrapper ${isLocal ? 'local' : 'remote'}`;
    wrapper.id = `video-${userId}-${kind}`;

    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = isLocal;

    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';
    overlay.innerHTML = `<div class="user-label">${isLocal ? 'Moi' : `User ${userId.slice(-4)}`}</div>`;

    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.innerHTML = isLocal ? '👤' : '👥';

    wrapper.appendChild(video);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(overlay);
    return { wrapper, video, placeholder, overlay };
}

function updateVideoLayout() {
    if (!elements.videosContainer) return;
    const count = elements.videosContainer.querySelectorAll('.video-wrapper').length;
    const cols = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    elements.videosContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(200px, 1fr))`;
}

function updateParticipantCount() {
    const userIds = new Set([...state.consumers.values()].map(c => c.userId));
    const count = userIds.size + 1;
    if (elements.roomInfo)
        elements.roomInfo.textContent = `👥 ${count} participant${count > 1 ? 's' : ''}`;
}

function setStatus(msg, type = 'info') {
    if (elements.status) {
        elements.status.textContent = msg;
        elements.status.className = `status ${type}`;
    }
}

function removeVideo(userId) {
    ['audio', 'video'].forEach(k => document.getElementById(`video-${userId}-${k}`)?.remove());
}

function resetUI() {
    if (elements.joinBtn)   elements.joinBtn.disabled   = false;
    if (elements.leaveBtn)  elements.leaveBtn.disabled  = true;
    if (elements.roomInput) elements.roomInput.disabled = false;
}

function leaveRoom() {
    state.localStream?.getTracks().forEach(t => t.stop());
    state.producers.audio?.close();
    state.producers.video?.close();
    for (const c of state.consumers.values()) c.consumer.close();
    state.sendTransport?.close();
    state.recvTransport?.close();

    state.producers = { audio: null, video: null };
    state.consumers.clear(); state.peers.clear();
    state.sendTransport = null; state.recvTransport = null;
    state.device = null; state.roomId = null;

    if (elements.videosContainer) elements.videosContainer.innerHTML = '';
    resetUI();
    if (elements.toggleAudio) { elements.toggleAudio.disabled = true; elements.toggleAudio.textContent = '🔊 Audio ON'; }
    if (elements.toggleVideo) { elements.toggleVideo.disabled = true; elements.toggleVideo.textContent = '📹 Vidéo ON'; }
    setStatus('🔴 Déconnecté', 'info');
}

// ─── INIT ────────────────────────────────────────────────────────────────────
function init() {
    Object.assign(elements, getElements());

    elements.joinBtn?.addEventListener('click', joinRoom);
    elements.leaveBtn?.addEventListener('click', () => { socket.emit('leave-room'); leaveRoom(); });

    elements.toggleAudio?.addEventListener('click', () => {
        const t = state.localStream?.getAudioTracks()[0];
        if (t) {
            t.enabled = !t.enabled;
            elements.toggleAudio.textContent = `🔊 Audio ${t.enabled ? 'ON' : 'OFF'}`;
            elements.toggleAudio.classList.toggle('muted', !t.enabled);
        }
    });

    elements.toggleVideo?.addEventListener('click', () => {
        const t = state.localStream?.getVideoTracks()[0];
        if (t) {
            t.enabled = !t.enabled;
            elements.toggleVideo.textContent = `📹 Vidéo ${t.enabled ? 'ON' : 'OFF'}`;
            elements.toggleVideo.classList.toggle('muted', !t.enabled);
        }
    });

    socket.on('connect',    () => setStatus('🔌 Connecté au serveur — cliquez "Rejoindre"', 'success'));
    socket.on('disconnect', () => { if (state.roomId) leaveRoom(); });

    setStatus('🔌 Connexion au serveur…', 'info');
}

document.addEventListener('DOMContentLoaded', init);