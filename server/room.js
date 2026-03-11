const { createRouter } = require('./mediasoup');

const rooms = new Map(); // roomId -> { router, peers: Map }

exports.getOrCreateRoom = async (worker, roomId) => {
  if (!rooms.has(roomId)) {
    const router = await createRouter(worker);
    rooms.set(roomId, { router, peers: new Map() });
    console.log(`✅ Room created: ${roomId}`);
  }
  return rooms.get(roomId);
};

exports.getRoom = (roomId) => rooms.get(roomId);

exports.addPeer = (roomId, peerId, peerData) => {
  const room = rooms.get(roomId);
  if (room) {
    room.peers.set(peerId, peerData);
  }
};

exports.removePeer = (roomId, peerId) => {
  const room = rooms.get(roomId);
  if (room) {
    room.peers.delete(peerId);
  }
};

exports.getPeers = (roomId) => {
  const room = rooms.get(roomId);
  return room ? Array.from(room.peers.keys()) : [];
};