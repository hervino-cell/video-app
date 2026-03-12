// === MEDIASOUP CLIENT IMPORT (from CDN) ===
const mediasoupClient = window.mediasoupClient || mediasoup;

// === SOCKET CONNECTION ===
const socket = io();

// === ÉTAT DE L'APPLICATION ===
const state = {
    roomId: null,
    device: null,
    sendTransport: null,
    recvTransport: null,
    localStream: null,
    producers: { audio: null, video: null },
    consumers: new Map(),
    peers: new Map(),
    activeSpeaker: null,
    audioLevels: new Map(),
    isSpeaking: false,
    socketId: null
};

// === ÉLÉMENTS DOM ===
const elements = {
    joinBtn: null,
    leaveBtn: null,
    roomInput: null,
    toggleAudio: null,
    toggleVideo: null,
    videosContainer: null,
    status: null,
    roomInfo: null
};

// === CONFIGURATION SIMULCAST ===
const SIMULCAST_CONFIG = {
    enabled: true,
    layers: [
        { rid: 'low', scaleResolutionDownBy: 4, maxBitrate: 100000, maxFramerate: 15 },
        { rid: 'medium', scaleResolutionDownBy: 2, maxBitrate: 300000, maxFramerate: 24 },
        { rid: 'high', scaleResolutionDownBy: 1, maxBitrate: 1000000, maxFramerate: 30 }
    ]
};

// === CONFIGURATION UI (Style Zoom) ===
const UI_CONFIG = {
    maxVisibleVideos: 9,
    activeSpeakerTimeout: 2000,
    videoQuality: {
        active: 'high',
        visible: 'medium',
        hidden: 'low'
    }
};

// === UTILITAIRES ===
function setStatus(message, type = 'info') {
    if (elements.status) {
        elements.status.textContent = message;
        elements.status.className = `status ${type}`;
    }
    console.log(`[STATUS] ${type}: ${message}`);
}

function generateUserId() {
    return 'user-' + Math.random().toString(36).substr(2, 6);
}

function getTimestamp() {
    return new Date().toLocaleTimeString();
}

// === CRÉATION UI VIDÉO (Style Zoom) ===
function createVideoElement(userId, kind, isLocal = false, isAvatar = false) {
    const wrapper = document.createElement('div');
    wrapper.className = `video-wrapper ${isLocal ? 'local' : 'remote'} ${isAvatar ? 'avatar' : ''}`;
    wrapper.id = `video-${userId}-${kind}`;
    wrapper.dataset.userId = userId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal;
    video.classList.add(kind);
    video.setAttribute('data-user-id', userId);

    // Overlay d'information
    const overlay = document.createElement('div');
    overlay.className = 'video-overlay';

    const nameLabel = document.createElement('div');
    nameLabel.className = 'user-label';
    nameLabel.textContent = isLocal ? 'Moi' : `User ${userId.slice(-4)}`;
    nameLabel.id = `label-${userId}`;

    // Indicateur de parole (comme Zoom)
    const speakingIndicator = document.createElement('div');
    speakingIndicator.className = 'speaking-indicator';
    speakingIndicator.id = `speaking-${userId}`;

    // Indicateur micro coupé
    const micStatus = document.createElement('div');
    micStatus.className = 'mic-status';
    micStatus.id = `mic-${userId}`;
    micStatus.innerHTML = '🎤';

    overlay.appendChild(nameLabel);
    overlay.appendChild(speakingIndicator);
    overlay.appendChild(micStatus);

    // Placeholder si pas de vidéo
    const placeholder = document.createElement('div');
    placeholder.className = 'video-placeholder';
    placeholder.innerHTML = isLocal ? '👤' : '👥';
    placeholder.id = `placeholder-${userId}`;

    wrapper.appendChild(video);
    wrapper.appendChild(placeholder);
    wrapper.appendChild(overlay);

    return { wrapper, video, placeholder, overlay, nameLabel, speakingIndicator, micStatus };
}

function addVideoToDOM(wrapper, isPriority = false) {
    if (!document.getElementById(wrapper.id) && elements.videosContainer) {
        if (isPriority) {
            elements.videosContainer.insertBefore(wrapper, elements.videosContainer.firstChild);
        } else {
            elements.videosContainer.appendChild(wrapper);
        }
    }
}

function removeVideo(userId) {
    ['audio', 'video'].forEach(kind => {
        const el = document.getElementById(`video-${userId}-${kind}`);
        if (el) el.remove();
    });
}

function updateVideoLayout() {
    if (!elements.videosContainer) return;

    const videos = Array.from(document.querySelectorAll('.video-wrapper.remote'));
    const totalVideos = videos.length + (state.localStream ? 1 : 0);

    let columns = 1;
    if (totalVideos > 1) columns = 2;
    if (totalVideos > 4) columns = 3;
    if (totalVideos > 9) columns = 4;
    if (totalVideos > 16) columns = 5;

    elements.videosContainer.style.gridTemplateColumns = `repeat(${columns}, minmax(200px, 1fr))`;

    if (state.activeSpeaker) {
        const activeVideo = document.getElementById(`video-${state.activeSpeaker}-video`);
        if (activeVideo) {
            activeVideo.parentElement.classList.add('active-speaker');
        }
    }

    videos.forEach((video, index) => {
        if (index >= UI_CONFIG.maxVisibleVideos) {
            video.classList.add('hidden');
            const userId = video.dataset.userId;
            updateConsumerQuality(userId, 'low');
        } else {
            video.classList.remove('hidden');
        }
    });
}

// === GESTION AUDIO LEVELS (Détection speaker actif) ===
function setupAudioLevelMonitor(stream, userId) {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = audioContext.createAnalyser();
        const microphone = audioContext.createMediaStreamSource(stream);
        const javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

        analyser.smoothingTimeConstant = 0.8;
        analyser.fftSize = 1024;
        microphone.connect(analyser);
        analyser.connect(javascriptNode);
        javascriptNode.connect(audioContext.destination);

        javascriptNode.onaudioprocess = () => {
            const array = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(array);

            let values = 0;
            const length = array.length;
            for (let i = 0; i < length; i++) {
                values += array[i];
            }
            const average = values / length;

            const isSpeaking = average > 30;

            if (isSpeaking) {
                state.audioLevels.set(userId, Date.now());
                state.isSpeaking = true;
                updateSpeakingIndicator(userId, true);
            } else {
                state.isSpeaking = false;
                updateSpeakingIndicator(userId, false);
            }

            checkActiveSpeaker();
        };
    } catch (err) {
        console.warn('Audio level monitor error:', err);
    }
}

function updateSpeakingIndicator(userId, isSpeaking) {
    const indicator = document.getElementById(`speaking-${userId}`);
    const wrapper = document.getElementById(`video-${userId}-video`);
    if (indicator && wrapper) {
        if (isSpeaking) {
            indicator.style.opacity = '1';
            wrapper.classList.add('speaking');
        } else {
            indicator.style.opacity = '0';
            wrapper.classList.remove('speaking');
        }
    }
}

function checkActiveSpeaker() {
    let mostRecentSpeaker = state.activeSpeaker;
    let mostRecentTime = 0;

    state.audioLevels.forEach((timestamp, userId) => {
        const timeSinceSpeech = Date.now() - timestamp;
        if (timeSinceSpeech < UI_CONFIG.activeSpeakerTimeout && timeSinceSpeech > mostRecentTime) {
            mostRecentTime = timeSinceSpeech;
            mostRecentSpeaker = userId;
        }
    });

    if (mostRecentSpeaker !== state.activeSpeaker) {
        const previousSpeaker = state.activeSpeaker;
        state.activeSpeaker = mostRecentSpeaker;

        if (previousSpeaker) {
            const prevVideo = document.getElementById(`video-${previousSpeaker}-video`);
            if (prevVideo) prevVideo.parentElement.classList.remove('active-speaker');
        }

        if (state.activeSpeaker) {
            const activeVideo = document.getElementById(`video-${state.activeSpeaker}-video`);
            if (activeVideo) {
                activeVideo.parentElement.classList.add('active-speaker');
                updateConsumerQuality(state.activeSpeaker, UI_CONFIG.videoQuality.active);
            }
        }

        updateVideoLayout();
    }
}

// === MEDIASOUP DEVICE ===
async function loadDevice(routerRtpCapabilities) {
    state.device = new mediasoupClient.Device();
    await state.device.load({ routerRtpCapabilities });
    setStatus('✅ Device Mediasoup chargé', 'success');
    return state.device;
}

// === TRANSPORTS ===
async function createSendTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-send-transport', (params) => {
            if (params.error) {
                reject(new Error(params.error));
                return;
            }

            state.sendTransport = state.device.createSendTransport({
                id: params.id,
                iceParameters: params.iceParameters,
                iceCandidates: params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                sctpParameters: params.sctpParameters,
                iceServers: params.iceServers
            });

            state.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                socket.emit('transport-connect', {
                    transportId: state.sendTransport.id,
                    dtlsParameters
                }, (result) => {
                    if (result?.error) errback(new Error(result.error));
                    else callback();
                });
            });

            state.sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
                try {
                    socket.emit('produce', {
                        transportId: state.sendTransport.id,
                        kind,
                        rtpParameters,
                        appData
                    }, (result) => {
                        if (result.error) errback(new Error(result.error));
                        else callback({ id: result.id });
                    });
                } catch (err) {
                    errback(err);
                }
            });

            state.sendTransport.on('connectionstatechange', (state) => {
                console.log(`Send transport state: ${state}`);
            });

            resolve(state.sendTransport);
        });
    });
}

async function createRecvTransport() {
    return new Promise((resolve, reject) => {
        socket.emit('create-recv-transport', (params) => {
            if (params.error) {
                reject(new Error(params.error));
                return;
            }

            state.recvTransport = state.device.createRecvTransport({
                id: params.id,
                iceParameters: params.iceParameters,
                iceCandidates: params.iceCandidates,
                dtlsParameters: params.dtlsParameters,
                iceServers: params.iceServers
            });

            state.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
                socket.emit('transport-connect', {
                    transportId: state.recvTransport.id,
                    dtlsParameters
                }, (result) => {
                    if (result?.error) errback(new Error(result.error));
                    else callback();
                });
            });

            state.recvTransport.on('connectionstatechange', (state) => {
                console.log(`Recv transport state: ${state}`);
            });

            resolve(state.recvTransport);
        });
    });
}

// === PRODUCE AVEC SIMULCAST ===
async function produce(track, appData = {}) {
    if (!state.sendTransport) throw new Error('Send transport not ready');

    const isVideo = track.kind === 'video';
    const params = {
        track,
        encodings: isVideo && SIMULCAST_CONFIG.enabled
            ? SIMULCAST_CONFIG.layers
            : [{ maxBitrate: 100000 }],
        codecOptions: {
            videoGoogleStartBitrate: 1000,
            videoGoogleMaxBitrate: 2000,
            videoGoogleMinBitrate: 500
        },
        appData: { ...appData, userId: socket.id, timestamp: Date.now() }
    };

    const producer = await state.sendTransport.produce(params);

    producer.on('trackended', () => {
        console.log(`${track.kind} track ended`);
    });

    producer.on('transportclose', () => {
        console.log('Transport closed for producer');
    });

    return producer;
}

// === CONSUME AVEC SÉLECTION DE QUALITÉ ===
async function consume(producerId, rtpCapabilities, preferredLayer = 'medium') {
    return new Promise((resolve, reject) => {
        socket.emit('consume', { producerId, rtpCapabilities }, async (params) => {
            if (params.error) {
                reject(new Error(params.error));
                return;
            }

            try {
                const consumer = await state.recvTransport.consume({
                    id: params.id,
                    producerId: params.producerId,
                    kind: params.kind,
                    rtpParameters: params.rtpParameters,
                    layers: params.layers
                });

                if (consumer.type === 'simulcast') {
                    const layerMap = { low: 0, medium: 1, high: 2 };
                    const spatialLayer = layerMap[preferredLayer] || 1;

                    consumer.setPreferredLayers({
                        spatialLayer: spatialLayer,
                        temporalLayer: 2
                    });
                }

                consumer.on('trackended', () => {
                    console.log(`Consumer ${consumer.id} track ended`);
                });

                consumer.on('transportclose', () => {
                    console.log(`Transport closed for consumer ${consumer.id}`);
                });

                resolve({ consumer, producerUserId: params.producerUserId, kind: params.kind });
            } catch (err) {
                reject(err);
            }
        });
    });
}

// === METTRE À JOUR LA QUALITÉ D'UN CONSUMER ===
async function updateConsumerQuality(userId, quality) {
    const consumerData = state.consumers.get(userId);
    if (!consumerData || !consumerData.consumer) return;

    const consumer = consumerData.consumer;
    if (consumer.type === 'simulcast') {
        const layerMap = { low: 0, medium: 1, high: 2 };
        const spatialLayer = layerMap[quality] || 1;

        try {
            await consumer.setPreferredLayers({
                spatialLayer: spatialLayer,
                temporalLayer: 2
            });
            console.log(`[QUALITY] ${userId} → ${quality}`);
        } catch (err) {
            console.warn(`Failed to update quality for ${userId}:`, err);
        }
    }
}

// === METTRE À JOUR TOUTES LES QUALITÉS ===
function updateAllConsumersQuality() {
    const visibleUsers = Array.from(state.consumers.keys()).slice(0, UI_CONFIG.maxVisibleVideos);
    state.consumers.forEach((data, userId) => {
        if (userId === state.activeSpeaker) {
            updateConsumerQuality(userId, UI_CONFIG.videoQuality.active);
        } else if (visibleUsers.includes(userId)) {
            updateConsumerQuality(userId, UI_CONFIG.videoQuality.visible);
        } else {
            updateConsumerQuality(userId, UI_CONFIG.videoQuality.hidden);
        }
    });
}

// === AFFICHAGE FLUX DISTANT ===
function attachRemoteTrack(userId, consumer, kind) {
    const { wrapper, video, placeholder } = createVideoElement(userId, kind, false, false);

    const stream = new MediaStream([consumer.track]);
    video.srcObject = stream;

    video.onplay = () => {
        if (placeholder) placeholder.style.display = 'none';
    };

    video.onpause = () => {
        if (placeholder) placeholder.style.display = 'flex';
    };

    video.onerror = (e) => {
        console.error(`Video error for ${userId}:`, e);
        setStatus(`⚠️ Problème vidéo ${userId.slice(-4)}`, 'error');
    };

    addVideoToDOM(wrapper, userId === state.activeSpeaker);

    if (!state.peers.has(userId)) {
        state.peers.set(userId, { audio: null, video: null, joinedAt: Date.now() });
    }
    state.peers.get(userId)[kind] = consumer.track;

    state.consumers.set(userId, { consumer, kind, userId });

    if (kind === 'audio' && !state.audioLevels.has(userId)) {
        const audioStream = new MediaStream([consumer.track]);
        setupAudioLevelMonitor(audioStream, userId);
    }

    updateVideoLayout();
}

// === GESTION DES PARTICIPANTS ===
function updateParticipantCount() {
    const count = state.peers.size + 1;
    if (elements.roomInfo) {
        elements.roomInfo.textContent = `👥 ${count} participant${count > 1 ? 's' : ''}`;
    }
    updateVideoLayout();
}

// === ÉVÉNEMENTS SOCKET ===
function setupSocketListeners() {
    // 1. Réception des capacités du router
    socket.on('router-capabilities', async ({ routerRtpCapabilities }) => {
        setStatus('🔄 Chargement du device...', 'info');
        try {
            await loadDevice(routerRtpCapabilities);

            setStatus('🔗 Création des transports...', 'info');
            await createSendTransport();
            await createRecvTransport();

            setStatus('✅ Transports prêts', 'success');
            await startProducing();

            if (elements.toggleAudio) elements.toggleAudio.disabled = false;
            if (elements.toggleVideo) elements.toggleVideo.disabled = false;

        } catch (err) {
            setStatus(`❌ Erreur setup: ${err.message}`, 'error');
            console.error(err);
        }
    });

    // 2. Nouveau producer d'un autre utilisateur
    socket.on('new-producer', async ({ producerId, userId, kind, appData }) => {
        if (userId === socket.id) return;
        if (!state.device || !state.recvTransport) {
            console.warn('Device ou recvTransport pas prêt');
            return;
        }

        try {
            setStatus(`📥 Flux ${kind} de ${userId.slice(-4)}...`, 'info');

            const { consumer, producerUserId } = await consume(
                producerId,
                state.device.rtpCapabilities,
                UI_CONFIG.videoQuality.visible
            );

            attachRemoteTrack(producerUserId, consumer, kind);
            updateParticipantCount();

            setStatus(`✅ ${userId.slice(-4)} connecté`, 'success');

        } catch (err) {
            console.error('Erreur consume:', err);
            setStatus(`⚠️ ${userId.slice(-4)}: ${err.message}`, 'error');
        }
    });

    // 3. Utilisateur déconnecté
    socket.on('user-disconnected', (userId) => {
        setStatus(`👋 ${userId.slice(-4)} a quitté`, 'info');
        removeVideo(userId);
        state.peers.delete(userId);
        state.consumers.delete(userId);
        state.audioLevels.delete(userId);
        if (state.activeSpeaker === userId) {
            state.activeSpeaker = null;
        }

        updateParticipantCount();
        updateVideoLayout();
    });

    // 4. Liste des peers existants
    socket.on('current-peers', (peers) => {
        console.log('Peers existants:', peers);
    });

    // 5. Gestion des erreurs socket
    socket.on('error', (data) => {
        setStatus(`❌ Erreur: ${data.message || data}`, 'error');
    });

    // 6. Ping/Pong pour keep-alive
    setInterval(() => {
        if (socket.connected) {
            socket.emit('ping');
        }
    }, 30000);

    socket.on('pong', () => {
        console.log('🏓 Server alive');
    });
}

// === DÉMARRAGE PRODUCTION ===
async function startProducing() {
    if (!state.localStream) return;

    try {
        const audioTrack = state.localStream.getAudioTracks()[0];
        if (audioTrack) {
            state.producers.audio = await produce(audioTrack, { name: 'audio' });
            console.log('🎤 Audio producer created');
            setupAudioLevelMonitor(state.localStream, socket.id);
        }

        const videoTrack = state.localStream.getVideoTracks()[0];
        if (videoTrack) {
            state.producers.video = await produce(videoTrack, { name: 'video' });
            console.log('📹 Video producer created (simulcast enabled)');
        }

        setStatus('✅ En ligne - Prêt pour la visio', 'success');
    } catch (err) {
        console.error('Erreur produce:', err);
        setStatus(`⚠️ Erreur production: ${err.message}`, 'error');
    }
}

// === CONTRÔLES UTILISATEUR ===
function setupControls() {
    if (elements.toggleAudio) {
        elements.toggleAudio.onclick = () => {
            const track = state.localStream?.getAudioTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                elements.toggleAudio.textContent = `🔊 Audio ${track.enabled ? 'ON' : 'OFF'}`;
                elements.toggleAudio.classList.toggle('muted', !track.enabled);

                const micStatus = document.getElementById(`mic-${socket.id}`);
                if (micStatus) {
                    micStatus.style.opacity = track.enabled ? '0' : '1';
                }

                setStatus(`🔇 Audio ${track.enabled ? 'activé' : 'coupé'}`, 'info');
                socket.emit('mic-status', { enabled: track.enabled });
            }
        };
    }

    if (elements.toggleVideo) {
        elements.toggleVideo.onclick = () => {
            const track = state.localStream?.getVideoTracks()[0];
            if (track) {
                track.enabled = !track.enabled;
                elements.toggleVideo.textContent = `📹 Vidéo ${track.enabled ? 'ON' : 'OFF'}`;
                elements.toggleVideo.classList.toggle('muted', !track.enabled);
                setStatus(`📵 Vidéo ${track.enabled ? 'activée' : 'coupée'}`, 'info');
            }
        };
    }

    document.addEventListener('dblclick', (e) => {
        if (e.target.closest('.video-wrapper')) {
            const wrapper = e.target.closest('.video-wrapper');
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                wrapper.requestFullscreen();
            }
        }
    });
}

// === JOIN / LEAVE ===
async function joinRoom() {
    const roomId = elements.roomInput.value.trim() || 'room1';
    if (!roomId) {
        alert('Entrez un nom de salle');
        return;
    }

    try {
        if (elements.joinBtn) elements.joinBtn.disabled = true;
        if (elements.roomInput) elements.roomInput.disabled = true;
        if (elements.leaveBtn) elements.leaveBtn.disabled = false;

        setStatus(`🔗 Connexion à "${roomId}"...`, 'info');

        state.localStream = await getLocalStream();
        setupSocketListeners();

        state.roomId = roomId;

        // Pass roomId in socket query for server to use
        socket.io.opts.query = { roomId };

        socket.emit('join-room', roomId, { name: 'User' }, (response) => {
            if (response?.error) {
                setStatus(`❌ Erreur join: ${response.error}`, 'error');
                leaveRoom();
            } else {
                setStatus(`✅ Connecté à "${roomId}"`, 'success');
                state.socketId = socket.id;
            }
        });
    } catch (err) {
        console.error('Join error:', err);
        setStatus(`❌ ${err.message}`, 'error');
        leaveRoom();
    }
}

async function getLocalStream() {
    setStatus('🎤📹 Accès caméra/micro...', 'info');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                facingMode: 'user'
            }
        });

        const { wrapper, video, placeholder } = createVideoElement('local', 'video', true, false);
        video.srcObject = stream;

        video.onplay = () => {
            if (placeholder) placeholder.style.display = 'none';
        };

        addVideoToDOM(wrapper, true);
        setStatus('✅ Caméra/micro activés', 'success');
        return stream;
    } catch (err) {
        console.error('Erreur getUserMedia:', err);
        setStatus(`❌ Erreur média: ${err.message}`, 'error');
        throw err;
    }
}

function leaveRoom() {
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    if (state.producers.audio) state.producers.audio.close();
    if (state.producers.video) state.producers.video.close();
    state.producers = { audio: null, video: null };

    for (const { consumer } of state.consumers.values()) {
        consumer.close();
    }
    state.consumers.clear();

    if (state.sendTransport) state.sendTransport.close();
    if (state.recvTransport) state.recvTransport.close();
    state.sendTransport = null;
    state.recvTransport = null;
    state.device = null;

    if (elements.videosContainer) elements.videosContainer.innerHTML = '';
    state.peers.clear();
    state.audioLevels.clear();
    state.activeSpeaker = null;

    if (elements.joinBtn) elements.joinBtn.disabled = false;
    if (elements.roomInput) elements.roomInput.disabled = false;
    if (elements.leaveBtn) elements.leaveBtn.disabled = true;
    if (elements.toggleAudio) {
        elements.toggleAudio.disabled = true;
        elements.toggleAudio.textContent = '🔊 Audio ON';
        elements.toggleAudio.classList.remove('muted');
    }
    if (elements.toggleVideo) {
        elements.toggleVideo.disabled = true;
        elements.toggleVideo.textContent = '📹 Vidéo ON';
        elements.toggleVideo.classList.remove('muted');
    }
    if (elements.roomInfo) elements.roomInfo.textContent = '';

    setStatus('🔴 Déconnecté - Prêt', 'info');
    state.roomId = null;
}

// === INITIALISATION ===
function init() {
    // Get DOM elements
    elements.joinBtn = document.getElementById('joinBtn');
    elements.leaveBtn = document.getElementById('leaveBtn');
    elements.roomInput = document.getElementById('roomInput');
    elements.toggleAudio = document.getElementById('toggleAudio');
    elements.toggleVideo = document.getElementById('toggleVideo');
    elements.videosContainer = document.getElementById('videosContainer');
    elements.status = document.getElementById('status');
    elements.roomInfo = document.getElementById('roomInfo');

    if (elements.joinBtn) elements.joinBtn.onclick = joinRoom;
    if (elements.leaveBtn) elements.leaveBtn.onclick = () => {
        socket.disconnect();
        leaveRoom();
    };

    setupControls();

    socket.on('disconnect', () => {
        setStatus('🔌 Déconnecté du serveur', 'error');
        if (state.roomId) leaveRoom();
    });

    socket.on('connect', () => {
        setStatus('🔌 Connecté au serveur - Cliquez sur "Rejoindre"', 'success');
        state.socketId = socket.id;
    });

    setStatus('🔌 Connecté au serveur - Cliquez sur "Rejoindre"', 'success');
}

// Démarrer quand le DOM est prêt
document.addEventListener('DOMContentLoaded', init);
