require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mediasoup = require('mediasoup');

// Configuration
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"] } 
});

app.use(express.static('public'));

// State
let worker;
const rooms = new Map(); // roomId -> { router, peers: Map }

// Initialisation Mediasoup
async function initMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'error',
    rtcMinPort: 40000,
    rtcMaxPort: 49999,
  });

  worker.on('died', () => {
    console.error('❌ Mediasoup worker died');
    process.exit(1);
  });

  console.log('✅ Mediasoup worker ready');
}

// Créer un router pour une room
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

// Gestion des sockets
io.on('connection', (socket) => {
  console.log(`🔌 Connecté: ${socket.id}`);

  // === REJOINDRE UNE ROOM ===
  socket.on('join-room', async (roomId, userData, callback) => {
    try {
      // Créer ou récupérer la room
      if (!rooms.has(roomId)) {
        const router = await createRouter(roomId);
        rooms.set(roomId, { router, peers: new Map() });
      }
      const room = rooms.get(roomId);
      const { router, peers } = room;

      // Stocker les infos du peer
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

      // === ÉTAPE 1: Envoyer les capacités du router ===
      socket.emit('router-capabilities', {
        routerRtpCapabilities: router.rtpCapabilities
      });

      // === ÉTAPE 2: Créer le transport d'envoi (pour producer) ===
      socket.on('create-send-transport', async (callback) => {
        try {
          const transport = await router.createWebRtcTransport({
            listenIps: [{ 
              ip: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1', 
              announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null 
            }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: 1000000,
          });

          peer.sendTransport = transport;

          // Gérer la connexion du transport
          transport.on('connect', async ({ dtlsParameters }, cb, errback) => {
            try {
              await transport.connect({ dtlsParameters });
              cb();
            } catch (err) {
              errback(err);
            }
          });

          // Gérer la production de flux
          transport.on('produce', async ({ kind, rtpParameters, appData }, cb, errback) => {
            try {
              const producer = await transport.produce({ kind, rtpParameters, appData });
              
              // Stocker le producer
              peer.producers.set(producer.id, producer);
              
              // Notifier les autres peers
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

      // === ÉTAPE 3: Créer le transport de réception (pour consumer) ===
      socket.on('create-recv-transport', async (callback) => {
        try {
          const transport = await router.createWebRtcTransport({
            listenIps: [{ 
              ip: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1', 
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

      // === ÉTAPE 4: Consommer un producer d'un autre peer ===
      socket.on('consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
          const { router } = room;
          
          // Vérifier si on peut consommer
          if (!router.canConsume({ producerId, rtpCapabilities })) {
            return callback({ error: 'Cannot consume: incompatible capabilities' });
          }

          const consumer = await peer.recvTransport.consume({
            producerId,
            rtpCapabilities,
            paused: false // Démarrer directement
          });

          // Stocker le consumer
          peer.consumers.set(consumer.id, consumer);

          // Trouver qui produit ce flux
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

      // === ÉTAPE 5: Resume/pause un consumer ===
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

      // === GESTION DÉCONNEXION ===
      socket.on('disconnect', () => {
        console.log(`🔌 Déconnecté: ${socket.id}`);
        
        // Notifier les autres
        socket.to(roomId).emit('user-disconnected', socket.id);
        
        // Cleanup
        if (room && room.peers) {
          const peer = room.peers.get(socket.id);
          if (peer) {
            // Fermer tous les consumers
            for (const consumer of peer.consumers.values()) {
              consumer.close();
            }
            // Fermer tous les producers
            for (const producer of peer.producers.values()) {
              producer.close();
            }
            // Fermer les transports
            if (peer.sendTransport) peer.sendTransport.close();
            if (peer.recvTransport) peer.recvTransport.close();
            
            room.peers.delete(socket.id);
          }
          
          // Supprimer la room si vide
          if (room.peers.size === 0) {
            rooms.delete(roomId);
            console.log(`🗑️ Room supprimée: ${roomId}`);
          }
        }
      });

      // Callback pour confirmer le join
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

  // === PING/PONG pour keep-alive ===
  socket.on('ping', () => socket.emit('pong'));
});

// Démarrage serveur
async function startServer() {
  await initMediasoup();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Serveur prêt sur http://localhost:${PORT}`);
    console.log(`📡 Ports RTC: 40000-49999`);
  });
}

startServer().catch(console.error);