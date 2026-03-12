require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');
const path = require('path');

const app = express();
const server = http.createServer(app);

// CORS configuration for Render
const io = new Server(server, { 
  cors: { 
    origin: "*",
    methods: ["GET", "POST"] 
  } 
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// State
let worker;
const rooms = new Map();

// Initialize Mediasoup
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

// Create router for a room
async function createRouter(roomId) {
  const router = await worker.createRouter({
    mediaCodecs: [
      {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2
      },
      {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        parameters: { 'x-google-start-bitrate': 1000 }
      },
      {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f' }
      }
    ]
  });
  console.log(`🎚️ Router créé pour room: ${roomId}`);
  return router;
}

// Socket handlers
io.on('connection', (socket) => {
  console.log(`🔌 Connecté: ${socket.id}`);

  // === JOIN ROOM ===
  socket.on('join-room', async (roomId, userData, callback) => {
    try {
      // Create or get room
      if (!rooms.has(roomId)) {
        const router = await createRouter(roomId);
        rooms.set(roomId, { router, peers: new Map() });
      }
      const room = rooms.get(roomId);
      const { router, peers } = room;

      // Store peer info
      const peer = {
        id: socket.id,
        roomId,
        userData,
        sendTransport: null,
        recvTransport: null,
        producers: new Map(),
        consumers: new Map()
      };
      peers.set(socket.id, peer);

      // Send router capabilities
      socket.emit('router-capabilities', {
        routerRtpCapabilities: router.rtpCapabilities
      });

      // Create send transport
      socket.on('create-send-transport', async (callback) => {
        try {
          const transport = await router.createWebRtcTransport({
            listenIps: [{ 
              ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0', 
              announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null 
            }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: 1000000,
          });

          peer.sendTransport = transport;

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
              peer.producers.set(producer.id, producer);
              
              // Notify other peers
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

      // Create recv transport
      socket.on('create-recv-transport', async (callback) => {
        try {
          const transport = await router.createWebRtcTransport({
            listenIps: [{ 
              ip: process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0', 
              announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null 
            }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
          });

          peer.recvTransport = transport;

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

      // Consume producer
      socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
          const { router } = room;
          
          if (!router.canConsume({ producerId, rtpCapabilities })) {
            return callback({ error: 'Cannot consume: incompatible capabilities' });
          }

          const consumer = await peer.recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: false
          });

          peer.consumers.set(consumer.id, consumer);

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

      // Resume consumer
      socket.on('resume-consumer', async ({ consumerId }, callback) => {
        try {
          const consumer = peer.consumers.get(consumerId);
          if (consumer) {
            await consumer.resume();
            callback({ success: true });
          } else {
            callback({ error: 'Consumer not found' });
          }
        } catch (err) {
          callback({ error: err.message });
        }
      });

      // Disconnect
      socket.on('disconnect', () => {
        console.log(`🔌 Déconnecté: ${socket.id}`);
        socket.to(roomId).emit('user-disconnected', socket.id);
        
        if (room && room.peers) {
          const peer = room.peers.get(socket.id);
          if (peer) {
            for (const consumer of peer.consumers.values()) {
              consumer.close();
            }
            for (const producer of peer.producers.values()) {
              producer.close();
            }
            if (peer.sendTransport) peer.sendTransport.close();
            if (peer.recvTransport) peer.recvTransport.close();
            
            room.peers.delete(socket.id);
          }
          
          if (room.peers.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Room supprimée: ${roomId}`);
          }
        }
      });

      if (callback && typeof callback === 'function') {
        callback({ success: true, roomId });
      }

    } catch (err) {
      console.error('Join room error:', err);
      if (callback && typeof callback === 'function') {
        callback({ error: err.message });
      }
    }
  });

  socket.on('ping', () => socket.emit('pong'));
});

// === CRITICAL: RENDER REQUIRES THIS ===
async function startServer() {
  await initMediasoup();
  
  // Render ALWAYS assigns PORT env variable
  const PORT = process.env.PORT || 3000;
  const LISTEN_IP = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';
  
  server.listen(PORT, LISTEN_IP, () => {
    console.log(`🚀 Server prêt on ${LISTEN_IP}:${PORT}`);
    console.log(`📡 Ports RTC: 40000-49999`);
    console.log(`🌍 Announced IP: ${process.env.MEDIASOUP_ANNOUNCED_IP}`);
    console.log(`🔧 Environment: ${process.env.NODE_ENV}`);
  });
}

startServer().catch(console.error);