require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const { getOrCreateRoom, addPeer, removePeer } = require('./room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'], credentials: true },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

// Serve mediasoup-client bundle from node_modules (no CDN needed)
const path = require('path');
const fs   = require('fs');



let worker;
let cachedIceServers = null;
let iceServersFetchedAt = 0;

// === FETCH TURN CREDENTIALS (cached 1 hour) ===
async function getIceServers() {
    const now = Date.now();
    if (cachedIceServers && now - iceServersFetchedAt < 3600_000) {
        return cachedIceServers;
    }
    try {
        const res = await fetch(
            `https://lenoir-jules.metered.live/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY || '35bc0752073676aafcc58f20471787c3a1ab'}`
        );
        cachedIceServers = await res.json();
        iceServersFetchedAt = now;
        console.log('✅ TURN credentials refreshed');
        return cachedIceServers;
    } catch (err) {
        console.error('⚠️  TURN fetch failed, using fallback STUN:', err.message);
        // Fallback so the server doesn't crash — video may not work behind NAT
        return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
}

// === TRANSPORT OPTIONS — TCP-only (Render blocks UDP) ===
function makeTransportOptions() {
    return {
        listenIps: [{
            ip: '0.0.0.0',
            announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
        }],
        enableUdp: false,  // Render firewall blocks UDP
        enableTcp: true,
        preferTcp: true,
        initialAvailableOutgoingBitrate: 1000000,
    };
}

// === MEDIASOUP WORKER ===
async function initMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
    });
    worker.on('died', () => { console.error('❌ Mediasoup worker died'); process.exit(1); });
    console.log('✅ Mediasoup worker ready');
}

// === SOCKET HANDLERS ===
io.on('connection', (socket) => {
    console.log(`🔌 Connected: ${socket.id}`);
    let currentRoomId = null;

    // === JOIN ROOM ===
    socket.on('join-room', async (roomId, userData, callback) => {
        try {
            const room = await getOrCreateRoom(worker, roomId);
            currentRoomId = roomId;
            socket.join(roomId);

            addPeer(roomId, socket.id, {
                id: socket.id, roomId, userData,
                sendTransport: null, recvTransport: null,
                producers: new Map(), consumers: new Map()
            });

            socket.emit('router-capabilities', {
                routerRtpCapabilities: room.router.rtpCapabilities
            });

            // Send all existing producers to the new joiner
            const existingProducers = [];
            for (const [peerId, peer] of room.peers) {
                if (peerId === socket.id) continue;
                for (const [producerId, producer] of peer.producers) {
                    existingProducers.push({ producerId, userId: peerId, kind: producer.kind });
                }
            }
            if (existingProducers.length > 0) {
                socket.emit('existing-producers', existingProducers);
            }

            socket.to(roomId).emit('user-joined', { userId: socket.id, userData });
            console.log(`✅ ${socket.id} joined "${roomId}" (${existingProducers.length} existing producers)`);
            if (callback) callback({ success: true, roomId });
        } catch (err) {
            console.error('join-room error:', err);
            if (callback) callback({ error: err.message });
        }
    });

    // === CREATE SEND TRANSPORT ===
    socket.on('create-send-transport', async (callback) => {
        try {
            const roomId = currentRoomId;
            if (!roomId) return callback({ error: 'Not in a room' });

            const room = await getOrCreateRoom(worker, roomId);
            const iceServers = await getIceServers();
            const transport = await room.router.createWebRtcTransport(makeTransportOptions());

            const peer = room.peers.get(socket.id);
            if (peer) peer.sendTransport = transport;

            // Pass iceServers to client so it uses TURN
            callback({
                id:             transport.id,
                iceParameters:  transport.iceParameters,
                iceCandidates:  transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                iceServers                               // <-- TURN credentials
            });
        } catch (err) {
            console.error('create-send-transport error:', err);
            callback({ error: err.message });
        }
    });

    // === CREATE RECV TRANSPORT ===
    socket.on('create-recv-transport', async (callback) => {
        try {
            const roomId = currentRoomId;
            if (!roomId) return callback({ error: 'Not in a room' });

            const room = await getOrCreateRoom(worker, roomId);
            const iceServers = await getIceServers();
            const transport = await room.router.createWebRtcTransport(makeTransportOptions());

            const peer = room.peers.get(socket.id);
            if (peer) peer.recvTransport = transport;

            callback({
                id:             transport.id,
                iceParameters:  transport.iceParameters,
                iceCandidates:  transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
                iceServers                               // <-- TURN credentials
            });
        } catch (err) {
            console.error('create-recv-transport error:', err);
            callback({ error: err.message });
        }
    });

    // === TRANSPORT CONNECT ===
    socket.on('transport-connect', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const room = await getOrCreateRoom(worker, currentRoomId);
            const peer = room.peers.get(socket.id);
            if (!peer) return callback?.({ error: 'Peer not found' });

            const transport =
                peer.sendTransport?.id === transportId ? peer.sendTransport :
                peer.recvTransport?.id === transportId ? peer.recvTransport : null;

            if (!transport) return callback?.({ error: 'Transport not found' });

            await transport.connect({ dtlsParameters });
            if (callback) callback({});
        } catch (err) {
            console.error('transport-connect error:', err);
            if (callback) callback({ error: err.message });
        }
    });

    // === PRODUCE ===
    socket.on('produce', async ({ kind, rtpParameters, appData }, callback) => {
        try {
            const room = await getOrCreateRoom(worker, currentRoomId);
            const peer = room.peers.get(socket.id);
            if (!peer?.sendTransport) return callback({ error: 'Send transport not ready' });

            const producer = await peer.sendTransport.produce({ kind, rtpParameters, appData });
            peer.producers.set(producer.id, producer);

            socket.to(currentRoomId).emit('new-producer', {
                producerId: producer.id,
                userId:     socket.id,
                kind
            });

            console.log(`🎬 Producer ${producer.id} (${kind}) from ${socket.id}`);
            callback({ id: producer.id });
        } catch (err) {
            console.error('produce error:', err);
            callback({ error: err.message });
        }
    });

    // === CONSUME ===
    socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const room = await getOrCreateRoom(worker, currentRoomId);
            const peer = room.peers.get(socket.id);

            if (!peer?.recvTransport)
                return callback({ error: 'Recv transport not ready' });
            if (!room.router.canConsume({ producerId, rtpCapabilities }))
                return callback({ error: 'Cannot consume' });

            const consumer = await peer.recvTransport.consume({
                producerId, rtpCapabilities, paused: false
            });
            peer.consumers.set(consumer.id, consumer);

            let producerUserId = null;
            for (const [uid, p] of room.peers) {
                if (p.producers.has(producerId)) { producerUserId = uid; break; }
            }

            callback({
                id: consumer.id, producerId,
                kind: consumer.kind, rtpParameters: consumer.rtpParameters,
                type: consumer.type, producerUserId
            });
        } catch (err) {
            console.error('consume error:', err);
            callback({ error: err.message });
        }
    });

    // === LEAVE ROOM ===
    socket.on('leave-room', () => {
        if (currentRoomId) {
            socket.to(currentRoomId).emit('user-disconnected', socket.id);
            socket.leave(currentRoomId);
            removePeer(currentRoomId, socket.id);
            currentRoomId = null;
        }
    });

    // === DISCONNECT ===
    socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.id}`);
        if (currentRoomId) {
            socket.to(currentRoomId).emit('user-disconnected', socket.id);
            removePeer(currentRoomId, socket.id);
        }
    });

    socket.on('ping', () => socket.emit('pong'));
});

// === AUTO-DETECT PUBLIC IP (for Render and other cloud hosts) ===
async function detectPublicIp() {
    if (process.env.MEDIASOUP_ANNOUNCED_IP) {
        console.log(`🌐 Announced IP (from env): ${process.env.MEDIASOUP_ANNOUNCED_IP}`);
        return; // already set manually, skip
    }
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const { ip } = await res.json();
        process.env.MEDIASOUP_ANNOUNCED_IP = ip;
        console.log(`🌐 Announced IP (auto-detected): ${ip}`);
    } catch (err) {
        console.error('⚠️  Could not detect public IP:', err.message);
        console.error('    Set MEDIASOUP_ANNOUNCED_IP manually in your environment variables.');
    }
}

// === START ===
async function startServer() {
    await detectPublicIp();   // must run before transports are created
    await initMediasoup();
    await getIceServers();    // warm the TURN cache at boot
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server running on port ${PORT}`);
    });
}

startServer().catch(console.error);