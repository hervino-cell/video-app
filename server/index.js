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

// ── STATIC FILES ──────────────────────────────────────────────────────────────
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
// We open TCP on the announced IP. Render free plan blocks UDP and arbitrary
// TCP ports, so we rely on TURN relay for actual media — the WebRTC transport
// still needs to be reachable for DTLS handshake, which goes through TURN too
// when the client sets iceTransportPolicy:'relay'.
function makeTransportOptions() {
    return {
        listenIps: [{
            ip:          '0.0.0.0',
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
        }],
        enableUdp: true,
        enableTcp: true,
        preferTcp: false,
        initialAvailableOutgoingBitrate: 1_000_000,
    };
}

// ── MEDIASOUP WORKER ──────────────────────────────────────────────────────────
let worker;
async function initMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
    });
    worker.on('died', () => { console.error('❌ mediasoup worker died'); process.exit(1); });
    console.log('✅ mediasoup worker ready');
}

// ── CLEANUP HELPER ────────────────────────────────────────────────────────────
function closePeer(roomId, socketId) {
    const room = getRoom(roomId);
    const peer = room?.peers.get(socketId);
    if (!peer) return;
    for (const p of peer.producers.values())  { try { p.close(); } catch (_) {} }
    for (const c of peer.consumers.values())  { try { c.close(); } catch (_) {} }
    try { peer.sendTransport?.close(); } catch (_) {}
    try { peer.recvTransport?.close(); } catch (_) {}
}

// ── SOCKET HANDLERS ───────────────────────────────────────────────────────────
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
                id: socket.id, userData,
                sendTransport: null, recvTransport: null,
                producers: new Map(), consumers: new Map(),
            });

            socket.emit('router-capabilities', {
                routerRtpCapabilities: room.router.rtpCapabilities,
            });

            // Tell new peer about everyone already in the room
            const existing = [];
            for (const [pid, peer] of room.peers) {
                if (pid === socket.id) continue;
                for (const [producerId, producer] of peer.producers)
                    existing.push({ producerId, userId: pid, kind: producer.kind });
            }
            if (existing.length) socket.emit('existing-producers', existing);

            socket.to(rid).emit('user-joined', { userId: socket.id, userData });
            console.log(socket.id, 'joined', rid, '—', existing.length, 'existing producers');
            cb?.({ success: true });
        } catch (err) {
            console.error('join-room error:', err);
            cb?.({ error: err.message });
        }
    });

    // CREATE SEND TRANSPORT
    socket.on('create-send-transport', async (cb) => {
        try {
            if (!roomId) return cb({ error: 'Not in a room' });
            const room      = getRoom(roomId);
            const iceServers = await getIceServers();
            const t          = await room.router.createWebRtcTransport(makeTransportOptions());
            const peer       = room.peers.get(socket.id);
            if (peer) peer.sendTransport = t;
            cb({ id: t.id, iceParameters: t.iceParameters,
                 iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters,
                 iceServers });
        } catch (err) { console.error(err); cb({ error: err.message }); }
    });

    // CREATE RECV TRANSPORT
    socket.on('create-recv-transport', async (cb) => {
        try {
            if (!roomId) return cb({ error: 'Not in a room' });
            const room      = getRoom(roomId);
            const iceServers = await getIceServers();
            const t          = await room.router.createWebRtcTransport(makeTransportOptions());
            const peer       = room.peers.get(socket.id);
            if (peer) peer.recvTransport = t;
            cb({ id: t.id, iceParameters: t.iceParameters,
                 iceCandidates: t.iceCandidates, dtlsParameters: t.dtlsParameters,
                 iceServers });
        } catch (err) { console.error(err); cb({ error: err.message }); }
    });

    // TRANSPORT CONNECT
    socket.on('transport-connect', async ({ transportId, dtlsParameters }, cb) => {
        try {
            const peer = getRoom(roomId)?.peers.get(socket.id);
            const t    = peer?.sendTransport?.id === transportId ? peer.sendTransport
                       : peer?.recvTransport?.id === transportId ? peer.recvTransport
                       : null;
            if (!t) return cb?.({ error: 'transport not found' });
            await t.connect({ dtlsParameters });
            cb?.({});
        } catch (err) { console.error(err); cb?.({ error: err.message }); }
    });

    // PRODUCE
    socket.on('produce', async ({ kind, rtpParameters, appData }, cb) => {
        try {
            const peer = getRoom(roomId)?.peers.get(socket.id);
            if (!peer?.sendTransport) return cb({ error: 'no send transport' });
            const producer = await peer.sendTransport.produce({ kind, rtpParameters, appData });
            peer.producers.set(producer.id, producer);
            socket.to(roomId).emit('new-producer', { producerId: producer.id, userId: socket.id, kind });
            console.log('🎬 producer', producer.id, kind, 'from', socket.id);
            cb({ id: producer.id });
        } catch (err) { console.error(err); cb({ error: err.message }); }
    });

    // CONSUME — created PAUSED, resumed only after client confirms ready
    socket.on('consume', async ({ producerId, rtpCapabilities }, cb) => {
        try {
            const room = getRoom(roomId);
            const peer = room?.peers.get(socket.id);
            if (!peer?.recvTransport) return cb({ error: 'no recv transport' });
            if (!room.router.canConsume({ producerId, rtpCapabilities }))
                return cb({ error: 'cannot consume' });

            const consumer = await peer.recvTransport.consume({
                producerId, rtpCapabilities,
                paused: true,   // start paused — client resumes after attaching track
            });
            peer.consumers.set(consumer.id, consumer);

            let producerUserId = null;
            for (const [uid, p] of room.peers)
                if (p.producers.has(producerId)) { producerUserId = uid; break; }

            console.log('🍽  consumer', consumer.id, consumer.kind, 'for', socket.id, '(paused)');
            cb({ id: consumer.id, producerId, kind: consumer.kind,
                 rtpParameters: consumer.rtpParameters, producerUserId });
        } catch (err) { console.error(err); cb({ error: err.message }); }
    });

    // CONSUMER RESUME — client calls this once track is attached to DOM
    socket.on('consumer-resume', async ({ consumerId }) => {
        try {
            const peer     = getRoom(roomId)?.peers.get(socket.id);
            const consumer = peer?.consumers.get(consumerId);
            if (!consumer) return console.warn('consumer-resume: not found', consumerId);
            await consumer.resume();
            console.log('▶️  consumer', consumerId, 'resumed');
        } catch (err) { console.error('consumer-resume error:', err); }
    });

    // LEAVE
    socket.on('leave-room', () => {
        if (!roomId) return;
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
        const r  = await fetch('https://api.ipify.org?format=json');
        const { ip } = await r.json();
        process.env.MEDIASOUP_ANNOUNCED_IP = ip;
        console.log('🌐 announced IP (auto):', ip);
    } catch (err) {
        console.error('⚠️  could not detect public IP:', err.message);
    }
}

// ── START ─────────────────────────────────────────────────────────────────────
async function start() {
    await detectPublicIp();
    await initMediasoup();
    await getIceServers();   // warm TURN cache
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () =>
        console.log('🚀 listening on port', PORT));
}

start().catch(console.error);