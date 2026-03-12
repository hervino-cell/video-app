require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const { getOrCreateRoom, addPeer, removePeer, getPeers } = require('./room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: "*", 
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

let worker;

// === MEDIASOUP WORKER ===
async function initMediasoup() {
    worker = await mediasoup.createWorker({
        logLevel: 'warn',
        rtcMinPort: 40000,
        rtcMaxPort: 49999,
    });
    worker.on('died', () => {
        console.error('❌ Mediasoup worker died');
        process.exit(1);
    });
    console.log('✅ Mediasoup worker ready');
}

// === SOCKET HANDLERS ===
io.on('connection', (socket) => {
    console.log(`🔌 Connecté: ${socket.id}`);
    
    // === JOIN ROOM ===
    socket.on('join-room', async (roomId, userData, callback) => {
        try {
            const room = await getOrCreateRoom(worker, roomId);
            
            addPeer(roomId, socket.id, {
                id: socket.id,
                roomId,
                userData,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map()
            });
            
            // Send router capabilities
            socket.emit('router-capabilities', {
                routerRtpCapabilities: room.router.rtpCapabilities
            });
            
            // Send existing peers
            const existingPeers = getPeers(roomId).filter(id => id !== socket.id);
            socket.emit('current-peers', existingPeers);
            
            // Notify others
            socket.to(roomId).emit('user-joined', { userId: socket.id, userData });
            
            console.log(`✅ ${socket.id} joined room: ${roomId}`);
            if (callback) callback({ success: true, roomId });
        } catch (err) {
            console.error('Join error:', err);
            if (callback) callback({ error: err.message });
        }
    });
    
    // === CREATE SEND TRANSPORT ===
    socket.on('create-send-transport', async (callback) => {
        try {
            const roomId = socket.handshake.query.roomId || 'room1';
            const room = await getOrCreateRoom(worker, roomId);
            
            const transport = await room.router.createWebRtcTransport({
                listenIps: [{ 
                    ip: '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
                }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                initialAvailableOutgoingBitrate: 1000000,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });
            
            const peer = room.peers.get(socket.id);
            if (peer) peer.sendTransport = transport;
            
            transport.on('connect', async ({ dtlsParameters }, cb, errback) => {
                try { await transport.connect({ dtlsParameters }); cb(); }
                catch (err) { errback(err); }
            });
            
            transport.on('produce', async ({ kind, rtpParameters, appData }, cb, errback) => {
                try {
                    const producer = await transport.produce({ kind, rtpParameters, appData });
                    const peer = room.peers.get(socket.id);
                    if (peer) peer.producers.set(producer.id, producer);
                    
                    // Notify ALL peers in room
                    socket.to(roomId).emit('new-producer', {
                        producerId: producer.id,
                        userId: socket.id,
                        kind,
                        appData
                    });
                    
                    cb({ id: producer.id });
                } catch (err) { errback(err); }
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (err) {
            console.error('Send transport error:', err);
            callback({ error: err.message });
        }
    });
    
    // === CREATE RECV TRANSPORT ===
    socket.on('create-recv-transport', async (callback) => {
        try {
            const roomId = socket.handshake.query.roomId || 'room1';
            const room = await getOrCreateRoom(worker, roomId);
            
            const transport = await room.router.createWebRtcTransport({
                listenIps: [{ 
                    ip: '0.0.0.0',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
                }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            });
            
            const peer = room.peers.get(socket.id);
            if (peer) peer.recvTransport = transport;
            
            transport.on('connect', async ({ dtlsParameters }, cb, errback) => {
                try { await transport.connect({ dtlsParameters }); cb(); }
                catch (err) { errback(err); }
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (err) {
            console.error('Recv transport error:', err);
            callback({ error: err.message });
        }
    });
    
    // === CONSUME ===
    socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const roomId = socket.handshake.query.roomId || 'room1';
            const room = await getOrCreateRoom(worker, roomId);
            const peer = room.peers.get(socket.id);
            
            if (!peer || !peer.recvTransport) {
                return callback({ error: 'Recv transport not ready' });
            }
            
            if (!room.router.canConsume({ producerId, rtpCapabilities })) {
                return callback({ error: 'Cannot consume' });
            }
            
            const consumer = await peer.recvTransport.consume({
                producerId, rtpCapabilities, paused: false
            });
            
            peer.consumers.set(consumer.id, consumer);
            
            // Find producer owner
            let producerUserId = null;
            for (const [uid, p] of room.peers) {
                if (p.producers.has(producerId)) { producerUserId = uid; break; }
            }
            
            callback({
                id: consumer.id, producerId, kind: consumer.kind,
                rtpParameters: consumer.rtpParameters, type: consumer.type, producerUserId
            });
        } catch (err) {
            console.error('Consume error:', err);
            callback({ error: err.message });
        }
    });
    
    // === DISCONNECT ===
    socket.on('disconnect', () => {
        console.log(`🔌 Déconnecté: ${socket.id}`);
        const roomId = socket.handshake.query.roomId || 'room1';
        socket.to(roomId).emit('user-disconnected', socket.id);
        removePeer(roomId, socket.id);
    });
    
    socket.on('ping', () => socket.emit('pong'));
});

// === START ===
async function startServer() {
    await initMediasoup();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Server: http://localhost:${PORT}`);
        console.log(`🌐 Announced IP: ${process.env.MEDIASOUP_ANNOUNCED_IP || 'Not set'}`);
    });
}

startServer().catch(console.error);