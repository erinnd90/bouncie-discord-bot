import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const BOUNCIE_WEBHOOK_KEY = process.env.BOUNCIE_WEBHOOK_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;

const TECHNICIANS = {
  "866392060619172": "Silverado",
  "866392060612052": "Frontier",
  "865612071225938": "F150"};

// --- Geocoding ---
async function geocodeAddress(address) {
  const encoded = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": "bouncie-discord-bot" },
  });
  const data = await res.json();
  if (data && data.length > 0) {
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  }
  return null;
}

// --- Load customers from Airtable ---
let customerLocations = [];

async function loadCustomers() {
  console.log("Loading customers from Airtable...");
  const locations = [];
  let offset = null;

  do {
    const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/Clients`);
    url.searchParams.set("filterByFormula", "{Active}=1");
    url.searchParams.set("fields[]", "Full Name");
    url.searchParams.append("fields[]", "Address");
    url.searchParams.append("fields[]", "City");
    if (offset) url.searchParams.set("offset", offset);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` },
    });
    const data = await res.json();

    for (const record of data.records || []) {
      const name = record.fields["Full Name"];
      const address = record.fields["Address"];
      const city = record.fields["City"];
      if (!name || !address || !city) continue;

      const fullAddress = `${address}, ${city}, TX`;
      const coords = await geocodeAddress(fullAddress);

      if (coords) {
        locations.push({
          name,
          address: fullAddress,
          lat: coords.lat,
          lon: coords.lon,
          radiusMeters: 150,
        });
        console.log(`✅ Geocoded: ${name} → ${fullAddress}`);
      } else {
        console.warn(`⚠️ Could not geocode: ${fullAddress}`);
      }

      // Nominatim rate limit — 1 request per second
      await new Promise((r) => setTimeout(r, 1100));
    }

    offset = data.offset;
  } while (offset);

  customerLocations = locations;
  console.log(`✅ Loaded ${customerLocations.length} customer locations.`);
}

// --- Geofence ---
function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function checkGeofence(lat, lon) {
  for (const location of customerLocations) {
    const dist = getDistanceMeters(lat, lon, location.lat, location.lon);
    if (dist <= location.radiusMeters) return location;
  }
  return null;
}

// --- Discord Alert ---
async function sendDiscordAlert(technician, location, lat, lon, timestamp) {
  const googleMapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const time = new Date(timestamp).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });

  const payload = {
    embeds: [
      {
        title: "🏠 Technician Arrived at Customer Home",
        description: `**${technician}** has arrived at a customer location.`,
        color: 0x2ecc71,
        fields: [
          { name: "👷 Technician", value: technician, inline: true },
          { name: "👤 Customer", value: location.name, inline: true },
          { name: "📍 Address", value: location.address, inline: false },
          { name: "🕐 Arrival Time (CST)", value: time, inline: true },
          { name: "🗺️ Live Location", value: `[Open in Google Maps](${googleMapsLink})`, inline: true },
        ],
        footer: { text: "Bouncie Fleet Tracker" },
        timestamp: new Date(timestamp).toISOString(),
      },
    ],
  };

  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("Discord webhook failed:", res.status, await res.text());
  } else {
    console.log(`✅ Discord notified: ${technician} → ${location.name}`);
  }
}

// --- Arrival Deduplication ---
const arrivedState = {};

// --- Bouncie Webhook ---
app.post("/bouncie", async (req, res) => {
  res.sendStatus(200);

  const receivedKey = req.headers["x-webhook-key"] || req.body.webhookKey;
  if (receivedKey !== BOUNCIE_WEBHOOK_KEY) return;

  const event = req.body;
  if (event.eventType !== "tripData") return;

  const { imei, data } = event;
  const { lat, lon, timestamp } = data.gps || data;
  if (!lat || !lon) return;

  const technician = TECHNICIANS[imei] || `Vehicle ${imei}`;
  const matchedLocation = checkGeofence(lat, lon);

  if (matchedLocation) {
    const stateKey = `${imei}:${matchedLocation.name}`;
    if (!arrivedState[stateKey]) {
      arrivedState[stateKey] = true;
      await sendDiscordAlert(technician, matchedLocation, lat, lon, timestamp);
    }
  } else {
    Object.keys(arrivedState).forEach((key) => {
      if (key.startsWith(`${imei}:`)) delete arrivedState[key];
    });
  }
});

// --- Start ---
loadCustomers().then(() => {
  // Refresh customer list every 10 minutes
  setInterval(loadCustomers, 10 * 60 * 1000);
});

app.listen(3000, () => console.log("Bouncie webhook listener running on :3000"));
