// server/index.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express  = require('express');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');
const { Server } = require('socket.io');
const mediasoup  = require('mediasoup');
const { getOrCreateRoom, getRoom, addPeer, removePeer } = require('./room');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
    transports: ['websocket', 'polling'],
});

// ── STATIC FILES ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/mediasoup-client.js', (req, res) => {
    const p = path.join(__dirname, '..', 'public', 'mediasoup-client.js');
    fs.existsSync(p)
        ? res.sendFile(p)
        : res.status(404).send('// Run "npm run build" first');
});

// ── TURN CREDENTIALS (Metered.ca, cached 1 h) ─────────────────────────────────
let cachedIce = null, iceFetchedAt = 0;

async function getIceServers() {
    const now = Date.now();
    if (cachedIce && now - iceFetchedAt < 3_600_000) return cachedIce;
    try {
        const r = await fetch(
            'https://lenoir-jules.metered.live/api/v1/turn/credentials?apiKey=' +
            process.env.METERED_API_KEY
        );
        cachedIce = await r.json();
        iceFetchedAt = now;
        console.log('✅ TURN credentials refreshed, servers:', cachedIce.length);
        return cachedIce;
    } catch (err) {
        console.error('⚠️  TURN fetch failed:', err.message);
        return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
}

// ── MEDIASOUP TRANSPORT OPTIONS ───────────────────────────────────────────────
// FIX: Proper listenIps configuration
function makeTransportOptions() {
    const listenIps = [];
    
    // Check if we have an announced IP (from env or auto-detect)
    if (process.env.MEDIASOUP_ANNOUNCED_IP) {
        listenIps.push({
            ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0',
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
        });
    } else {
        // Fallback for local testing
        listenIps.push({
            ip: '0.0.0.0',
        });
    }

    return {
        listenIps,
        enableUdp: true,
        enableTcp: true,
        preferTcp: true,  // FIX: Prefer TCP on constrained networks
        initialAvailableOutgoingBitrate: 1_000_000,
        maxIncomingBitrate: 1_500_000,
    };
}

// ── MEDIASOUP WORKER ─────────────────────────────────────────────────────────
let worker;
async function initMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
    });
    worker.on('died', () => { 
        console.error('❌ mediasoup worker died'); 
        process.exit(1); 
    });
    console.log('✅ mediasoup worker ready');
}

// ── CLEANUP HELPER ──────────────────────────────────────────────────────────
function closePeer(roomId, socketId) {
    const room = getRoom(roomId);
    const peer = room?.peers.get(socketId);
    if (!peer) return;
    
    for (const p of peer.producers.values())  { 
        try { p.close(); } catch (_) {} 
    }
    for (const c of peer.consumers.values())  { 
        try { c.close(); } catch (_) {} 
    }
    try { peer.sendTransport?.close(); } catch (_) {}
    try { peer.recvTransport?.close(); } catch (_) {}
}

// ── SOCKET HANDLERS ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('🔌 connected:', socket.id);
    let roomId = null;

    // JOIN
    socket.on('join-room', async (rid, userData, cb) => {
        try {
            const room = await getOrCreateRoom(worker, rid);
            roomId = rid;
            socket.join(rid);

            addPeer(rid, socket.id, {
                id: socket.id, 
                userData,
                sendTransport: null, 
                recvTransport: null,
                producers: new Map(), 
                consumers: new Map(),
            });

            console.log(`✅ Peer ${socket.id} joined room ${rid}`);

            socket.emit('router-capabilities', {
                routerRtpCapabilities: room.router.rtpCapabilities,
            });

            // Tell new peer about everyone already in the room
            const existing = [];
            for (const [pid, peer] of room.peers) {
                if (pid === socket.id) continue;
                for (const [producerId, producer] of peer.producers)
                    existing.push({ 
                        producerId, 
                        userId: pid, 
                        kind: producer.kind 
                    });
            }
            
            if (existing.length) {
                console.log(`📢 Sending ${existing.length} existing producers to ${socket.id}`);
                socket.emit('existing-producers', existing);
            }

            socket.to(rid).emit('user-joined', { userId: socket.id, userData });
            console.log(`📍 Room ${rid} now has ${room.peers.size} peers`);
            
            cb?.({ success: true });
        } catch (err) {
            console.error('❌ join-room error:', err);
            cb?.({ error: err.message });
        }
    });

    // CREATE SEND TRANSPORT
    socket.on('create-send-transport', async (cb) => {
        try {
            if (!roomId) return cb({ error: 'Not in a room' });
            
            const room = getRoom(roomId);
            if (!room) return cb({ error: 'Room not found' });
            
            const iceServers = await getIceServers();
            const options = makeTransportOptions();
            
            console.log('Creating sendTransport with options:', JSON.stringify(options, null, 2));
            
            const t = await room.router.createWebRtcTransport(options);
            
            const peer = room.peers.get(socket.id);
            if (peer) peer.sendTransport = t;
            
            console.log(`✅ Send transport created: ${t.id}`);
            
            cb({ 
                id: t.id, 
                iceParameters: t.iceParameters,
                iceCandidates: t.iceCandidates, 
                dtlsParameters: t.dtlsParameters,
                iceServers 
            });
        } catch (err) { 
            console.error('❌ create-send-transport error:', err);
            cb({ error: err.message }); 
        }
    });

    // CREATE RECV TRANSPORT
    socket.on('create-recv-transport', async (cb) => {
        try {
            if (!roomId) return cb({ error: 'Not in a room' });
            
            const room = getRoom(roomId);
            if (!room) return cb({ error: 'Room not found' });
            
            const iceServers = await getIceServers();
            const options = makeTransportOptions();
            
            console.log('Creating recvTransport with options:', JSON.stringify(options, null, 2));
            
            const t = await room.router.createWebRtcTransport(options);
            
            const peer = room.peers.get(socket.id);
            if (peer) peer.recvTransport = t;
            
            console.log(`✅ Recv transport created: ${t.id}`);
            
            cb({ 
                id: t.id, 
                iceParameters: t.iceParameters,
                iceCandidates: t.iceCandidates, 
                dtlsParameters: t.dtlsParameters,
                iceServers 
            });
        } catch (err) { 
            console.error('❌ create-recv-transport error:', err);
            cb({ error: err.message }); 
        }
    });

    // TRANSPORT CONNECT
    socket.on('transport-connect', async ({ transportId, dtlsParameters }, cb) => {
        try {
            const peer = getRoom(roomId)?.peers.get(socket.id);
            if (!peer) return cb?.({ error: 'Peer not found' });
            
            const t = peer.sendTransport?.id === transportId 
                ? peer.sendTransport
                : peer.recvTransport?.id === transportId 
                ? peer.recvTransport
                : null;
            
            if (!t) return cb?.({ error: 'Transport not found' });
            
            console.log(`🔗 Connecting transport ${transportId}`);
            await t.connect({ dtlsParameters });
            console.log(`✅ Transport ${transportId} connected`);
            
            cb?.({});
        } catch (err) { 
            console.error('❌ transport-connect error:', err);
            cb?.({ error: err.message }); 
        }
    });

    // PRODUCE
    socket.on('produce', async ({ kind, rtpParameters, appData }, cb) => {
        try {
            const peer = getRoom(roomId)?.peers.get(socket.id);
            if (!peer?.sendTransport) return cb({ error: 'no send transport' });
            
            const producer = await peer.sendTransport.produce({ 
                kind, 
                rtpParameters, 
                appData 
            });
            
            peer.producers.set(producer.id, producer);
            
            console.log(`🎬 Producer created: ${producer.id} (${kind}) by ${socket.id}`);
            
            // Notify others
            socket.to(roomId).emit('new-producer', { 
                producerId: producer.id, 
                userId: socket.id, 
                kind 
            });
            
            cb({ id: producer.id });
        } catch (err) { 
            console.error('❌ produce error:', err);
            cb({ error: err.message }); 
        }
    });

    // CONSUME — created PAUSED, resumed only after client confirms ready
    socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
        try {
            const room = getRoom(roomId);
            if (!room) return cb({ error: 'Room not found' });
            
            const peer = room.peers.get(socket.id);
            if (!peer?.recvTransport) return cb({ error: 'no recv transport' });
            
            if (!room.router.canConsume({ producerId, rtpCapabilities })) {
                return cb({ error: 'cannot consume' });
            }

            const consumer = await peer.recvTransport.consume({
                producerId, 
                rtpCapabilities,
                paused: true,
            });
            
            peer.consumers.set(consumer.id, consumer);

            // Find producer owner
            let producerUserId = null;
            for (const [uid, p] of room.peers) {
                if (p.producers.has(producerId)) {
                    producerUserId = uid;
                    break;
                }
            }

            console.log(`🍽 Consumer created: ${consumer.id} (${consumer.kind}) for ${socket.id} from ${producerUserId}`);
            
            cb({ 
                id: consumer.id, 
                producerId, 
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, 
                producerUserId 
            });
        } catch (err) { 
            console.error('❌ consume error:', err);
            cb({ error: err.message }); 
        }
    });

    // CONSUMER RESUME — client calls this once track is attached to DOM
    socket.on('consumer-resume', async ({ consumerId }) => {
        try {
            const peer = getRoom(roomId)?.peers.get(socket.id);
            const consumer = peer?.consumers.get(consumerId);
            
            if (!consumer) {
                console.warn('⚠️ consumer-resume: consumer not found', consumerId);
                return;
            }
            
            await consumer.resume();
            console.log(`▶️ Consumer resumed: ${consumerId}`);
        } catch (err) { 
            console.error('❌ consumer-resume error:', err); 
        }
    });

    // LEAVE
    socket.on('leave-room', () => {
        if (!roomId) return;
        
        console.log(`👋 ${socket.id} leaving room ${roomId}`);
        closePeer(roomId, socket.id);
        socket.to(roomId).emit('user-disconnected', socket.id);
        socket.leave(roomId);
        removePeer(roomId, socket.id);
        roomId = null;
    });

    // DISCONNECT
    socket.on('disconnect', () => {
        console.log('🔌 disconnected:', socket.id);
        if (!roomId) return;
        
        closePeer(roomId, socket.id);
        socket.to(roomId).emit('user-disconnected', socket.id);
        removePeer(roomId, socket.id);
    });
});

// ── AUTO-DETECT PUBLIC IP ─────────────────────────────────────────────────────
async function detectPublicIp() {
    if (process.env.MEDIASOUP_ANNOUNCED_IP) {
        console.log('🌐 announced IP (env):', process.env.MEDIASOUP_ANNOUNCED_IP);
        return;
    }
    try {
        const r = await fetch('https://api.ipify.org?format=json');
        const { ip } = await r.json();
        process.env.MEDIASOUP_ANNOUNCED_IP = ip;
        console.log('🌐 announced IP (auto-detected):', ip);
    } catch (err) {
        console.error('⚠️ could not detect public IP:', err.message);
        console.log('⚠️ Using localhost - will only work on local network');
    }
}

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
    try {
        await detectPublicIp();
        await initMediasoup();
        await getIceServers();
        
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, '0.0.0.0', () => {
            console.log('🚀 Server listening on port', PORT);
            console.log('📊 Environment:');
            console.log('   - MEDIASOUP_ANNOUNCED_IP:', process.env.MEDIASOUP_ANNOUNCED_IP);
            console.log('   - METERED_API_KEY configured:', !!process.env.METERED_API_KEY);
        });
    } catch (err) {
        console.error('❌ Failed to start server:', err);
        process.exit(1);
    }
}

start();