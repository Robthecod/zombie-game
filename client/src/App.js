import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import io from 'socket.io-client';

// Fix Leaflet default icon issue in React
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

const SOCKET_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:3001';

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

function App() {
  const mapRef = useRef(null);
  const socketRef = useRef(null);
  const [gameStarted, setGameStarted] = useState(false);
  const [playerPos, setPlayerPos] = useState(null);
  const [zombies, setZombies] = useState([]);
  const [powerups, setPowerups] = useState([]);
  const [alive, setAlive] = useState(true);
  const [score, setScore] = useState(0);
  const [inventory, setInventory] = useState([]);
  const [inRangePowerup, setInRangePowerup] = useState(null);
  const [effect, setEffect] = useState(null);
  const [locationDenied, setLocationDenied] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [survivalTime, setSurvivalTime] = useState(0);

  const watchIdRef = useRef(null);
  const timerRef = useRef(null);
  const lastPosRef = useRef(null);
  const effectTimerRef = useRef(null);

  // Socket connection
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
    });
    socketRef.current = socket;

    socket.on('game_state', (state) => {
      setZombies(state.zombies || []);
      setPowerups(state.powerups || []);
    });

    socket.on('zombies_move', (updated) => {
      setZombies(updated);
    });

    socket.on('zombie_spawned', (zombie) => {
      setZombies(prev => [...prev, zombie]);
    });

    socket.on('powerup_spawned', (pu) => {
      setPowerups(prev => [...prev, pu]);
    });

    socket.on('powerup_in_range', (pu) => {
      setInRangePowerup(pu);
    });

    socket.on('powerup_collected', (data) => {
      if (data.collectedBy === socket.id) {
        setInventory(data.playerInventory);
        setInRangePowerup(null);
      }
    });

    socket.on('powerup_used', (data) => {
      setInventory(data.playerInventory || []);
      if (data.effect) {
        applyEffect(data.effect);
      }
    });

    socket.on('player_caught', () => {
      setAlive(false);
      setGameOver(true);
      if (timerRef.current) clearInterval(timerRef.current);
    });

    socket.on('player_respawned', () => {
      setAlive(true);
      setGameOver(false);
    });

    socket.on('error', (data) => {
      console.error('Server error:', data.message);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

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

        // Send to server
        if (socketRef.current) {
          socketRef.current.emit('location_update', {
            lat: latitude,
            lng: longitude,
            heading: heading || 0,
            speed: speed || 0,
          });
        }

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
    startLocationWatch();
    timerRef.current = setInterval(() => {
      setSurvivalTime((t) => t + 1);
    }, 1000);
  };

  // Collect powerup
  const handleCollect = (powerup) => {
    if (socketRef.current && powerup) {
      socketRef.current.emit('collect_powerup', { powerupId: powerup.id });
    }
  };

  // Use powerup from inventory
  const handleUsePowerup = (powerupId) => {
    if (socketRef.current) {
      socketRef.current.emit('use_powerup', { powerupId });
    }
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
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setSurvivalTime((t) => t + 1);
    }, 1000);
    if (socketRef.current) {
      socketRef.current.emit('respawn');
    }
  };

  // Render map markers
  const renderMarkers = () => {
    const elements = [];

    // Player
    if (playerPos) {
      elements.push(
        <Marker
          key={`player-${socketRef.current?.id || 'me'}`}
          position={[playerPos.lat, playerPos.lng]}
          icon={createPlayerIcon(alive)}
        />
      );
    }

    // Zombies
    zombies.forEach((z) => {
      elements.push(
        <Marker
          key={z.id}
          position={[z.lat, z.lng]}
          icon={createZombieIcon()}
        />
      );
    });

    // Powerups
    powerups.forEach((pu) => {
      const isInRange = inRangePowerup && inRangePowerup.id === pu.id;
      const isCollected = pu.collectedBy !== null && pu.collectedBy !== socketRef.current?.id;

      if (isCollected) return;

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
          <span>📱 Works on mobile — tap to play</span>
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
            survived {formatTime(survivalTime)}
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
        <div id="effect-indicator" class={`show ${effect.speedMultiplier ? 'speed' : effect.shielded ? 'shield' : effect.bombRadius ? 'bomb' : ''}`}>
          {effect.speedMultiplier ? '⚡ Speed Boost!' : effect.shielded ? '🛡️ Shielded!' : effect.bombRadius ? '💣 Bomb!' : '❤️ Healed!'}
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
