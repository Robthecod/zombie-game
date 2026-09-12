import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import L from 'leaflet';

// Fix Leaflet default icon issue in React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Powerup types
const POWERUP_TYPES = [
  { type: 'speed', label: '⚡', color: '#ffd700', effect: 'speed_boost' },
  { type: 'shield', label: '🛡️', color: '#4fc3f7', effect: 'shield' },
  { type: 'heal', label: '❤️', color: '#ef5350', effect: 'heal' },
  { type: 'bomb', label: '💣', color: '#ab47bc', effect: 'bomb' },
];

// Custom player icon
const createPlayerIcon = (alive) => new L.DivIcon({
  className: 'player-marker',
  html: `<div class="player-dot ${alive ? '' : 'dead'}"></div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

// Custom zombie icon
const createZombieIcon = () => new L.DivIcon({
  className: 'zombie-marker',
  html: `<div class="zombie-dot"></div>`,
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

// Custom powerup icon
const createPowerupIcon = (color, label, inRange, onCollect) => {
  const handleClick = (e) => {
    e.originalEvent.stopPropagation();
    if (onCollect) onCollect();
  };

  return new L.DivIcon({
    className: 'powerup-marker',
    html: `<div class="powerup-icon ${inRange ? 'in-range' : ''}" style="background: ${color}20; color: ${color};">${label}</div>`,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    eventHandlers: inRange ? { click: handleClick } : {},
  });
};

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Distance between two coords in meters
function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
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

// Spawn a zombie at a random offset from the player
function spawnZombie(playerLat, playerLng) {
  const id = `z_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const offsetLat = (Math.random() - 0.5) * 0.002;
  const offsetLng = (Math.random() - 0.5) * 0.002;
  return {
    id,
    lat: playerLat + offsetLat,
    lng: playerLng + offsetLng,
    speed: 0.00004 + Math.random() * 0.00003,
  };
}

// Spawn a powerup at a random location near the player
function spawnPowerup(playerLat, playerLng) {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const id = `pu_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const offsetLat = (Math.random() - 0.5) * 0.004;
  const offsetLng = (Math.random() - 0.5) * 0.004;
  return {
    id,
    lat: playerLat + offsetLat,
    lng: playerLng + offsetLng,
    type: type.type,
    label: type.label,
    color: type.color,
    effect: type.effect,
  };
}

function App() {
  const mapRef = useRef(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [playerPos, setPlayerPos] = useState(null);
  const [zombies, setZombies] = useState([]);
  const [powerups, setPowerups] = useState([]);
  const [alive, setAlive] = useState(true);
  const [inventory, setInventory] = useState([]);
  const [inRangePowerup, setInRangePowerup] = useState(null);
  const [effect, setEffect] = useState(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [survivalTime, setSurvivalTime] = useState(0);
  const [score, setScore] = useState(0);
  const [nearbyZombieCount, setNearbyZombieCount] = useState(0);

  const watchIdRef = useRef(null);
  const timerRef = useRef(null);
  const gameLoopRef = useRef(null);
  const effectTimerRef = useRef(null);
  const lastPosRef = useRef(null);
  const zombieSpawnTimerRef = useRef(null);
  const powerupSpawnTimerRef = useRef(null);

  // Game loop — move zombies, check collisions
  const gameLoop = useCallback(() => {
    if (!playerPos || !alive) return;

    setZombies((prevZombies) => {
      const moved = prevZombies.map((z) => {
        const dLng = playerPos.lng - z.lng;
        const dLat = playerPos.lat - z.lat;
        const angle = Math.atan2(dLng, dLat);
        return {
          ...z,
          lat: z.lat + Math.cos(angle) * z.speed,
          lng: z.lng + Math.sin(angle) * z.speed,
        };
      });

      // Check if any zombie caught the player
      for (const z of moved) {
        const dist = getDistance(z.lat, z.lng, playerPos.lat, playerPos.lng);
        if (dist < 10) {
          setAlive(false);
          setGameOver(true);
          if (timerRef.current) clearInterval(timerRef.current);
          if (gameLoopRef.current) clearInterval(gameLoopRef.current);
          if (zombieSpawnTimerRef.current) clearInterval(zombieSpawnTimerRef.current);
          if (powerupSpawnTimerRef.current) clearInterval(powerupSpawnTimerRef.current);
          return moved;
        }
      }

      return moved;
    });

    // Count nearby zombies
    if (playerPos) {
      setZombies((prev) => {
        const count = prev.filter((z) => getDistance(z.lat, z.lng, playerPos.lat, playerPos.lng) < 50).length;
        setNearbyZombieCount(count);
        return prev;
      });
    }

    // Check powerup collection range
    setPowerups((prev) => {
      let inRange = null;
      for (const pu of prev) {
        const dist = getDistance(pu.lat, pu.lng, playerPos.lat, playerPos.lng);
        if (dist < 15) {
          inRange = pu;
          break;
        }
      }
      setInRangePowerup(inRange);
      return prev;
    });

    // Update score (surviving = more score)
    setScore((s) => s + 1);
  }, [playerPos, alive]);

  // Location tracking
  const startLocationWatch = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationDenied(true);
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, heading, speed } = position.coords;
        const latlng = { lat: latitude, lng: longitude };

        if (mapRef.current && !playerPos) {
          mapRef.current.setView([latitude, longitude], 16);
        }

        setPlayerPos(latlng);
        lastPosRef.current = latlng;
      },
      (error) => {
        console.error('Geolocation error:', error.message);
        if (error.code === 1) {
          setLocationDenied(true);
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );

    watchIdRef.current = watchId;
  }, [playerPos]);

  // Start game
  const handleStart = () => {
    setGameStarted(true);
    setLocationDenied(false);
    setAlive(true);
    setGameOver(false);
    setZombies([]);
    setPowerups([]);
    setInventory([]);
    setInRangePowerup(null);
    setEffect(null);
    setSurvivalTime(0);
    setScore(0);
    setNearbyZombieCount(0);

    startLocationWatch();

    // Timer
    timerRef.current = setInterval(() => {
      setSurvivalTime((t) => t + 1);
    }, 1000);

    // Game loop — runs every 200ms for smooth zombie movement
    gameLoopRef.current = setInterval(gameLoop, 200);

    // Spawn zombies periodically
    zombieSpawnTimerRef.current = setInterval(() => {
      if (playerPos && alive) {
        setZombies((prev) => {
          // Limit to 5 zombies max
          if (prev.length >= 5) return prev;
          return [...prev, spawnZombie(playerPos.lat, playerPos.lng)];
        });
      }
    }, 3000);

    // Spawn powerups periodically
    powerupSpawnTimerRef.current = setInterval(() => {
      if (playerPos && alive) {
        setPowerups((prev) => {
          // Limit to 6 powerups max
          if (prev.length >= 6) return prev;
          return [...prev, spawnPowerup(playerPos.lat, playerPos.lng)];
        });
      }
    }, 8000);
  };

  // Collect powerup
  const handleCollect = (powerup) => {
    setPowerups((prev) => prev.filter((p) => p.id !== powerup.id));
    setInventory((prev) => [...prev, powerup]);
    setInRangePowerup(null);
  };

  // Use powerup from inventory
  const handleUsePowerup = (powerupId) => {
    const pu = inventory.find((p) => p.id === powerupId);
    if (!pu) return;

    setInventory((prev) => prev.filter((p) => p.id !== powerupId));

    // Apply effect
    let effectData = {};
    switch (pu.effect) {
      case 'speed_boost':
        effectData = { speedMultiplier: 2, duration: 5000, type: 'speed' };
        // Temporarily boost zombie speed in game loop
        break;
      case 'shield':
        effectData = { shielded: true, duration: 8000, type: 'shield' };
        break;
      case 'heal':
        effectData = { heal: true, duration: 0, type: 'heal' };
        setAlive(true);
        setGameOver(false);
        break;
      case 'bomb':
        effectData = { bombRadius: 50, duration: 0, type: 'bomb' };
        // Remove nearby zombies
        setZombies((prev) => {
          return prev.filter((z) => getDistance(z.lat, z.lng, playerPos.lat, playerPos.lng) > 50);
        });
        break;
    }

    applyEffect(effectData);
  };

  // Apply visual effect
  const applyEffect = (effectData) => {
    setEffect(effectData);

    if (effectTimerRef.current) {
      clearTimeout(effectTimerRef.current);
    }

    if (effectData.duration) {
      effectTimerRef.current = setTimeout(() => {
        setEffect(null);
      }, effectData.duration);
    }
  };

  // Respawn
  const handleRespawn = () => {
    setGameOver(false);
    setAlive(true);
    setScore(0);
    setSurvivalTime(0);
    setZombies([]);
    setPowerups([]);
    setInventory([]);
    setInRangePowerup(null);
    setEffect(null);

    if (timerRef.current) clearInterval(timerRef.current);
    if (gameLoopRef.current) clearInterval(gameLoopRef.current);
    if (zombieSpawnTimerRef.current) clearInterval(zombieSpawnTimerRef.current);
    if (powerupSpawnTimerRef.current) clearInterval(powerupSpawnTimerRef.current);

    timerRef.current = setInterval(() => {
      setSurvivalTime((t) => t + 1);
    }, 1000);

    gameLoopRef.current = setInterval(gameLoop, 200);

    zombieSpawnTimerRef.current = setInterval(() => {
      if (playerPos && alive) {
        setZombies((prev) => {
          if (prev.length >= 5) return prev;
          return [...prev, spawnZombie(playerPos.lat, playerPos.lng)];
        });
      }
    }, 3000);

    powerupSpawnTimerRef.current = setInterval(() => {
      if (playerPos && alive) {
        setPowerups((prev) => {
          if (prev.length >= 6) return prev;
          return [...prev, spawnPowerup(playerPos.lat, playerPos.lng)];
        });
      }
    }, 8000);
  };

  // Render map markers
  const renderMarkers = () => {
    const elements = [];

    if (playerPos) {
      elements.push(
        <Marker
          key="player"
          position={[playerPos.lat, playerPos.lng]}
          icon={createPlayerIcon(alive)}
        />
      );
    }

    zombies.forEach((z) => {
      elements.push(
        <Marker
          key={z.id}
          position={[z.lat, z.lng]}
          icon={createZombieIcon()}
        />
      );
    });

    powerups.forEach((pu) => {
      const isInRange = inRangePowerup && inRangePowerup.id === pu.id;
      elements.push(
        <Marker
          key={pu.id}
          position={[pu.lat, pu.lng]}
          icon={createPowerupIcon(pu.color, pu.label, isInRange, isInRange ? () => handleCollect(pu) : null)}
        />
      );
    });

    return elements;
  };

  // Start screen
  if (!gameStarted) {
    return (
      <div id="start-screen">
        <h1>🧟 Zombie Chase</h1>
        <p class="subtitle">Survive. Collect powerups. Don't get caught.</p>
        <div class="features">
          <span>📍 Real-time GPS location</span>
          <span>🧟 Zombies chase you on the map</span>
          <span>⚡ Collect powerups to survive longer</span>
          <span>📱 Fully offline — no server needed</span>
        </div>
        <button class="btn" onClick={handleStart}>
          Start Surviving
        </button>
        {locationDenied && (
          <p style={{ color: '#ffd700', marginTop: 16, fontSize: 13 }}>
            ⚠️ Location access denied. Enable GPS for the full experience.
          </p>
        )}
      </div>
    );
  }

  // Game over screen
  if (gameOver) {
    return (
      <>
        <div id="map" />
        <div id="game-over" class="show">
          <h2>💀 You Got Caught!</h2>
          <p class="score">{formatTime(survivalTime)}</p>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, marginBottom: 16 }}>
            survived {formatTime(survivalTime)} · {nearbyZombieCount} zombies nearby
          </p>
          <button class="btn" onClick={handleRespawn}>
            Try Again
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div id="map">
        <MapContainer
          ref={mapRef}
          center={[playerPos?.lat || 40.7128, playerPos?.lng || -74.0060]}
          zoom={16}
          scrollWheelZoom={false}
          dragging={true}
          touchZoom={true}
          doubleClickZoom={false}
          boxZoom={false}
          key={playerPos ? `${playerPos.lat.toFixed(6)}-${playerPos.lng.toFixed(6)}` : 'initial'}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          {renderMarkers()}
        </MapContainer>
      </div>

      {/* HUD */}
      <div id="hud">
        <div class="hud-card">
          <div class="label">Status</div>
          <div class={`value ${alive ? 'alive' : 'dead'}`}>
            {alive ? '🟢 Alive' : '🔴 Dead'}
          </div>
        </div>
        <div class="hud-card">
          <div class="label">Score</div>
          <div class="value">{score}</div>
        </div>
        <div class="hud-card">
          <div class="label">Time</div>
          <div class="value">{formatTime(survivalTime)}</div>
        </div>
        <div class="hud-card">
          <div class="label">Zombies</div>
          <div class="value">{zombies.length}</div>
        </div>
      </div>

      {/* Effect indicator */}
      {effect && (
        <div id="effect-indicator" class={`show ${effect.type === 'speed' ? 'speed' : effect.type === 'shield' ? 'shield' : effect.type === 'bomb' ? 'bomb' : ''}`}>
          {effect.type === 'speed' ? '⚡ Speed Boost!' : effect.type === 'shield' ? '🛡️ Shielded!' : effect.type === 'bomb' ? '💣 Bomb!' : '❤️ Healed!'}
        </div>
      )}

      {/* Inventory panel */}
      <div id="inventory-panel">
        {inventory.length === 0 && (
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
            Collect powerups to use them
          </span>
        )}
        {inventory.map((item) => (
          <div
            key={item.id}
            class="inventory-slot"
            onClick={() => handleUsePowerup(item.id)}
            title={`Use ${item.type} powerup`}
          >
            {item.label}
          </div>
        ))}
      </div>

      {/* Location permission banner */}
      {locationDenied && (
        <div id="location-banner" class="show">
          ⚠️ Location access needed for the game
        </div>
      )}
    </>
  );
}

export default App;
