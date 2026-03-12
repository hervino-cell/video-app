require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const { getOrCreateRoom, addPeer, removePeer, getPeers } = require('./room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

let worker;

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

io.on('connection', (socket) => {
    console.log(`🔌 Connecté: ${socket.id}`);
    
    socket.on('join-room', async (roomId, userData, callback) => {
        try {
            const room = await getOrCreateRoom(worker, roomId);
            addPeer(roomId, socket.id, {
                id: socket.id,
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
            
            // Notify others about new user
            socket.to(roomId).emit('user-joined', {
                userId: socket.id,
                userData
            });
            
            if (callback) callback({ success: true, roomId });
        } catch (err) {
            console.error('Join room error:', err);
            if (callback) callback({ error: err.message });
        }
    });
    
    socket.on('create-send-transport', async (callback) => {
        try {
            const room = getPeers(socket.roomId ? socket.roomId : 'room1');
            // Get room from socket data
            const roomId = socket.handshake.query.roomId || 'room1';
            const roomData = await getOrCreateRoom(worker, roomId);
            
            const transport = await roomData.router.createWebRtcTransport({
                listenIps: [{ 
                    ip: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
                }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });
            
            transport.on('connect', async ({ dtlsParameters }, cb, errback) => {
                try {
                    await transport.connect({ dtlsParameters });
                    cb();
                } catch (err) {
                    errback(err);
                }
            });
            
            transport.on('produce', async ({ kind, rtpParameters, appData }, cb, errback) => {
                try {
                    const producer = await transport.produce({ kind, rtpParameters, appData });
                    
                    const room = getPeers(socket.roomId || 'room1');
                    const roomId = socket.handshake.query.roomId || 'room1';
                    const roomData = await getOrCreateRoom(worker, roomId);
                    const peers = roomData.peers;
                    const peer = peers.get(socket.id);
                    if (peer) peer.producers.set(producer.id, producer);
                    
                    // Notify ALL other peers in room
                    socket.to(roomId).emit('new-producer', {
                        producerId: producer.id,
                        userId: socket.id,
                        kind,
                        appData
                    });
                    
                    cb({ id: producer.id });
                } catch (err) {
                    errback(err);
                }
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (err) {
            console.error('Create send transport error:', err);
            callback({ error: err.message });
        }
    });
    
    socket.on('create-recv-transport', async (callback) => {
        try {
            const roomId = socket.handshake.query.roomId || 'room1';
            const roomData = await getOrCreateRoom(worker, roomId);
            
            const transport = await roomData.router.createWebRtcTransport({
                listenIps: [{ 
                    ip: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null
                }],
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });
            
            transport.on('connect', async ({ dtlsParameters }, cb, errback) => {
                try {
                    await transport.connect({ dtlsParameters });
                    cb();
                } catch (err) {
                    errback(err);
                }
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters
            });
        } catch (err) {
            console.error('Create recv transport error:', err);
            callback({ error: err.message });
        }
    });
    
    socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const roomId = socket.handshake.query.roomId || 'room1';
            const roomData = await getOrCreateRoom(worker, roomId);
            const peers = roomData.peers;
            const peer = peers.get(socket.id);
            
            if (!peer || !peer.recvTransport) {
                return callback({ error: 'Recv transport not ready' });
            }
            
            if (!roomData.router.canConsume({ producerId, rtpCapabilities })) {
                return callback({ error: 'Cannot consume: incompatible capabilities' });
            }
            
            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: false
            });
            
            peer.consumers.set(consumer.id, consumer);
            
            // Find producer owner
            let producerUserId = null;
            for (const [uid, p] of peers) {
                if (p.producers.has(producerId)) {
                    producerUserId = uid;
                    break;
                }
            }
            
            callback({
                id: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
                producerUserId
            });
        } catch (err) {
            console.error('Consume error:', err);
            callback({ error: err.message });
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`🔌 Déconnecté: ${socket.id}`);
        const roomId = socket.handshake.query.roomId || 'room1';
        
        socket.to(roomId).emit('user-disconnected', socket.id);
        removePeer(roomId, socket.id);
        
        const room = getPeers(roomId);
        if (room.length === 0) {
            console.log(`🗑️ Room vide: ${roomId}`);
        }
    });
    
    socket.on('ping', () => socket.emit('pong'));
});

async function startServer() {
    await initMediasoup();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Serveur prêt sur http://localhost:${PORT}`);
        console.log(`📡 Ports RTC: 40000-49999`);
    });
}

startServer().catch(console.error);
