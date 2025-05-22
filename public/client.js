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
      // iceConfiguration remains the default
      return;
    }
    const servers = await response.json();
    if (servers && servers.length > 0) {
      iceConfiguration.iceServers = servers; // Update the global configuration
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
    // iceConfiguration remains the default
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
    // Fetch ICE servers before doing anything WebRTC related
    await fetchIceServers();

    console.log("Requesting local stream...");
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: true,
    });
    localVideo.srcObject = localStream;
    console.log("Received local stream.");

    await createPeerConnection(); // Will use the (potentially updated) iceConfiguration

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
    hangUp(); // Reset UI and state
  }
}

function createPeerConnection() {
  // Uses the iceConfiguration variable, which is fetched/updated in startSession
  peerConnection = new RTCPeerConnection(iceConfiguration);
  console.log("Created RTCPeerConnection with configuration:", JSON.stringify(iceConfiguration));

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && event.candidate.candidate) { // Check for actual candidate string
      console.log("Local ICE candidate gathered:", event.candidate.candidate.substring(0, 70) + "...");
      const candidateKey = isInitiator
        ? "candidate_initiator"
        : "candidate_receiver";
      sendSignalMessage(candidateKey, event.candidate);
    } else if (!event.candidate) { // True end-of-candidates
      console.log("All local ICE candidates gathered (end-of-candidates signal).");
    } else { // Candidate object exists, but candidate string is empty
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
        // Potentially handle reconnections or notify user more explicitly
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
  
  console.log("Attempting to clear all signals from server for this room...");
  await clearSignalMessage("offer");
  await clearSignalMessage("answer");
  await clearSignalMessage("candidate_initiator");
  await clearSignalMessage("candidate_receiver");

  isInitiator = false; // Reset state
  console.log("Session terminated and signals cleared.");
}


async function sendSignalMessage(type, payload) {
  try {
    // console.log(`Sending signal: ${type}`, payload); // Full payload can be verbose for candidates
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
  } catch (error)
 {
    console.error(`Error sending signal message ${type}:`, error);
  }
}

async function getSignalMessage(type) {
  try {
    const response = await fetch(`/signal?room=${ROOM_ID}&type=${type}`);
    if (response.ok) {
      const data = await response.json(); 
      console.log(`Received signal for ${type} from /signal:`, data ? data.type : 'null');
      return data; 
    }
    if (response.status === 404) {
      console.log(`No signal message of type ${type} found on server (404).`);
      return null;
    }
    console.error(
      `Failed to get signal message ${type} from server:`,
      response.status,
      await response.text(),
    );
    return null;
  } catch (error) {
    console.error(`Error fetching signal message ${type} from server:`, error);
    return null;
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
    if (isInitiator) {
      if (!peerConnection.remoteDescription) {
        const answerSignal = await getSignalMessage("answer");
        if (answerSignal && answerSignal.payload) {
          console.log("Initiator received answer:", answerSignal.payload.type);
          await peerConnection.setRemoteDescription(
            new RTCSessionDescription(answerSignal.payload),
          );
          await clearSignalMessage("answer");
        }
      }
      const candidateSignal = await getSignalMessage("candidate_receiver");
      if (candidateSignal && candidateSignal.payload) {
        console.log("Initiator received candidate_receiver signal payload:", JSON.stringify(candidateSignal.payload));
        if (candidateSignal.payload.candidate) { // Check for actual candidate string
          console.log("Initiator adding ICE candidate:", candidateSignal.payload.candidate.substring(0,70) + "...");
          await peerConnection.addIceCandidate(
            new RTCIceCandidate(candidateSignal.payload),
          );
          // await clearSignalMessage("candidate_receiver"); // TEMPORARILY COMMENTED OUT
        } else {
          console.warn("Initiator received candidate_receiver signal, but payload.candidate is empty. Skipping addIceCandidate.", candidateSignal.payload);
        }
      }
    } else {
      // Receiver looks for initiator\'s candidates
      const candidateSignal = await getSignalMessage("candidate_initiator");
      if (candidateSignal && candidateSignal.payload) {
        console.log("Receiver received candidate_initiator signal payload:", JSON.stringify(candidateSignal.payload));
        if (candidateSignal.payload.candidate) { // Check for actual candidate string
          console.log("Receiver adding ICE candidate:", candidateSignal.payload.candidate.substring(0,70) + "...");
          await peerConnection.addIceCandidate(
            new RTCIceCandidate(candidateSignal.payload),
          );
          // await clearSignalMessage("candidate_initiator"); // TEMPORARILY COMMENTED OUT
        } else {
          console.warn("Receiver received candidate_initiator signal, but payload.candidate is empty. Skipping addIceCandidate.", candidateSignal.payload);
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
    setTimeout(pollForSignalMessages, 3000); // Poll every 3 seconds
  }
}

async function clearSignalMessage(type) {
  try {
    console.log(`Requesting to clear signal type: ${type} on server.`);
    const response = await fetch(`/signal?room=${ROOM_ID}&type=${type}`, {
      method: "DELETE",
    });
    if (!response.ok && response.status !== 404) {
      console.error(
        `Failed to clear signal message ${type} on server:`,
        response.status,
        await response.text(),
      );
    } else {
      console.log(`Signal message ${type} cleared on server (or was not present).`);
    }
  } catch (error) {
    console.error(`Error clearing signal message ${type} on server:`, error);
  }
}

// Initial UI state
hangupButton.disabled = true;
chatInput.disabled = true;
sendButton.disabled = true;

console.log("Client script loaded. Ready for user to start session.");