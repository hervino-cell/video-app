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
    consumers: new Map(),
    pendingProducers: [],
    remoteStreams: new Map(), // NEW: Track remote video/audio elements
};

const el = {};

// ── JOIN ─────────────────────────────────────────────────────────────────────────────
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
            if (res?.error) { 
                setStatus('❌ ' + res.error, 'error'); 
                resetUI(); 
            }
        });
    } catch (err) {
        console.error('joinRoom error:', err);
        setStatus('❌ ' + err.message, 'error');
        resetUI();
    }
}

// ── DEVICE ─────────────────────────────────────────────────────────────────────────────
async function loadDevice(routerRtpCapabilities) {
    state.device = new window.mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
    console.log('✅ Device loaded');
}

// ── TRANSPORT OPTIONS ─────────────────────────────────────────────────────────────────
function transportOptions(params) {
    return {
        id:                 params.id,
        iceParameters:      params.iceParameters,
        iceCandidates:      params.iceCandidates,
        dtlsParameters:     params.dtlsParameters,
        iceServers:         params.iceServers,
        iceTransportPolicy: 'relay',
    };
}

// ── SEND TRANSPORT ─────────────────────────────────────────────────────────────────────
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

// ── RECV TRANSPORT ─────────────────────────────────────────────────────────────────────
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

// ── PRODUCE ────────────────────────────────────────────────────────────────────────────
async function startProducing() {
    const audioTrack = state.localStream?.getAudioTracks()[0];
    if (audioTrack) {
        state.producers.audio = await state.sendTransport.produce({
            track: audioTrack,
            codecOptions: { opusStereo: true, opusDtx: true },
        });
        console.log('🎤 Audio producer ready:', state.producers.audio.id);
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
        console.log('📹 Video producer ready:', state.producers.video.id);
    }
}

// ── CONSUME ────────────────────────────────────────────────────────────────────────────
async function consumeProducer(producerId) {
    console.log('consumeProducer called for:', producerId);
    
    if (!state.device || !state.recvTransport) {
        console.log('Device or recvTransport not ready, queueing producer:', producerId);
        if (!state.pendingProducers.includes(producerId))
            state.pendingProducers.push(producerId);
        return;
    }

    return new Promise(resolve => {
        socket.emit('consume', {
            producerId,
            rtpCapabilities: state.device.rtpCapabilities,
        }, async (params) => {
            console.log('consume callback received:', params);
            
            if (params.error) {
                console.error('❌ consume error:', params.error);
                return resolve();
            }

            try {
                console.log('Creating consumer for producerId:', producerId, 'producerUserId:', params.producerUserId, 'kind:', params.kind);
                
                const consumer = await state.recvTransport.consume({
                    id:            params.id,
                    producerId:    params.producerId,
                    kind:          params.kind,
                    rtpParameters: params.rtpParameters,
                });

                console.log('✅ Consumer created:', consumer.id, 'kind:', consumer.kind);

                const userId = params.producerUserId;
                if (!userId) {
                    console.error('❌ No producerUserId in params!', params);
                    return resolve();
                }

                // Track this consumer
                const consumerKey = `${userId}-${params.kind}`;
                state.consumers.set(consumerKey, {
                    id: consumer.id,
                    consumer,
                    kind: params.kind,
                    userId,
                    producerId,
                });

                console.log('Stored consumer with key:', consumerKey);

                // Attach track to DOM BEFORE resuming
                attachTrack(userId, consumer, params.kind);

                // Resume consumer
                socket.emit('consumer-resume', { consumerId: consumer.id });
                await consumer.resume();

                console.log('▶️ Consumer resumed:', consumerKey);
                updateParticipantCount();
                
            } catch (err) {
                console.error('❌ recvTransport.consume error:', err);
            }
            resolve();
        });
    });
}

// ── ATTACH TRACK TO DOM ────────────────────────────────────────────────────────────────
function attachTrack(userId, consumer, kind) {
    console.log('attachTrack called - userId:', userId, 'kind:', kind, 'track:', consumer.track);

    if (!consumer.track) {
        console.error('❌ Consumer has no track!');
        return;
    }

    const stream = new MediaStream([consumer.track]);

    if (kind === 'audio') {
        console.log('Creating audio element for user:', userId);
        
        // FIX: Remove old audio if exists
        const oldAudio = document.getElementById(`audio-${userId}`);
        if (oldAudio) oldAudio.remove();
        
        const audio = document.createElement('audio');
        audio.id = `audio-${userId}`;
        audio.autoplay = true;
        audio.playsinline = true;
        audio.style.display = 'none';
        audio.srcObject = stream;
        
        document.body.appendChild(audio);
        console.log('Audio element created and added to DOM:', audio.id);
        
        // FIX: Store reference to prevent garbage collection
        state.remoteStreams.set(`audio-${userId}`, audio);
        
        audio.play()
            .then(() => {
                console.log('✅ Audio playing:', userId);
            })
            .catch((err) => {
                console.warn('⚠️ Audio autoplay blocked:', err.message);
                // Try again on user interaction
                const playAudio = () => {
                    audio.play().catch(e => console.error('Failed to play audio:', e));
                    document.removeEventListener('click', playAudio);
                };
                document.addEventListener('click', playAudio);
            });
        return;
    }

    // VIDEO
    console.log('Creating video element for user:', userId);
    
    // FIX: Ensure wrapper exists and stays in DOM
    const wrapperId = `video-${userId}-video`;
    let wrapper = document.getElementById(wrapperId);
    
    if (!wrapper) {
        console.log('Creating new video wrapper:', wrapperId);
        wrapper = createVideoTile(userId, false);
        wrapper.id = wrapperId;
        el.videosContainer.appendChild(wrapper);
        console.log('Video wrapper added to DOM');
    } else {
        console.log('Reusing existing video wrapper:', wrapperId);
    }

    const video = wrapper.querySelector('video');
    const placeholder = wrapper.querySelector('.video-placeholder');

    if (!video) {
        console.error('❌ No video element found in wrapper!');
        return;
    }

    console.log('Setting video srcObject');
    video.srcObject = stream;
    
    // FIX: Store reference to prevent garbage collection
    state.remoteStreams.set(`video-${userId}`, video);

    // Hide placeholder
    if (placeholder) {
        placeholder.style.display = 'none';
        console.log('Placeholder hidden');
    }

    // Start playback with proper error handling
    console.log('Attempting video play...');
    
    video.play()
        .then(() => {
            console.log('✅ Video playing, unmuting:', userId);
            video.muted = false;
        })
        .catch((err) => {
            console.warn('⚠️ Video autoplay blocked:', err.message);
            
            // Show click-to-play button
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
                    video.play()
                        .then(() => {
                            btn.remove();
                            console.log('✅ Video playing after click');
                        })
                        .catch(e => console.error('Failed to play:', e));
                };
                wrapper.appendChild(btn);
                console.log('Play button added');
            }
        });
}

// ── SOCKET LISTENERS ───────────────────────────────────────────────────────────────────
function setupSocketListeners() {
    socket.off('router-capabilities');
    socket.off('existing-producers');
    socket.off('new-producer');
    socket.off('user-disconnected');

    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        try {
            console.log('📡 router-capabilities received');
            await loadDevice(routerRtpCapabilities);

            const [sendParams, recvParams] = await Promise.all([
                new Promise((res, rej) =>
                    socket.emit('create-send-transport',
                        p => p.error ? rej(new Error(p.error)) : res(p))),
                new Promise((res, rej) =>
                    socket.emit('create-recv-transport',
                        p => p.error ? rej(new Error(p.error)) : res(p))),
            ]);

            console.log('📡 Transports params received');
            await createSendTransport(sendParams);
            await createRecvTransport(recvParams);
            await startProducing();

            const pending = [...state.pendingProducers];
            state.pendingProducers = [];
            
            if (pending.length > 0) {
                console.log('🔄 Draining', pending.length, 'pending producer(s)');
                for (const id of pending) {
                    await consumeProducer(id);
                }
            }

            el.toggleAudio.disabled = el.toggleVideo.disabled = false;
            setStatus('✅ Connecté à "' + state.roomId + '"', 'success');
        } catch (err) {
            console.error('❌ Setup error:', err);
            setStatus('❌ ' + err.message, 'error');
        }
    });

    socket.on('existing-producers', async (list) => {
        console.log('📦 existing-producers:', list.length, 'producer(s)');
        for (const { producerId, userId, kind } of list) {
            console.log('Existing producer - producerId:', producerId, 'userId:', userId, 'kind:', kind);
            await consumeProducer(producerId);
        }
    });

    socket.on('new-producer', async ({ producerId, userId, kind }) => {
        console.log('🆕 new-producer - producerId:', producerId, 'userId:', userId, 'kind:', kind);
        
        if (userId === socket.id) {
            console.log('Ignoring own producer');
            return;
        }
        
        await consumeProducer(producerId);
    });

    socket.on('user-disconnected', (userId) => {
        console.log('👋 user-disconnected:', userId);
        
        // Remove video wrapper
        const videoWrapper = document.getElementById(`video-${userId}-video`);
        if (videoWrapper) {
            videoWrapper.remove();
            console.log('Video wrapper removed:', userId);
        }

        // Remove audio element
        const audioElement = document.getElementById(`audio-${userId}`);
        if (audioElement) {
            audioElement.pause();
            audioElement.srcObject = null;
            audioElement.remove();
            console.log('Audio element removed:', userId);
        }

        // Clean up stream references
        state.remoteStreams.delete(`video-${userId}`);
        state.remoteStreams.delete(`audio-${userId}`);

        // Remove consumers
        const keysToDelete = [];
        for (const key of state.consumers.keys()) {
            if (key.startsWith(`${userId}-`)) {
                keysToDelete.push(key);
            }
        }
        
        keysToDelete.forEach(key => {
            const consumer = state.consumers.get(key);
            try {
                consumer.consumer?.close();
                console.log('Consumer closed:', key);
            } catch (e) {
                console.error('Error closing consumer:', e);
            }
            state.consumers.delete(key);
        });

        updateParticipantCount();
        updateVideoLayout();
    });
}

// ── LOCAL STREAM ───────────────────────────────────────────────────────────────────────
async function getLocalStream() {
    console.log('Getting local stream...');
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    console.log('✅ Local stream obtained');
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

// ── DOM HELPERS ────────────────────────────────────────────────────────────────────────
function createVideoTile(userId, isLocal) {
    const wrapper = document.createElement('div');
    wrapper.id = `video-${userId}-video`;
    wrapper.className = 'video-wrapper ' + (isLocal ? 'local' : 'remote');

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;
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
    console.log('Video layout updated, tiles:', n);
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

// ── LEAVE ──────────────────────────────────────────────────────────────────────────────
function leaveRoom() {
    console.log('Leaving room...');
    
    state.localStream?.getTracks().forEach(t => t.stop());
    state.producers.audio?.close();
    state.producers.video?.close();
    
    for (const { consumer } of state.consumers.values()) {
        try {
            consumer?.close();
        } catch (e) {
            console.error('Error closing consumer:', e);
        }
    }
    
    state.sendTransport?.close();
    state.recvTransport?.close();

    // Clean up all remote streams
    for (const stream of state.remoteStreams.values()) {
        if (stream instanceof HTMLAudioElement || stream instanceof HTMLVideoElement) {
            stream.pause();
            stream.srcObject = null;
            stream.remove();
        }
    }
    state.remoteStreams.clear();

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

// ── INIT ───────────────────────────────────────────────────────────────────────────────
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