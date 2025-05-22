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

// Global ICE configuration, starts with a fallback
let iceConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// --- Fetch ICE Servers ---
async function fetchIceServers() {
  console.log("Fetching ICE servers from /api/ice-servers...");
  try {
    const response = await fetch("/api/ice-servers");
    if (!response.ok) {
      console.error(
        "Failed to fetch ICE servers from API:",
        response.status,
        await response.text(),
      );
      console.log("Using default fallback ICE configuration.");
      return;
    }
    const servers = await response.json();
    if (servers && servers.length > 0) {
      iceConfiguration.iceServers = servers;
      console.log(
        "Successfully fetched and updated ICE configuration:",
        iceConfiguration.iceServers.map(s => s.urls).join(', ')
      );
    } else {
      console.warn(
        "Fetched ICE servers list from API is empty, using default fallback.",
      );
    }
  } catch (error) {
    console.error("Error fetching ICE servers from API:", error);
    console.log("Using default fallback ICE configuration due to error.");
  }
}

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
  console.log("Attempting to start session...");
  startButton.disabled = true;
  hangupButton.disabled = false;

  try {
    await fetchIceServers();

    console.log("Requesting local stream...");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localVideo.srcObject = localStream;
    console.log("Received local stream.");

    await createPeerConnection();

    const offerSignal = await getSignalMessage("offer");

    if (!offerSignal || !offerSignal.payload) {
      isInitiator = true;
      console.log("This client is the initiator.");
      if (peerConnection) {
        console.log("Creating offer...");
        const offerSdp = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offerSdp);
        await sendSignalMessage("offer", offerSdp);
        console.log("Sent offer to signaling server.");
      }
    } else {
      isInitiator = false;
      console.log("This client is the receiver. Got offer from signaling server:", offerSignal.payload.type);
      if (peerConnection) {
        await peerConnection.setRemoteDescription(
          new RTCSessionDescription(offerSignal.payload),
        );
        console.log("Set remote description from offer. Creating answer...");
        const answerSdp = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answerSdp);
        await sendSignalMessage("answer", answerSdp);
        console.log("Sent answer to signaling server.");
        await clearSignalMessage("offer");
      }
    }

    pollForSignalMessages();
  } catch (e) {
    console.error("Error starting WebRTC session:", e);
    alert("Could not start session: " + e.message);
    hangUp();
  }
}

function createPeerConnection() {
  peerConnection = new RTCPeerConnection(iceConfiguration);
  console.log("Created RTCPeerConnection with configuration:", JSON.stringify(iceConfiguration));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && event.candidate.candidate) {
      console.log("Local ICE candidate gathered:", event.candidate.candidate.substring(0, 70) + "...");
      const candidateKey = isInitiator
        ? "candidate_initiator" // Server stores this as "candidates_for_receiver"
        : "candidate_receiver";  // Server stores this as "candidates_for_initiator"
      sendSignalMessage(candidateKey, event.candidate);
    } else if (!event.candidate) {
      console.log("All local ICE candidates gathered (end-of-candidates signal).");
    } else {
      console.log("Local ICE candidate gathered, but candidate string is empty. Not sending.", event.candidate);
    }
  };

  peerConnection.ontrack = (event) => {
    console.log("Remote track received:", event.track.kind);
    if (remoteVideo.srcObject !== event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteStream = event.streams[0];
      console.log("Remote stream added to video element.");
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (peerConnection) {
      console.log(
        "ICE connection state changed to:",
        peerConnection.iceConnectionState,
      );
      if (peerConnection.iceConnectionState === "failed") {
          console.error("ICE connection failed. Check STUN/TURN server and network.");
      }
      if (peerConnection.iceConnectionState === "connected") {
          console.log("ICE connection established successfully!");
      }
      if (
        peerConnection.iceConnectionState === "disconnected" ||
        peerConnection.iceConnectionState === "closed"
      ) {
        console.log("ICE connection disconnected or closed.");
      }
    }
  };
  
  peerConnection.onsignalingstatechange = () => {
    if (peerConnection) {
      console.log("Signaling state changed to:", peerConnection.signalingState);
    }
  };

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      console.log("Adding local track to PeerConnection:", track.kind);
      peerConnection.addTrack(track, localStream);
    });
    console.log("Finished adding local stream tracks to PeerConnection.");
  }

  if (isInitiator) {
    console.log("Initiator creating data channel 'chat'.");
    dataChannel = peerConnection.createDataChannel("chat");
    setupDataChannelEvents(dataChannel);
  } else {
    peerConnection.ondatachannel = (event) => {
      console.log("Receiver received data channel 'chat'.");
      dataChannel = event.channel;
      setupDataChannelEvents(dataChannel);
    };
  }
}

function setupDataChannelEvents(channel) {
  channel.onopen = () => {
    console.log(`Data channel '${channel.label}' is open.`);
    chatInput.disabled = false;
    sendButton.disabled = false;
    displayChatMessage("System", "Chat connected!");
  };
  channel.onclose = () => {
    console.log(`Data channel '${channel.label}' is closed.`);
    chatInput.disabled = true;
    sendButton.disabled = true;
    displayChatMessage("System", "Chat disconnected.");
  };
  channel.onmessage = (event) => {
    console.log(`Message received on data channel: ${event.data.substring(0,50)}...`);
    try {
      const messageData = JSON.parse(event.data); 
      displayChatMessage(messageData.sender || "Remote", messageData.message);
    } catch (_e) {
      displayChatMessage("Remote (raw)", event.data); 
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
      sender: "Local", 
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
  chatLog.scrollTop = chatLog.scrollHeight; 
}

async function hangUp() {
  console.log("Hanging up session...");
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
  }
  localStream = null;

  if (remoteStream) {
    remoteStream.getTracks().forEach((track) => track.stop()); 
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
  
  console.log("Attempting to clear offer/answer signals from server for this room...");
  await clearSignalMessage("offer"); // For offer
  await clearSignalMessage("answer"); // For answer
  // Note: Candidate clearing in hangUp is now less effective as specific keys are needed.
  // Individual candidates are cleared during polling. Aggressive cleanup here would require
  // fetching all candidate keys for the room and deleting them, or a specific server endpoint.
  console.log("Session terminated.");
  isInitiator = false; 
}


async function sendSignalMessage(type, payload) {
  try {
    console.log(`Sending signal type: ${type} to /signal`);
    const response = await fetch(`/signal?room=${ROOM_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: type, payload: payload }), 
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
      const data = await response.json(); 
      // For candidates, data will be an array. For offer/answer, an object or null.
      if (type.startsWith("candidate_")) {
        console.log(`Received ${data ? data.length : 0} ${type} signals from /signal.`);
      } else {
        console.log(`Received signal for ${type} from /signal:`, data ? data.type : 'null');
      }
      return data; 
    }
    if (response.status === 404) {
      // For candidates, an empty array is returned by server for "not found", so 404 is usually for offer/answer
      console.log(`No signal message of type ${type} found on server (404).`);
      return type.startsWith("candidate_") ? [] : null; // Return empty array for candidate types if 404
    }
    console.error(
      `Failed to get signal message ${type} from server:`,
      response.status,
      await response.text(),
    );
    return type.startsWith("candidate_") ? [] : null; // Fallback to empty array for candidates on error
  } catch (error) {
    console.error(`Error fetching signal message ${type} from server:`, error);
    return type.startsWith("candidate_") ? [] : null; // Fallback to empty array for candidates on error
  }
}

async function pollForSignalMessages() {
  if (
    !peerConnection ||
    peerConnection.signalingState === "closed" ||
    hangupButton.disabled
  ) {
    return; 
  }

  try {
    if (isInitiator) { // Initiator polls for answers and receiver's candidates
      if (!peerConnection.remoteDescription) {
        const answerSignal = await getSignalMessage("answer"); // Expects single object
        if (answerSignal && answerSignal.payload) {
          console.log("Initiator received answer:", answerSignal.payload.type);
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(answerSignal.payload),
          );
          await clearSignalMessage("answer"); // Clear by type
        }
      }
      
      // Initiator asks for candidates sent by receiver ("candidate_receiver" type on client, "candidates_for_initiator" on server)
      const receiverCandidates = await getSignalMessage("candidate_receiver"); // Expects array
      if (Array.isArray(receiverCandidates)) {
        for (const candidateEntry of receiverCandidates) {
          if (candidateEntry.payload && candidateEntry.payload.candidate) {
            console.log("Initiator adding remote (receiver's) ICE candidate:", candidateEntry.payload.candidate.substring(0,70) + "...");
            await peerConnection.addIceCandidate(
              new RTCIceCandidate(candidateEntry.payload),
            );
            await clearSignalMessage(null, JSON.stringify(candidateEntry.key)); // Clear specific candidate by its full KV key
          } else {
            console.warn("Initiator received receiver's candidate signal, but payload or candidate string is empty. Skipping.", candidateEntry);
            // Still try to clear it if it has a key, as it's an invalid entry from server perspective
            if(candidateEntry.key) await clearSignalMessage(null, JSON.stringify(candidateEntry.key));
          }
        }
      }
    } else { // Receiver polls for initiator's candidates
      // Receiver asks for candidates sent by initiator ("candidate_initiator" type on client, "candidates_for_receiver" on server)
      const initiatorCandidates = await getSignalMessage("candidate_initiator"); // Expects array
      if (Array.isArray(initiatorCandidates)) {
        for (const candidateEntry of initiatorCandidates) {
          if (candidateEntry.payload && candidateEntry.payload.candidate) {
            console.log("Receiver adding remote (initiator's) ICE candidate:", candidateEntry.payload.candidate.substring(0,70) + "...");
            await peerConnection.addIceCandidate(
              new RTCIceCandidate(candidateEntry.payload),
            );
            await clearSignalMessage(null, JSON.stringify(candidateEntry.key)); // Clear specific candidate by its full KV key
          } else {
            console.warn("Receiver received initiator's candidate signal, but payload or candidate string is empty. Skipping.", candidateEntry);
            if(candidateEntry.key) await clearSignalMessage(null, JSON.stringify(candidateEntry.key));
          }
        }
      }
    }
  } catch (error) {
    console.error("Error polling for signal messages:", error);
  }

  if (
    peerConnection &&
    peerConnection.signalingState !== "closed" &&
    !hangupButton.disabled
  ) {
    setTimeout(pollForSignalMessages, 2000); // Poll slightly more frequently
  }
}

async function clearSignalMessage(type, candidateKeyString = null) {
  try {
    let url = `/signal?room=${ROOM_ID}`;
    if (candidateKeyString) {
      // Deleting a specific candidate by its full Deno KV key
      url += `&candidateKey=${encodeURIComponent(candidateKeyString)}`;
      console.log(`Requesting to clear specific candidate on server. Key: ${candidateKeyString}`);
    } else if (type) {
      // Deleting an offer or answer by type
      url += `&type=${type}`;
      console.log(`Requesting to clear signal type: ${type} on server.`);
    } else {
      console.warn("clearSignalMessage called without type or candidateKeyString.");
      return;
    }

    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      console.error(
        `Failed to clear signal message on server: ${type || candidateKeyString}`,
        response.status,
        await response.text(),
      );
    } else {
      console.log(`Signal message ${type || candidateKeyString} cleared on server (or was not present).`);
    }
  } catch (error) {
    console.error(`Error clearing signal message ${type || candidateKeyString} on server:`, error);
  }
}

// Initial UI state
hangupButton.disabled = true;
chatInput.disabled = true;
sendButton.disabled = true;

console.log("Client script loaded. Ready for user to start session.");