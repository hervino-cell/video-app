// === CRITICAL FIX: Get mediasoup from CDN global ===
const mediasoupClient = window.mediasoupClient;

// === SOCKET with auto-config for Render ===
const socket = io({
    transports: ['websocket', 'polling'],
    secure: window.location.protocol === 'https:',
    reconnection: true
});

// === STATE ===
const state = {
    roomId: null, device: null, sendTransport: null, recvTransport: null,
    localStream: null, producers: { audio: null, video: null },
    consumers: new Map(), peers: new Map(), activeSpeaker: null,
    audioLevels: new Map(), isSpeaking: false
};

// === DOM ELEMENTS (safe access) ===
const elements = {};
function getElements() {
    return {
        joinBtn: document.getElementById('joinBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        roomInput: document.getElementById('roomInput'),
        toggleAudio: document.getElementById('toggleAudio'),
        toggleVideo: document.getElementById('toggleVideo'),
        videosContainer: document.getElementById('videosContainer'),
        status: document.getElementById('status'),
        roomInfo: document.getElementById('roomInfo')
    };
}

// === JOIN ROOM (with roomId in query) ===
async function joinRoom() {
    const roomId = elements.roomInput?.value.trim() || 'room1';
    
    // CRITICAL: Pass roomId to server via socket query
    socket.io.opts.query = { roomId };
    if (!socket.connected) socket.connect();
    
    state.roomId = roomId;
    state.localStream = await getLocalStream();
    setupSocketListeners();
    
    socket.emit('join-room', roomId, { name: 'User' }, (res) => {
        if (res?.error) {
            setStatus(`❌ ${res.error}`, 'error');
            leaveRoom();
        } else {
            setStatus(`✅ Connecté à "${roomId}"`, 'success');
        }
    });
}

// === LOAD DEVICE ===
async function loadDevice(routerRtpCapabilities) {
    state.device = new mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
}

// === CREATE TRANSPORTS (with ICE servers) ===
async function createSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-send-transport', (params) => {
            if (params.error) return reject(new Error(params.error));
            
            state.sendTransport = state.device.createSendTransport({
                id: params.id,
                iceParameters: params.iceParameters,
                iceCandidates: params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                // ICE servers for NAT traversal (Render)
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });
            
            state.sendTransport.on('connect', ({ dtlsParameters }, cb, errback) => {
                socket.emit('transport-connect', {
                    transportId: state.sendTransport.id, dtlsParameters
                }, (res) => res?.error ? errback(new Error(res.error)) : cb());
            });
            
            state.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, cb, errback) => {
                socket.emit('produce', {
                    transportId: state.sendTransport.id, kind, rtpParameters, appData
                }, (res) => res?.error ? errback(new Error(res.error)) : cb({ id: res.id }));
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
                id: params.id,
                iceParameters: params.iceParameters,
                iceCandidates: params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
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

// === CONSUME REMOTE STREAM ===
async function consume(producerId, rtpCapabilities) {
    return new Promise((resolve, reject) => {
        socket.emit('consume', { producerId, rtpCapabilities }, async (params) => {
            if (params.error) return reject(new Error(params.error));
            
            const consumer = await state.recvTransport.consume({
                id: params.id, producerId: params.producerId,
                kind: params.kind, rtpParameters: params.rtpParameters
            });
            
            resolve({ consumer, producerUserId: params.producerUserId, kind: params.kind });
        });
    });
}

// === ATTACH REMOTE VIDEO ===
function attachRemoteTrack(userId, consumer, kind) {
    const { wrapper, video, placeholder } = createVideoElement(userId, kind);
    video.srcObject = new MediaStream([consumer.track]);
    video.onplay = () => { if (placeholder) placeholder.style.display = 'none'; };
    
    if (!document.getElementById(wrapper.id) && elements.videosContainer) {
        elements.videosContainer.appendChild(wrapper);
    }
    
    state.consumers.set(userId, { consumer, kind, userId });
    updateVideoLayout();
}

// === SOCKET LISTENERS ===
function setupSocketListeners() {
    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        await loadDevice(routerRtpCapabilities);
        await createSendTransport();
        await createRecvTransport();
        await startProducing();
        if (elements.toggleAudio) elements.toggleAudio.disabled = false;
        if (elements.toggleVideo) elements.toggleVideo.disabled = false;
    });
    
    // CRITICAL: Listen for new producers from OTHER users
    socket.on('new-producer', async ({ producerId, userId, kind }) => {
        if (userId === socket.id) return; // Skip own producer
        if (!state.device || !state.recvTransport) return;
        
        try {
            const { consumer, producerUserId } = await consume(
                producerId, state.device.rtpCapabilities
            );
            attachRemoteTrack(producerUserId, consumer, kind);
            updateParticipantCount();
        } catch (err) {
            console.error('Consume error:', err);
        }
    });
    
    socket.on('user-disconnected', (userId) => {
        removeVideo(userId);
        state.peers.delete(userId);
        state.consumers.delete(userId);
        updateParticipantCount();
        updateVideoLayout();
    });
}

// === START PRODUCING LOCAL MEDIA ===
async function startProducing() {
    if (!state.localStream) return;
    
    const audioTrack = state.localStream.getAudioTracks()[0];
    if (audioTrack) {
        state.producers.audio = await state.sendTransport.produce({ track: audioTrack });
    }
    
    const videoTrack = state.localStream.getVideoTracks()[0];
    if (videoTrack) {
        state.producers.video = await state.sendTransport.produce({ track: videoTrack });
    }
    
    setStatus('✅ En ligne', 'success');
}

// === GET LOCAL MEDIA ===
async function getLocalStream() {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    
    const { wrapper, video, placeholder } = createVideoElement('local', 'video', true);
    video.srcObject = stream;
    video.onplay = () => { if (placeholder) placeholder.style.display = 'none'; };
    
    if (elements.videosContainer) {
        elements.videosContainer.insertBefore(wrapper, elements.videosContainer.firstChild);
    }
    
    return stream;
}

// === UI HELPERS ===
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
    const videos = elements.videosContainer.querySelectorAll('.video-wrapper');
    const cols = videos.length <= 1 ? 1 : videos.length <= 4 ? 2 : 3;
    elements.videosContainer.style.gridTemplateColumns = `repeat(${cols}, minmax(200px, 1fr))`;
}

function updateParticipantCount() {
    const count = state.consumers.size + 1;
    if (elements.roomInfo) {
        elements.roomInfo.textContent = `👥 ${count} participant${count > 1 ? 's' : ''}`;
    }
}

function setStatus(msg, type = 'info') {
    if (elements.status) {
        elements.status.textContent = msg;
        elements.status.className = `status ${type}`;
    }
}

function removeVideo(userId) {
    ['audio', 'video'].forEach(k => {
        const el = document.getElementById(`video-${userId}-${k}`);
        if (el) el.remove();
    });
}

function leaveRoom() {
    if (state.localStream) state.localStream.getTracks().forEach(t => t.stop());
    if (state.producers.audio) state.producers.audio.close();
    if (state.producers.video) state.producers.video.close();
    for (const c of state.consumers.values()) c.consumer.close();
    if (state.sendTransport) state.sendTransport.close();
    if (state.recvTransport) state.recvTransport.close();
    
    state.consumers.clear(); state.peers.clear();
    if (elements.videosContainer) elements.videosContainer.innerHTML = '';
    if (elements.joinBtn) elements.joinBtn.disabled = false;
    if (elements.roomInput) elements.roomInput.disabled = false;
    if (elements.leaveBtn) elements.leaveBtn.disabled = true;
    setStatus('🔴 Déconnecté', 'info');
}

// === INIT ===
function init() {
    Object.assign(elements, getElements());
    
    if (elements.joinBtn) elements.joinBtn.onclick = joinRoom;
    if (elements.leaveBtn) elements.leaveBtn.onclick = () => { socket.disconnect(); leaveRoom(); };
    
    if (elements.toggleAudio) {
        elements.toggleAudio.onclick = () => {
            const t = state.localStream?.getAudioTracks()[0];
            if (t) { t.enabled = !t.enabled; elements.toggleAudio.textContent = `🔊 Audio ${t.enabled ? 'ON' : 'OFF'}`; }
        };
    }
    if (elements.toggleVideo) {
        elements.toggleVideo.onclick = () => {
            const t = state.localStream?.getVideoTracks()[0];
            if (t) { t.enabled = !t.enabled; elements.toggleVideo.textContent = `📹 Vidéo ${t.enabled ? 'ON' : 'OFF'}`; }
        };
    }
    
    socket.on('connect', () => setStatus('🔌 Connecté', 'success'));
    socket.on('disconnect', () => { if (state.roomId) leaveRoom(); });
    
    setStatus('🔌 Prêt - Cliquez "Rejoindre"', 'success');
}

document.addEventListener('DOMContentLoaded', init);