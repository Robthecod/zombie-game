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

// Game tuning constants
const MAX_ZOMBIES = 5;
const MAX_POWERUPS = 6;
const CATCH_RADIUS_M = 10;
const POWERUP_RANGE_M = 25; // hint bounce + tap-to-collect radius (needs headroom for GPS jitter)
const BOMB_RADIUS_M = 50;
const METERS_PER_DEG_LAT = 111320;

const LOCATION_ERROR_MESSAGES = {
  1: 'Location permission denied — enable it for the game',
  2: 'Position unavailable — move somewhere with open sky',
  3: 'Location request timed out — still trying…',
};

const metersPerDegLng = (lat) =>
  Math.max(1, Math.cos((lat * Math.PI) / 180) * METERS_PER_DEG_LAT);

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

// Custom powerup icon (click handling is bound on the Marker itself —
// L.DivIcon has no eventHandlers option, it would be silently ignored)
const createPowerupIcon = (color, label, inRange) => new L.DivIcon({
  className: 'powerup-marker',
  html: `<div class="powerup-icon ${inRange ? 'in-range' : ''}" style="background: ${color}20; color: ${color};">${label}</div>`,
  iconSize: [40, 40],
  iconAnchor: [20, 20],
});

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

// Spawn a zombie on a ring 150–300m away. `angleRad` biases the spawn
// (e.g. behind a moving player) so runners don't plow into fresh spawns.
function spawnZombie(playerLat, playerLng, angleRad) {
  const id = `z_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const angle =
    angleRad != null ? angleRad + (Math.random() - 0.5) * 0.7 : Math.random() * Math.PI * 2;
  const dist = 150 + Math.random() * 150;
  return {
    id,
    lat: playerLat + (Math.cos(angle) * dist) / METERS_PER_DEG_LAT,
    lng: playerLng + (Math.sin(angle) * dist) / metersPerDegLng(playerLat),
    // Meters per 200ms tick → 1.2–2.2 m/s. Slower than a running human
    // (running escapes) but faster than walking — standing still is death.
    speedMPerTick: 0.24 + Math.random() * 0.2,
  };
}

// Spawn a powerup 40–120m away, biased ahead of movement (±20°) so walkers
// actually pass through pickup range
function spawnPowerup(playerLat, playerLng, angleRad) {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const id = `pu_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const angle =
    angleRad != null ? angleRad + (Math.random() - 0.5) * 0.7 : Math.random() * Math.PI * 2;
  const dist = 40 + Math.random() * 80;
  return {
    id,
    lat: playerLat + (Math.cos(angle) * dist) / METERS_PER_DEG_LAT,
    lng: playerLng + (Math.sin(angle) * dist) / metersPerDegLng(playerLat),
    type: type.type,
    label: type.label,
    color: type.color,
    effect: type.effect,
    spawnTime: Date.now(),
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
  const [locationDenied, setLocationDenied] = useState(null);
  const [gameOver, setGameOver] = useState(false);
  const [survivalTime, setSurvivalTime] = useState(0);
  const [score, setScore] = useState(0);
  const [nearbyZombieCount, setNearbyZombieCount] = useState(0);
  const [gpsWaiting, setGpsWaiting] = useState(false);

  const watchIdRef = useRef(null);
  const mapCenteredRef = useRef(false);
  const lastFixRef = useRef(null);
  const timerRef = useRef(null);
  const gameLoopRef = useRef(null);
  const effectTimerRef = useRef(null);
  const zombieSpawnTimerRef = useRef(null);
  const powerupSpawnTimerRef = useRef(null);

  // Refs are the source of truth for the game loop, so interval callbacks
  // can never read stale state. State below mirrors them for rendering.
  const playerPosRef = useRef(null);
  const aliveRef = useRef(true);
  const effectRef = useRef(null);
  const zombiesRef = useRef([]);
  const powerupsRef = useRef([]);
  const headingRef = useRef(Math.random() * Math.PI * 2); // radians, from GPS deltas
  const speedRef = useRef(0); // m/s, from GPS deltas
  const POWERUP_TTL_MS = 60000; // uncollected powerups vanish after 60s

  const setEffectTracked = useCallback((data) => {
    effectRef.current = data;
    setEffect(data);
  }, []);

  // Show an effect indicator; timed effects auto-expire
  const applyEffect = useCallback((data) => {
    setEffectTracked(data);
    if (effectTimerRef.current) clearTimeout(effectTimerRef.current);
    if (data && data.duration) {
      effectTimerRef.current = setTimeout(() => setEffectTracked(null), data.duration);
    }
  }, [setEffectTracked]);

  const stopLocationWatch = () => {
    if (watchIdRef.current !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const stopTimers = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (gameLoopRef.current) clearInterval(gameLoopRef.current);
    if (zombieSpawnTimerRef.current) clearInterval(zombieSpawnTimerRef.current);
    if (powerupSpawnTimerRef.current) clearInterval(powerupSpawnTimerRef.current);
    timerRef.current = null;
    gameLoopRef.current = null;
    zombieSpawnTimerRef.current = null;
    powerupSpawnTimerRef.current = null;
  };

  const updateZombies = useCallback((next) => {
    zombiesRef.current = next;
    setZombies(next);
  }, []);

  const updatePowerups = useCallback((next) => {
    powerupsRef.current = next;
    setPowerups(next);
  }, []);

  // Game loop — move zombies toward the player, check catches.
  // All reads/writes go through refs: no stale closures, no impure updaters.
  const gameLoop = useCallback(() => {
    const pos = playerPosRef.current;
    if (!pos || !aliveRef.current) return;

    const speedMultiplier = effectRef.current?.speedMultiplier || 1;
    const shielded = !!effectRef.current?.shielded;

    const moved = zombiesRef.current.map((z) => {
      const dLng = pos.lng - z.lng;
      const dLat = pos.lat - z.lat;
      const angle = Math.atan2(dLng, dLat);
      return {
        ...z,
        lat: z.lat + (Math.cos(angle) * z.speedMPerTick * speedMultiplier) / METERS_PER_DEG_LAT,
        lng: z.lng + (Math.sin(angle) * z.speedMPerTick * speedMultiplier) / metersPerDegLng(z.lat),
      };
    });

    if (!shielded) {
      for (const z of moved) {
        if (getDistance(z.lat, z.lng, pos.lat, pos.lng) < CATCH_RADIUS_M) {
          aliveRef.current = false;
          setAlive(false);
          setGameOver(true);
          updateZombies(moved); // show final zombie positions
          stopTimers();
          return;
        }
      }
    }

    updateZombies(moved);
  }, [updateZombies]);

  // Collect powerup (tap the icon on the map, or walk-over via checkLoop).
  // Defined above checkLoop so it can be listed in its deps without a TDZ error.
  const handleCollect = (powerup) => {
    if (!aliveRef.current) return; // no collecting while dead
    const pos = playerPosRef.current;
    // Must actually be near it — prevents zoom-out-and-tap-cheese
    if (!pos || getDistance(powerup.lat, powerup.lng, pos.lat, pos.lng) > POWERUP_RANGE_M) return;
    updatePowerups(powerupsRef.current.filter((p) => p.id !== powerup.id));
    setInventory((prev) => [...prev, powerup]);
    setInRangePowerup(null);
  };

  // Secondary checks — nearby count, powerup pickup range, powerup expiry
  const checkLoop = useCallback(() => {
    const pos = playerPosRef.current;
    if (!pos || !aliveRef.current) return;

    setNearbyZombieCount(
      zombiesRef.current.filter((z) => getDistance(z.lat, z.lng, pos.lat, pos.lng) < 50).length
    );

    let inRange = null;
    const now = Date.now();
    let expired = false;
    for (const pu of powerupsRef.current) {
      if (now - (pu.spawnTime || now) > POWERUP_TTL_MS) { expired = true; continue; }
      if (!inRange && getDistance(pu.lat, pu.lng, pos.lat, pos.lng) < POWERUP_RANGE_M) {
        inRange = pu;
      }
    }
    if (expired) {
      updatePowerups(powerupsRef.current.filter((pu) => now - (pu.spawnTime || now) <= POWERUP_TTL_MS));
    }
    // Walk-over pickup: reaching a powerup collects it automatically
    // (the README's intended design — tap remains as a fallback)
    if (inRange) handleCollect(inRange);
    else setInRangePowerup(inRange);
  }, [updatePowerups, handleCollect]);

  const startTimers = () => {
    stopTimers();

    // Survival timer + score (per second)
    timerRef.current = setInterval(() => {
      setSurvivalTime((t) => t + 1);
      setScore((s) => s + 1);
    }, 1000);

    // Game loops
    gameLoopRef.current = setInterval(() => {
      gameLoop();
      checkLoop();
    }, 200);

    // Spawn zombies periodically. Moving fast → spawn strictly behind the
    // runner (running forward must be a valid escape); idle → random ring.
    zombieSpawnTimerRef.current = setInterval(() => {
      const pos = playerPosRef.current;
      if (pos && aliveRef.current && zombiesRef.current.length < MAX_ZOMBIES) {
        const moving = speedRef.current > 1.5;
        const angle = moving ? headingRef.current + Math.PI : null;
        updateZombies([...zombiesRef.current, spawnZombie(pos.lat, pos.lng, angle)]);
      }
    }, 3000);

    // Spawn powerups periodically — biased ahead of movement so they're reachable
    powerupSpawnTimerRef.current = setInterval(() => {
      const pos = playerPosRef.current;
      if (pos && aliveRef.current && powerupsRef.current.length < MAX_POWERUPS) {
        const ahead = Math.random() < 0.5;
        updatePowerups([
          ...powerupsRef.current,
          spawnPowerup(pos.lat, pos.lng, ahead ? headingRef.current : null),
        ]);
      }
    }, 8000);
  };

  // Location tracking
  const startLocationWatch = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationDenied(true);
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        const latlng = { lat: latitude, lng: longitude };

        // Track movement heading + speed from GPS deltas (used for spawn biasing)
        const prev = playerPosRef.current;
        const now = Date.now();
        if (prev) {
          // Use the real elapsed time between fixes — GPS updates don't arrive
          // on a fixed 1s cadence, and a wrong dt skews the speed estimate.
          const dtSec = lastFixRef.current ? Math.max(0.25, (now - lastFixRef.current) / 1000) : 1;
          const dLatM = (latlng.lat - prev.lat) * METERS_PER_DEG_LAT;
          const dLngM = (latlng.lng - prev.lng) * metersPerDegLng(latlng.lat);
          const distM = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
          if (distM > 0.5) {
            headingRef.current = Math.atan2(dLngM, dLatM);
            speedRef.current = distM / dtSec;
          } else {
            speedRef.current = Math.max(0, speedRef.current * 0.5); // decay when still
          }
        }
        lastFixRef.current = now;

        // Center the map on the first GPS fix that lands once the map is
        // mounted — the first fix often arrives before MapContainer exists,
        // so keying off "first fix" alone could leave the map centered on the
        // default location with your marker off-screen.
        if (mapRef.current && !mapCenteredRef.current) {
          mapCenteredRef.current = true;
          mapRef.current.setView([latitude, longitude], 16);
        }

        playerPosRef.current = latlng;
        setPlayerPos(latlng);
        setGpsWaiting(false);
        setLocationDenied(null);
      },
      (error) => {
        console.error('Geolocation error:', error.message);
        // Show a code-specific message; the watch keeps retrying (esp. timeouts)
        setLocationDenied(
          LOCATION_ERROR_MESSAGES[error.code] || `Location error: ${error.message}`
        );
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    );

    watchIdRef.current = watchId;
  }, []);

  // Start game
  const handleStart = () => {
    setGameStarted(true);
    setLocationDenied(null);
    setGpsWaiting(true);
    mapCenteredRef.current = false;
    lastFixRef.current = null;
    aliveRef.current = true;
    setAlive(true);
    setGameOver(false);
    updateZombies([]);
    updatePowerups([]);
    setInventory([]);
    setInRangePowerup(null);
    setEffectTracked(null);
    setSurvivalTime(0);
    setScore(0);
    setNearbyZombieCount(0);

    startLocationWatch();
    startTimers();
  };

  // Use powerup from inventory
  const handleUsePowerup = (powerupId) => {
    const pu = inventory.find((p) => p.id === powerupId);
    if (!pu) return;
    // While dead, only the heal powerup can be used (second chance)
    if (!aliveRef.current && pu.effect !== 'heal') return;

    setInventory((prev) => prev.filter((p) => p.id !== powerupId));

    switch (pu.effect) {
      case 'speed_boost':
        // Zombies close in faster for a burst — high risk if you use it while surrounded
        applyEffect({ type: 'speed', speedMultiplier: 2, duration: 5000 });
        break;
      case 'shield':
        // Blocks catches for 8s
        applyEffect({ type: 'shield', shielded: true, duration: 8000 });
        break;
      case 'heal': {
        // Revive after death, or refresh alive state mid-game.
        // Revival shockwave scatters zombies within 60m so you get a fair beat.
        const hpos = playerPosRef.current;
        if (hpos) {
          updateZombies(
            zombiesRef.current.filter(
              (z) => getDistance(z.lat, z.lng, hpos.lat, hpos.lng) > 60
            )
          );
        }
        aliveRef.current = true;
        setAlive(true);
        setGameOver(false);
        startTimers();
        applyEffect({ type: 'heal', duration: 2000 });
        break;
      }
      case 'bomb': {
        // Destroy zombies within 50m
        const pos = playerPosRef.current;
        if (pos) {
          updateZombies(
            zombiesRef.current.filter(
              (z) => getDistance(z.lat, z.lng, pos.lat, pos.lng) > BOMB_RADIUS_M
            )
          );
        }
        applyEffect({ type: 'bomb', duration: 1500 });
        break;
      }
      default:
        break;
    }
  };

  // Respawn
  const handleRespawn = () => {
    aliveRef.current = true;
    setAlive(true);
    setGameOver(false);
    setScore(0);
    setSurvivalTime(0);
    updateZombies([]);
    updatePowerups([]);
    setInventory([]);
    setInRangePowerup(null);
    setEffectTracked(null);
    setNearbyZombieCount(0);

    startTimers();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopTimers();
      stopLocationWatch();
      if (effectTimerRef.current) clearTimeout(effectTimerRef.current);
    };
  }, []);

  // Dev-only debug/testing hook — dead-code-eliminated from production builds
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return undefined;
    window.__zombieDebug = {
      get map() { return mapRef.current; },
      get state() {
        return {
          pos: playerPosRef.current,
          alive: aliveRef.current,
          zombies: zombiesRef.current,
          powerups: powerupsRef.current,
        };
      },
      give(effectName) {
        const t = POWERUP_TYPES.find((p) => p.effect === effectName) || POWERUP_TYPES[0];
        setInventory((prev) => [
          ...prev,
          { id: `dbg_${Date.now()}`, lat: 0, lng: 0, type: t.type, label: t.label, color: t.color, effect: t.effect },
        ]);
      },
    };
    return () => { delete window.__zombieDebug; };
  }, []);

  const inGame = gameStarted && !gameOver;
  // While dead, keep the inventory visible if the player holds a heal powerup
  const healAvailable = !alive && inventory.some((i) => i.effect === 'heal');
  const showInventory = inGame || healAvailable;

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
          icon={createPowerupIcon(pu.color, pu.label, isInRange)}
          eventHandlers={{ click: () => handleCollect(pu) }}
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
        <p className="subtitle">Survive. Collect powerups. Don't get caught.</p>
        <div className="features">
          <span>📍 Real-time GPS location</span>
          <span>🧟 Zombies chase you on the map</span>
          <span>⚡ Collect powerups to survive longer</span>
          <span>📱 Fully offline — no server needed</span>
        </div>
        <button className="btn" onClick={handleStart}>
          Start Surviving
        </button>
        {locationDenied && (
          <p style={{ color: '#ffd700', marginTop: 16, fontSize: 13 }}>
            ⚠️ {locationDenied}
          </p>
        )}
        {gpsWaiting && !locationDenied && (
          <p style={{ color: 'rgba(255,255,255,0.6)', marginTop: 16, fontSize: 13 }}>
            📡 Waiting for GPS signal…
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      {/* Map stays mounted across game-over so it never remounts */}
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
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />
          {renderMarkers()}
        </MapContainer>
      </div>

      {/* Game over overlay */}
      {gameOver && (
        <div id="game-over" className="show">
          <h2>💀 You Got Caught!</h2>
          <p className="score">{formatTime(survivalTime)}</p>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, marginBottom: 16 }}>
            survived {formatTime(survivalTime)} · {nearbyZombieCount} zombies nearby
          </p>
          <button className="btn" onClick={handleRespawn}>
            Try Again
          </button>
        </div>
      )}

      {/* HUD */}
      {inGame && (
        <div id="hud">
          <div className="hud-card">
            <div className="label">Status</div>
            <div className={`value ${alive ? 'alive' : 'dead'}`}>
              {alive ? '🟢 Alive' : '🔴 Dead'}
            </div>
          </div>
          <div className="hud-card">
            <div className="label">Score</div>
            <div className="value">{score}</div>
          </div>
          <div className="hud-card">
            <div className="label">Time</div>
            <div className="value">{formatTime(survivalTime)}</div>
          </div>
          <div className="hud-card">
            <div className="label">Zombies</div>
            <div className="value">{zombies.length}</div>
          </div>
        </div>
      )}

      {/* Effect indicator */}
      {inGame && effect && (
        <div
          id="effect-indicator"
          className={`show ${effect.type === 'speed' ? 'speed' : effect.type === 'shield' ? 'shield' : effect.type === 'bomb' ? 'bomb' : ''}`}
        >
          {effect.type === 'speed'
            ? '⚡ Speed Boost!'
            : effect.type === 'shield'
            ? '🛡️ Shielded!'
            : effect.type === 'bomb'
            ? '💣 Bomb!'
            : '❤️ Healed!'}
        </div>
      )}

      {/* Inventory panel (stays visible while dead if a heal is held) */}
      {showInventory && (
        <div
          id="inventory-panel"
          style={healAvailable ? { zIndex: 2100 } : undefined}
        >
          {inventory.length === 0 && (
            <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>
              Collect powerups to use them
            </span>
          )}
          {inventory.map((item) => (
            <div
              key={item.id}
              className="inventory-slot"
              onClick={() => handleUsePowerup(item.id)}
              title={`Use ${item.type} powerup`}
            >
              {item.label}
            </div>
          ))}
        </div>
      )}

      {/* Location status banner (denied / unavailable / timed out) */}
      {inGame && locationDenied && (
        <div id="location-banner" className="show">
          ⚠️ {locationDenied}
        </div>
      )}

      {/* Waiting-for-GPS indicator while playing */}
      {inGame && gpsWaiting && !locationDenied && (
        <div id="location-banner" className="show" style={{ background: '#4fc3f7' }}>
          📡 Waiting for GPS signal…
        </div>
      )}
    </>
  );
}

export default App;
