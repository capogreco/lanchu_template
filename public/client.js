// DOM Elements
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const startButton = document.getElementById("startButton");
const hangupButton = document.getElementById("hangupButton");
const chatLog = document.getElementById("chatLog");
const chatInput = document.getElementById("chatInput");
const sendButton = document.getElementById("sendButton");

let localStream;
let remoteStream;
let peerConnection;
let dataChannel;
let isInitiator = false;

const ROOM_ID = "default-room"; // Simple room ID for Deno KV signaling

// STUN server configuration (Google's public STUN server)
const configuration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// --- Initialization and Event Listeners ---
startButton.addEventListener("click", startSession);
hangupButton.addEventListener("click", hangUp);
sendButton.addEventListener("click", sendMessage);
chatInput.addEventListener("keypress", (event) => {
  if (event.key === "Enter" && !sendButton.disabled) {
    sendMessage();
  }
});

async function startSession() {
  console.log("Requesting local stream");
  startButton.disabled = true;
  hangupButton.disabled = false;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localVideo.srcObject = localStream;
    console.log("Received local stream");

    await createPeerConnection();

    // Attempt to fetch existing offer to decide if we are initiator
    const offerSignal = await getSignalMessage("offer"); // Fetches { type: 'offer', payload: sdp }

    if (!offerSignal || !offerSignal.payload) {
      // If no offer exists, we are the initiator
      isInitiator = true;
      console.log("I am the initiator.");
      // Create offer
      if (peerConnection) {
        const offerSdp = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offerSdp);
        await sendSignalMessage("offer", offerSdp);
        console.log("Sent offer:", offerSdp);
      }
    } else {
      // An offer exists, we are the receiver
      isInitiator = false;
      console.log("I am the receiver. Got offer:", offerSignal.payload);
      if (peerConnection) {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(offerSignal.payload),
        );
        const answerSdp = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answerSdp);
        await sendSignalMessage("answer", answerSdp);
        console.log("Sent answer:", answerSdp);
        await clearSignalMessage("offer"); // Clear the offer from the server once used
      }
    }

    pollForSignalMessages(); // Start polling for answer/candidates
  } catch (e) {
    console.error("Error starting session:", e);
    alert("Could not start session: " + e.message);
    hangUp(); // Reset UI
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(configuration);
  console.log("Created RTCPeerConnection");

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("Sending ICE candidate:", event.candidate);
      // Send candidate with role distinction
      const candidateKey = isInitiator
        ? "candidate_initiator"
        : "candidate_receiver";
      sendSignalMessage(candidateKey, event.candidate);
    }
  };

  peerConnection.ontrack = (event) => {
    console.log("Received remote track");
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteStream = event.streams[0];
      console.log("Remote stream added.");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection) {
      console.log(
        "ICE connection state change:",
        peerConnection.iceConnectionState,
      );
      if (
        peerConnection.iceConnectionState === "failed" ||
        peerConnection.iceConnectionState === "disconnected" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        // Potentially handle reconnections or notify user
      }
    }
  };

  // Add local tracks to the peer connection
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
    console.log("Added local stream to peerConnection");
  }

  // Data Channel for chat
  if (isInitiator) {
    console.log("Creating data channel as initiator");
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannelEvents(dataChannel);
  } else {
    peerConnection.ondatachannel = (event) => {
      console.log("Received data channel as receiver");
      dataChannel = event.channel;
      setupDataChannelEvents(dataChannel);
    };
  }
}

function setupDataChannelEvents(channel) {
  channel.onopen = () => {
    console.log("Data channel open");
    chatInput.disabled = false;
    sendButton.disabled = false;
    displayChatMessage("System", "Chat connected!");
  };
  channel.onclose = () => {
    console.log("Data channel closed");
    chatInput.disabled = true;
    sendButton.disabled = true;
    displayChatMessage("System", "Chat disconnected.");
  };
  channel.onmessage = (event) => {
    console.log("Message received:", event.data);
    try {
      const messageData = JSON.parse(event.data); // Assuming messages are JSON strings
      displayChatMessage(messageData.sender || "Remote", messageData.message);
    } catch (_e) {
      displayChatMessage("Remote (raw)", event.data); // Fallback for non-JSON messages
    }
  };
  channel.onerror = (error) => {
    console.error("Data channel error:", error);
  };
}

function sendMessage() {
  const messageText = chatInput.value;
  if (messageText && dataChannel && dataChannel.readyState === "open") {
    const messagePayload = {
      sender: "Local", // Or a user-defined name
      message: messageText,
    };
    dataChannel.send(JSON.stringify(messagePayload));
    displayChatMessage("Local", messageText);
    chatInput.value = "";
  } else {
    console.warn(
      "Cannot send message. Data channel not open or message empty.",
    );
  }
}

function displayChatMessage(sender, message) {
  const p = document.createElement("p");
  p.textContent = `[${sender}]: ${message}`;
  chatLog.appendChild(p);
  chatLog.scrollTop = chatLog.scrollHeight; // Scroll to bottom
}

async function hangUp() {
  console.log("Hanging up.");
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null; // Ensure it's nulled after stopping tracks

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop()); // Also stop remote tracks if needed
  }
  remoteStream = null;

  if (dataChannel) {
    dataChannel.close();
    dataChannel = null;
  }

  localVideo.srcObject = null;
  remoteVideo.srcObject = null;

  startButton.disabled = false;
  hangupButton.disabled = true;
  chatInput.disabled = true;
  sendButton.disabled = true;
  // chatLog.innerHTML = ''; // Keep chat log for review, or clear if preferred

  // Clear all relevant signals from server for this room
  // This is a bit aggressive but ensures cleanup for a simple setup.
  // A more robust system might have session IDs.
  console.log("Attempting to clear signals from server...");
  await clearSignalMessage("offer");
  await clearSignalMessage("answer");
  await clearSignalMessage("candidate_initiator");
  await clearSignalMessage("candidate_receiver");

  isInitiator = false; // Reset state
  console.log("Session terminated.");
}

// --- Signaling with Deno KV (via server.js) ---

async function sendSignalMessage(type, payload) {
  try {
    console.log(`Sending signal: ${type}`, payload);
    const response = await fetch(`/signal?room=${ROOM_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, payload: payload }), // Ensure payload is wrapped
    });
    if (!response.ok) {
      console.error(
        `Failed to send signal message ${type}:`,
        response.status,
        await response.text(),
      );
    }
  } catch (error) {
    console.error(`Error sending signal message ${type}:`, error);
  }
}

async function getSignalMessage(type) {
  try {
    const response = await fetch(`/signal?room=${ROOM_ID}&type=${type}`);
    if (response.ok) {
      const data = await response.json(); // Server should return { type, payload } or null/empty for no data
      console.log(`Received signal for ${type}:`, data);
      return data; // Return the whole { type, payload } object or null
    }
    if (response.status === 404) {
      console.log(`No signal message of type ${type} found.`);
      return null;
    }
    console.error(
      `Failed to get signal message ${type}:`,
      response.status,
      await response.text(),
    );
    return null;
  } catch (error) {
    console.error(`Error getting signal message ${type}:`, error);
    return null;
  }
}

async function pollForSignalMessages() {
  if (
    !peerConnection ||
    peerConnection.signalingState === "closed" ||
    hangupButton.disabled
  ) {
    return; // Stop polling if connection is closed or session ended
  }

  try {
    // Initiator looks for an answer and receiver's candidates
    if (isInitiator) {
      if (!peerConnection.remoteDescription) {
        const answerSignal = await getSignalMessage("answer");
        if (answerSignal && answerSignal.payload) {
          console.log("Received answer:", answerSignal.payload);
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(answerSignal.payload),
          );
          await clearSignalMessage("answer");
        }
      }
      const candidateSignal = await getSignalMessage("candidate_receiver");
      if (candidateSignal && candidateSignal.payload) {
        console.log("Received candidate_receiver:", candidateSignal.payload);
        await peerConnection.addIceCandidate(
          new RTCIceCandidate(candidateSignal.payload),
        );
        // await clearSignalMessage("candidate_receiver"); // TEMPORARILY COMMENTED OUT
      }
    } else {
      // Receiver looks for initiator's candidates
      const candidateSignal = await getSignalMessage("candidate_initiator");
      if (candidateSignal && candidateSignal.payload) {
        console.log("Received candidate_initiator:", candidateSignal.payload);
        await peerConnection.addIceCandidate(
          new RTCIceCandidate(candidateSignal.payload),
        );
        // await clearSignalMessage("candidate_initiator"); // TEMPORARILY COMMENTED OUT
      }
    }
  } catch (error) {
    console.error("Error polling for signal messages:", error);
  }

  // Poll again after a short delay
  if (
    peerConnection &&
    peerConnection.signalingState !== "closed" &&
    !hangupButton.disabled
  ) {
    setTimeout(pollForSignalMessages, 3000); // Poll every 3 seconds
  }
}

async function clearSignalMessage(type) {
  try {
    console.log(`Clearing signal: ${type}`);
    const response = await fetch(`/signal?room=${ROOM_ID}&type=${type}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      // 404 is fine if already deleted
      console.error(
        `Failed to clear signal message ${type}:`,
        response.status,
        await response.text(),
      );
    } else {
      console.log(`Signal message ${type} cleared or was not present.`);
    }
  } catch (error) {
    console.error(`Error clearing signal message ${type}:`, error);
  }
}

// Initial UI state
hangupButton.disabled = true;
chatInput.disabled = true;
sendButton.disabled = true;

console.log("Client script loaded. Waiting for user to start session.");
