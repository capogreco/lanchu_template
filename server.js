import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.190.0/http/file_server.ts";
import { load } from "jsr:@std/dotenv";

const PORT = 8000;
const PUBLIC_DIR_PATH = "./public"; // Relative to where server.js is

let kv;
let twilioAccountSid;
let twilioAuthToken;

try {
  // Load environment variables from .env file
  await load({ export: true }); // Exports to Deno.env
  twilioAccountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
  twilioAuthToken = Deno.env.get("TWILIO_AUTH_TOKEN");

  if (!twilioAccountSid || !twilioAuthToken) {
    console.warn(
      "Twilio credentials (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) not found in .env file. TURN server functionality will be disabled.",
    );
  } else {
    console.log("Twilio credentials loaded successfully.");
  }

  kv = await Deno.openKv();
  console.log("Deno KV store opened successfully.");
} catch (error) {
  console.error("Failed during initial setup (Deno KV or Env Vars):", error);
  if (error.name === "PermissionDenied") {
    console.warn(
      "Ensure Deno has correct permissions. Run with: deno run --allow-net --allow-read --allow-write --allow-env --unstable-kv server.js",
    );
  } else {
    console.warn(
      "Signaling or TURN services might not work. Ensure Deno KV is enabled and .env file is present with correct permissions.",
    );
  }
}

async function fetchTwilioIceServers() {
  if (!twilioAccountSid || !twilioAuthToken) {
    console.log(
      "Twilio credentials not available, returning only public STUN.",
    );
    return [{ urls: "stun:stun.l.google.com:19302" }]; // Fallback or default
  }

  const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Tokens.json`;
  try {
    const response = await fetch(twilioApiUrl, {
      method: "POST",
      headers: {
        Authorization:
          "Basic " + btoa(`${twilioAccountSid}:${twilioAuthToken}`),
      },
      // Optionally, you can specify a TTL for the token, e.g., body: "Ttl=3600" for 1 hour
    });

    if (!response.ok) {
      console.error(
        `Failed to fetch ICE servers from Twilio: ${response.status} ${await response.text()}`,
      );
      return [{ urls: "stun:stun.l.google.com:19302" }]; // Fallback
    }

    const data = await response.json();
    // console.log("Twilio API response:", data); // For debugging
    // Twilio's response directly contains an ice_servers array.
    // Filter out any non-WebRTC useful servers if necessary, though Twilio's are usually fine.
    // Also add Google's STUN server as a common practice, though Twilio's list might already include STUN.
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      ...data.ice_servers,
    ];
    console.log(
      "Fetched ICE servers from Twilio:",
      iceServers.map((s) => s.urls),
    );
    return iceServers;
  } catch (error) {
    console.error("Error fetching ICE servers from Twilio:", error);
    return [{ urls: "stun:stun.l.google.com:19302" }]; // Fallback in case of network error
  }
}

async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  console.log(`${method} ${pathname}`);

  // New endpoint for ICE servers
  if (pathname === "/api/ice-servers" && method === "GET") {
    try {
      const iceServers = await fetchTwilioIceServers();
      return new Response(JSON.stringify(iceServers), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Error providing ICE servers:", error);
      return new Response("Error fetching ICE server configuration", {
        status: 500,
      });
    }
  }

  // Signaling endpoint
  if (pathname === "/signal" && kv) {
    const room = url.searchParams.get("room") || "default-room";
    const type = url.searchParams.get("type");

    if (!room) {
      return new Response("Missing 'room' query parameter", { status: 400 });
    }

    if (method === "POST") {
      try {
        const signal = await req.json();
        if (!signal.type || !signal.payload) {
          return new Response(
            "Invalid signal data. Expected { type, payload }.",
            { status: 400 },
          );
        }
        // Add server-side logging for candidate payloads
        if (signal.type.startsWith("candidate_")) {
          console.log(`Storing candidate. Type: ${signal.type}, Payload: ${JSON.stringify(signal.payload)}`);
        }
        await kv.set(["webrtc_signal", room, signal.type], signal.payload);
        console.log(`Stored signal for room '${room}', type '${signal.type}'`);
        return new Response(JSON.stringify({ message: "Signal stored" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Error processing POST /signal:", error);
        return new Response("Error storing signal: " + error.message, {
          status: 500,
        });
      }
    } else if (method === "GET") {
      if (!type) {
        return new Response("Missing 'type' query parameter for GET request", {
          status: 400,
        });
      }
      try {
        const kvEntry = await kv.get(["webrtc_signal", room, type]);
        if (kvEntry && kvEntry.value !== null) {
          console.log(`Retrieved signal for room '${room}', type '${type}'`);
          return new Response(
            JSON.stringify({ type: type, payload: kvEntry.value }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } else {
          console.log(`No signal found for room '${room}', type '${type}'`);
          return new Response(JSON.stringify(null), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
      } catch (error) {
        console.error("Error processing GET /signal:", error);
        return new Response("Error retrieving signal: " + error.message, {
          status: 500,
        });
      }
    } else if (method === "DELETE") {
      if (!type) {
        return new Response(
          "Missing 'type' query parameter for DELETE request",
          { status: 400 },
        );
      }
      try {
        await kv.delete(["webrtc_signal", room, type]);
        console.log(`Deleted signal for room '${room}', type '${type}'`);
        return new Response(
          JSON.stringify({ message: `Signal type '${type}' deleted` }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      } catch (error) {
        console.error("Error processing DELETE /signal:", error);
        return new Response("Error deleting signal: " + error.message, {
          status: 500,
        });
      }
    } else {
      return new Response("Method not allowed for /signal", { status: 405 });
    }
  } else if (pathname === "/signal" && !kv) {
    return new Response(
      "Signaling service unavailable: Deno KV not initialized.",
      { status: 503 },
    );
  }

  // Serve static files from the public directory
  try {
    const publicDirPath = Deno.realPathSync(PUBLIC_DIR_PATH);
    return await serveDir(req, {
      fsRoot: publicDirPath,
      urlRoot: "",
      showDirListing: true,
      enableCors: true,
    });
  } catch (error) {
    console.error(`Error serving static file ${pathname}:`, error);
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Internal Server Error", { status: 500 });
  }
}

console.log(`HTTP server running. Access it at: http://localhost:${PORT}/`);
await serve(handler, { port: PORT });
