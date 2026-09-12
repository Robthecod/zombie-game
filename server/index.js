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
const players = {};       // { socketId: { id, lat, lng, heading, speed, inventory, alive, ... } }
const zombies = {};       // { id: { id, lat, lng, targetId, speedMPerTick } }
const powerups = {};      // { id: { id, lat, lng, type, collectedBy } }
let zombieIdCounter = 0;
let powerupIdCounter = 0;

const TICK_MS = 500;
const CATCH_RADIUS_M = 10;
const POWERUP_RADIUS_M = 15;
const COLLECT_RADIUS_M = 25;
const BOMB_RADIUS_M = 50;
const POWERUP_SPAWN_INTERVAL = 30000; // every 30s
const POWERUP_MAX_AGE_MS = 5 * 60 * 1000; // remove uncollected powerups after 5 min
const MAX_POWERUPS = 8;
const POWERUP_TYPES = [
  { type: 'speed', label: '⚡', color: '#ffd700', effect: 'speed_boost' },
  { type: 'shield', label: '🛡️', color: '#4fc3f7', effect: 'shield' },
  { type: 'heal', label: '❤️', color: '#ef5350', effect: 'heal' },
  { type: 'bomb', label: '💣', color: '#ab47bc', effect: 'bomb' },
];

const METERS_PER_DEG_LAT = 111320;

function metersPerDegLng(lat) {
  return Math.max(1, Math.cos((lat * Math.PI) / 180) * METERS_PER_DEG_LAT);
}

function randomOffset(radiusM, lat) {
  const angle = Math.random() * Math.PI * 2;
  const dist = radiusM * (0.5 + Math.random() * 0.5);
  return {
    dLat: (Math.cos(angle) * dist) / METERS_PER_DEG_LAT,
    dLng: (Math.sin(angle) * dist) / metersPerDegLng(lat),
  };
}

// Spawn a powerup near a random online player (falls back to a default box)
function spawnPowerup() {
  const count = Object.keys(powerups).length;
  if (count >= MAX_POWERUPS) return;

  const online = Object.values(players);
  let lat, lng;
  if (online.length > 0) {
    const anchor = online[Math.floor(Math.random() * online.length)];
    const off = randomOffset(300, anchor.lat); // within ~300m of a player
    lat = anchor.lat + off.dLat;
    lng = anchor.lng + off.dLng;
  } else {
    lat = 40.7128 + (Math.random() - 0.5) * 0.05;
    lng = -74.0060 + (Math.random() - 0.5) * 0.05;
  }

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
    // Meters traveled per tick. 0.4–0.9 m per 500ms tick ≈ 0.8–1.8 m/s —
    // slower than a human, so escape is possible.
    speedMPerTick: 0.4 + Math.random() * 0.5,
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

    // Dead players are left alone — otherwise a caught player gets
    // re-caught every tick and the heal powerup can never save them.
    if (!target.alive) continue;

    const dist = getDistance(zombie.lat, zombie.lng, target.lat, target.lng);

    // If zombie reached player
    if (dist < CATCH_RADIUS_M) {
      const now = Date.now();
      if (target.shieldedUntil && target.shieldedUntil > now) {
        continue; // shield blocks the catch
      }
      target.alive = false;
      target.shieldedUntil = 0;
      io.to(zombie.targetId).emit('player_caught', { zombieId: zId });
      io.emit('player_died', { playerId: zombie.targetId });
      // Zombies that caught their meal wander off
      toRemove.push(zId);
      continue;
    }

    // Move zombie toward target (meters → degrees)
    const dLng = target.lng - zombie.lng;
    const dLat = target.lat - zombie.lat;
    const angle = Math.atan2(dLng, dLat);
    zombie.lat += (Math.cos(angle) * zombie.speedMPerTick) / METERS_PER_DEG_LAT;
    zombie.lng += (Math.sin(angle) * zombie.speedMPerTick) / metersPerDegLng(zombie.lat);
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

// Remove stale uncollected powerups so the map doesn't fill up with far-away pickups
function cleanupPowerups() {
  const now = Date.now();
  for (const [puId, pu] of Object.entries(powerups)) {
    if (!pu.collectedBy && now - pu.spawnTime > POWERUP_MAX_AGE_MS) {
      delete powerups[puId];
      io.emit('powerup_removed', { powerupId: puId });
    }
  }
}

// Tick every 500ms
setInterval(gameTick, TICK_MS);
setInterval(spawnPowerup, POWERUP_SPAWN_INTERVAL);
setInterval(cleanupPowerups, 60000);

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
    shieldedUntil: 0,
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
    if (!player || !data || typeof data.lat !== 'number' || typeof data.lng !== 'number') return;

    player.lat = data.lat;
    player.lng = data.lng;
    player.heading = data.heading || 0;
    player.speed = data.speed || 0;

    // Spawn a zombie if we have few active
    const activeZombies = Object.values(zombies).filter(z => z.targetId === socket.id).length;
    if (activeZombies < 2 && player.alive) {
      spawnZombie(socket.id);
    }

    // Check powerup collection
    if (player.alive) {
      for (const pu of Object.values(powerups)) {
        if (pu.collectedBy) continue;
        const dist = getDistance(player.lat, player.lng, pu.lat, pu.lng);
        if (dist < POWERUP_RADIUS_M) {
          // Powerup is in range — notify client to show it
          socket.emit('powerup_in_range', pu);
        }
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
    if (dist > COLLECT_RADIUS_M) {
      socket.emit('error', { message: 'Too far from powerup' });
      return;
    }

    pu.collectedBy = socket.id;
    delete powerups[data.powerupId];
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
    if (!player) return;

    const idx = player.inventory.findIndex(p => p.id === data.powerupId);
    if (idx === -1) return;

    const pu = player.inventory[idx];

    // While dead, only the heal powerup can be used — spending a shield or
    // bomb from the grave does nothing and would waste it.
    if (!player.alive && pu.effect !== 'heal') return;

    // Apply the effect first; only consume the item once it actually did
    // something (an unknown effect used to eat the powerup with no benefit).
    let effectData = {};
    let consumed = true;
    switch (pu.effect) {
      case 'speed_boost':
        effectData = { speedMultiplier: 2, duration: 5000 };
        break;
      case 'shield':
        effectData = { shielded: true, duration: 8000 };
        player.shieldedUntil = Date.now() + 8000;
        break;
      case 'heal':
        effectData = { alive: true };
        player.alive = true;
        // Revival shockwave: zombies frozen right on top of the revived player
        // would re-catch them within one tick, making the heal useless.
        for (const [zId, zombie] of Object.entries(zombies)) {
          const dist = getDistance(player.lat, player.lng, zombie.lat, zombie.lng);
          if (dist < 60) {
            delete zombies[zId];
          }
        }
        break;
      case 'bomb':
        effectData = { bombRadius: BOMB_RADIUS_M };
        // Kill nearby zombies
        for (const [zId, zombie] of Object.entries(zombies)) {
          const dist = getDistance(player.lat, player.lng, zombie.lat, zombie.lng);
          if (dist < BOMB_RADIUS_M) {
            delete zombies[zId];
          }
        }
        break;
      default:
        consumed = false;
        break;
    }

    if (!consumed) return;

    player.inventory.splice(idx, 1);

    io.to(socket.id).emit('powerup_used', { powerup: pu, effect: effectData });
    io.emit('powerup_used_broadcast', { playerId: socket.id, powerup: pu, effect: effectData });
  });

  // Player respawn — revive, reset score, and clear zombies so you get a fair restart
  socket.on('respawn', () => {
    const player = players[socket.id];
    if (player) {
      player.alive = true;
      player.score = 0;
      player.shieldedUntil = Date.now() + 3000; // brief grace period
      for (const [zId, zombie] of Object.entries(zombies)) {
        if (zombie.targetId === socket.id) {
          delete zombies[zId];
        }
      }
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
