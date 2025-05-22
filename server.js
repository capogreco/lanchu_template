import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.190.0/http/file_server.ts";

const PORT = 8000;
const PUBLIC_DIR_PATH = "./public"; // Relative to where server.js is

let kv;
try {
  kv = await Deno.openKv();
  console.log("Deno KV store opened successfully.");
} catch (error) {
  console.error("Failed to open Deno KV store:", error);
  console.warn(
    "Signaling will not work. Ensure Deno KV is enabled and permissions are correct.",
  );
  console.warn(
    "Run with: deno run --allow-net --allow-read --allow-write --unstable server.js",
  );
  // Deno.exit(1); // Optionally exit if KV is critical and not available
}

async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  console.log(`${method} ${pathname}`);

  // Signaling endpoint
  if (pathname === "/signal" && kv) {
    const room = url.searchParams.get("room") || "default-room";
    const type = url.searchParams.get("type"); // e.g., 'offer', 'answer', 'candidate_initiator', 'candidate_receiver'

    if (!room) {
      return new Response("Missing 'room' query parameter", { status: 400 });
    }

    if (method === "POST") {
      try {
        const signal = await req.json(); // Expects { type, payload }
        if (!signal.type || !signal.payload) {
          return new Response(
            "Invalid signal data. Expected { type, payload }.",
            { status: 400 },
          );
        }
        // Store the payload under a key that includes the room and the specific signal type
        // This allows multiple signal types (offer, answer, candidates) per room.
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
          // Return the payload directly, wrapped in the expected { type, payload } structure
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
    const response = await serveDir(req, {
      fsRoot: publicDirPath,
      urlRoot: "", // Serve from the root of the domain
      showDirListing: true, // Optional: for debugging
      enableCors: true, // Optional: enable CORS if needed
    });
    return response;
  } catch (error) {
    console.error(`Error serving static file ${pathname}:`, error);
    // Basic error response, can be enhanced
    if (error instanceof Deno.errors.NotFound) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response("Internal Server Error", { status: 500 });
  }
}

console.log(`HTTP server running. Access it at: http://localhost:${PORT}/`);
await serve(handler, { port: PORT });
