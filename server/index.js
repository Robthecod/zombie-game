const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Game state
const players = {};       // { socketId: { id, lat, lng, heading, speed, inventory, ... } }
const zombies = {};       // { id: { id, lat, lng, targetId, speed } }
const powerups = {};      // { id: { id, lat, lng, type, collectedBy } }
let zombieIdCounter = 0;
let powerupIdCounter = 0;

// Spawn powerups periodically
const POWERUP_SPAWN_INTERVAL = 30000; // every 30s
const MAX_POWERUPS = 8;
const POWERUP_TYPES = [
  { type: 'speed', label: '⚡', color: '#ffd700', effect: 'speed_boost' },
  { type: 'shield', label: '🛡️', color: '#4fc3f7', effect: 'shield' },
  { type: 'heal', label: '❤️', color: '#ef5350', effect: 'heal' },
  { type: 'bomb', label: '💣', color: '#ab47bc', effect: 'bomb' },
];

function spawnPowerup() {
  const count = Object.keys(powerups).length;
  if (count >= MAX_POWERUPS) return;

  // Random lat/lng within a rough bounding box (adjust for your area)
  const lat = 40.7128 + (Math.random() - 0.5) * 0.05; // ~5km box around NYC — change as needed
  const lng = -74.0060 + (Math.random() - 0.5) * 0.05;

  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const id = `pu_${++powerupIdCounter}`;

  powerups[id] = {
    id,
    lat,
    lng,
    type: type.type,
    label: type.label,
    color: type.color,
    effect: type.effect,
    collectedBy: null,
    spawnTime: Date.now(),
  };

  // Notify all clients
  io.emit('powerup_spawned', powerups[id]);
}

// Spawn a zombie near a target player
function spawnZombie(targetId) {
  const target = players[targetId];
  if (!target) return null;

  const id = `z_${++zombieIdCounter}`;

  // Spawn ~200m away from target
  const offsetLat = (Math.random() - 0.5) * 0.002;
  const offsetLng = (Math.random() - 0.5) * 0.002;

  zombies[id] = {
    id,
    lat: target.lat + offsetLat,
    lng: target.lng + offsetLng,
    targetId,
    speed: 0.00005 + Math.random() * 0.00003, // meters per tick approx
  };

  io.emit('zombie_spawned', zombies[id]);
  return zombies[id];
}

// Compute distance between two coords (approx meters)
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Game tick: move zombies toward targets
function gameTick() {
  const toRemove = [];

  for (const [zId, zombie] of Object.entries(zombies)) {
    const target = players[zombie.targetId];
    if (!target) {
      toRemove.push(zId);
      continue;
    }

    const dist = getDistance(zombie.lat, zombie.lng, target.lat, target.lng);

    // If zombie reached player
    if (dist < 10) {
      // Notify player they were caught
      io.to(zombie.targetId).emit('player_caught', { zombieId: zId });
      toRemove.push(zId);
      continue;
    }

    // Move zombie toward target
    const dLng = target.lng - zombie.lng;
    const dLat = target.lat - zombie.lat;
    const angle = Math.atan2(dLng, dLat);
    zombie.lat += Math.cos(angle) * zombie.speed;
    zombie.lng += Math.sin(angle) * zombie.speed;
  }

  // Clean up removed zombies
  for (const zId of toRemove) {
    delete zombies[zId];
  }

  // Broadcast zombie positions
  if (Object.keys(zombies).length > 0) {
    io.emit('zombies_move', Object.values(zombies));
  }
}

// Tick every 500ms
setInterval(gameTick, 500);
setInterval(spawnPowerup, POWERUP_SPAWN_INTERVAL);

// Start with a couple powerups
spawnPowerup();
spawnPowerup();

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // Register player
  players[socket.id] = {
    id: socket.id,
    lat: 40.7128,
    lng: -74.0060,
    heading: 0,
    speed: 0,
    inventory: [],
    alive: true,
    score: 0,
  };

  // Send current game state to new player
  socket.emit('game_state', {
    playerId: socket.id,
    zombies: Object.values(zombies),
    powerups: Object.values(powerups),
    players: Object.values(players),
  });

  // Update player location
  socket.on('location_update', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) return;

    player.lat = data.lat;
    player.lng = data.lng;
    player.heading = data.heading || 0;
    player.speed = data.speed || 0;

    // Spawn a zombie if we have few active
    const activeZombies = Object.values(zombies).filter(z => z.targetId === socket.id).length;
    if (activeZombies < 2) {
      spawnZombie(socket.id);
    }

    // Check powerup collection
    for (const [puId, pu] of Object.entries(powerups)) {
      if (pu.collectedBy) continue;
      const dist = getDistance(player.lat, player.lng, pu.lat, pu.lng);
      if (dist < 15) {
        // Powerup is in range — notify client to show it
        socket.emit('powerup_in_range', pu);
      }
    }
  });

  // Collect powerup (client taps logo)
  socket.on('collect_powerup', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) return;

    const pu = powerups[data.powerupId];
    if (!pu || pu.collectedBy) return;

    const dist = getDistance(player.lat, player.lng, pu.lat, pu.lng);
    if (dist > 20) {
      socket.emit('error', { message: 'Too far from powerup' });
      return;
    }

    pu.collectedBy = socket.id;
    player.inventory.push(pu);

    io.emit('powerup_collected', {
      powerupId: data.powerupId,
      collectedBy: socket.id,
      playerInventory: player.inventory,
    });
  });

  // Use powerup
  socket.on('use_powerup', (data) => {
    const player = players[socket.id];
    if (!player || !player.alive) return;

    const idx = player.inventory.findIndex(p => p.id === data.powerupId);
    if (idx === -1) return;

    const pu = player.inventory[idx];
    player.inventory.splice(idx, 1);

    // Apply effect
    let effectData = {};
    switch (pu.effect) {
      case 'speed_boost':
        effectData = { speedMultiplier: 2, duration: 5000 };
        break;
      case 'shield':
        effectData = { shielded: true, duration: 8000 };
        break;
      case 'heal':
        effectData = { alive: true };
        player.alive = true;
        break;
      case 'bomb':
        effectData = { bombRadius: 50 };
        // Kill nearby zombies
        for (const [zId, zombie] of Object.entries(zombies)) {
          const dist = getDistance(player.lat, player.lng, zombie.lat, zombie.lng);
          if (dist < 50) {
            delete zombies[zId];
          }
        }
        break;
    }

    io.to(socket.id).emit('powerup_used', { powerup: pu, effect: effectData });
    io.emit('powerup_used_broadcast', { playerId: socket.id, powerup: pu, effect: effectData });
  });

  // Player died / respawn
  socket.on('respawn', () => {
    const player = players[socket.id];
    if (player) {
      player.alive = true;
      player.score = 0;
      io.to(socket.id).emit('player_respawned', { lat: player.lat, lng: player.lng });
    }
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    delete players[socket.id];
    // Remove zombies targeting this player
    for (const [zId, zombie] of Object.entries(zombies)) {
      if (zombie.targetId === socket.id) {
        delete zombies[zId];
      }
    }
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    players: Object.keys(players).length,
    zombies: Object.keys(zombies).length,
    powerups: Object.keys(powerups).length,
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
