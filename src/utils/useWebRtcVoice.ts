import { useEffect, useRef, useState, useCallback } from 'react';
import { User } from '../types';
import { RemoteVoiceParticipant } from '../components/VoiceStage';

interface UseWebRtcVoiceOptions {
  currentUser: User;
  isConnected: boolean;
  channelId: string | null;
  isMuted: boolean;
  isDeafened: boolean;
  remoteParticipants: RemoteVoiceParticipant[];
  sendSignal: (targetUserId: string, signal: any) => void;
  sendAudioChunk?: (audioBase64: string) => void;
  onSendSpeakingState?: (isSpeaking: boolean) => void;
}

// Robust multi-STUN and open public TURN servers to guarantee audio traversal through symmetric NAT (4G/5G, mobile, and home firewalls)
const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // Free high-reliability open TURN relay servers by Metered OpenRelay
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 10,
};

export function useWebRtcVoice({
  currentUser,
  isConnected,
  channelId,
  isMuted,
  isDeafened,
  remoteParticipants,
  sendSignal,
  sendAudioChunk,
  onSendSpeakingState,
}: UseWebRtcVoiceOptions) {
  const [localMicLevel, setLocalMicLevel] = useState<number>(0);
  const [isLocalSpeaking, setIsLocalSpeaking] = useState<boolean>(false);
  const [remoteSpeakingMap, setRemoteSpeakingMap] = useState<Record<string, boolean>>({});
  const [remoteVolumeLevels, setRemoteVolumeLevels] = useState<Record<string, number>>({});
  const [userVolumes, setUserVolumes] = useState<Record<string, number>>(() => {
    try {
      const stored = localStorage.getItem('modecord_user_volumes');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });

  // Mutable refs to prevent re-triggering effects and stale closures
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;

  const isDeafenedRef = useRef(isDeafened);
  isDeafenedRef.current = isDeafened;

  const userVolumesRef = useRef(userVolumes);
  userVolumesRef.current = userVolumes;

  const sendSignalRef = useRef(sendSignal);
  sendSignalRef.current = sendSignal;

  const onSendSpeakingStateRef = useRef(onSendSpeakingState);
  onSendSpeakingStateRef.current = onSendSpeakingState;

  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const remoteAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const remoteAnalysersRef = useRef<Map<string, { audioCtx: AudioContext; analyser: AnalyserNode }>>(new Map());
  const localAudioContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const remoteCheckIntervalRef = useRef<any>(null);

  // Set per-user volume
  const setUserVolume = useCallback((userId: string, volume: number) => {
    setUserVolumes((prev) => {
      const updated = { ...prev, [userId]: volume };
      try {
        localStorage.setItem('modecord_user_volumes', JSON.stringify(updated));
      } catch {}
      return updated;
    });

    const audioEl = remoteAudioElementsRef.current.get(userId);
    if (audioEl) {
      audioEl.volume = Math.max(0, Math.min(1, volume / 100));
    }
  }, []);

  // Cleanup a specific remote peer connection and its audio elements
  const cleanupPeer = useCallback((userId: string) => {
    const pc = peerConnectionsRef.current.get(userId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.oniceconnectionstatechange = null;
      pc.close();
      peerConnectionsRef.current.delete(userId);
    }
    pendingCandidatesRef.current.delete(userId);

    const audioEl = remoteAudioElementsRef.current.get(userId);
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
      remoteAudioElementsRef.current.delete(userId);
    }

    const analyserObj = remoteAnalysersRef.current.get(userId);
    if (analyserObj) {
      analyserObj.audioCtx.close().catch(() => {});
      remoteAnalysersRef.current.delete(userId);
    }

    setRemoteSpeakingMap((prev) => {
      if (!prev[userId]) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });

    setRemoteVolumeLevels((prev) => {
      if (prev[userId] === undefined) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  // Drain pending candidates safely once remote description has been set
  const drainPendingCandidates = useCallback(async (userId: string, pc: RTCPeerConnection) => {
    const pending = pendingCandidatesRef.current.get(userId);
    if (!pending || pending.length === 0) return;

    pendingCandidatesRef.current.delete(userId);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn(`[WebRTC] ICE candidate drain error with ${userId}:`, err);
      }
    }
  }, []);

  // Attach and play remote audio stream with foolproof autoplay unlock
  const attachRemoteAudio = useCallback((userId: string, stream: MediaStream) => {
    let audioEl = remoteAudioElementsRef.current.get(userId);
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.id = `remote-audio-${userId}`;
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      (audioEl as any).webkitPlaysInline = true;
      document.body.appendChild(audioEl);
      remoteAudioElementsRef.current.set(userId, audioEl);
    }

    audioEl.srcObject = stream;
    const vol = userVolumesRef.current[userId] ?? 100;
    const isDeaf = isDeafenedRef.current;
    audioEl.volume = isDeaf ? 0 : Math.max(0, Math.min(1, vol / 100));
    audioEl.muted = isDeaf;

    const playAudio = () => {
      audioEl?.play().catch(() => {
        // Unlock on first user gesture if restricted by browser autoplay policy
        const unlock = () => {
          audioEl?.play().catch(() => {});
          window.removeEventListener('click', unlock);
          window.removeEventListener('keydown', unlock);
          window.removeEventListener('touchstart', unlock);
        };
        window.addEventListener('click', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
        window.addEventListener('touchstart', unlock, { once: true });
      });
    };

    playAudio();

    // Set up Web Audio Analyser for remote speaking visualizer & green border ring
    try {
      if (!remoteAnalysersRef.current.has(userId)) {
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) {
          const audioCtx = new AudioContextClass();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          remoteAnalysersRef.current.set(userId, { audioCtx, analyser });
        }
      }
    } catch (err) {
      console.warn(`[WebRTC] Analyser attach error for ${userId}:`, err);
    }
  }, []);

  // Create or retrieve PeerConnection for a specific remote user
  const getOrCreatePeerConnection = useCallback((targetUserId: string) => {
    let pc = peerConnectionsRef.current.get(targetUserId);
    if (pc && pc.signalingState !== 'closed') {
      return pc;
    }

    pc = new RTCPeerConnection(ICE_CONFIG);
    peerConnectionsRef.current.set(targetUserId, pc);

    // Add audio transceiver configured for bi-directional audio
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });

    // If local microphone stream is already active, set track on sender immediately
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        transceiver.sender.replaceTrack(audioTrack).catch((err) => {
          console.warn(`[WebRTC] replaceTrack error for ${targetUserId}:`, err);
        });
      }
    }

    // ICE Candidate handler
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignalRef.current(targetUserId, {
          type: 'candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Remote Audio track received
    pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      attachRemoteAudio(targetUserId, stream);

      event.track.onunmute = () => {
        const audioEl = remoteAudioElementsRef.current.get(targetUserId);
        if (audioEl) {
          audioEl.play().catch(() => {});
        }
      };
    };

    // Auto-restart ICE on disconnection or failure
    pc.oniceconnectionstatechange = () => {
      if (pc && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected')) {
        const isCaller = currentUser.id < targetUserId;
        if (isCaller) {
          pc.restartIce();
        }
      }
    };

    // Deterministic Caller/Callee rule:
    // Peer with currentUser.id < targetUserId is ALWAYS the Caller (initiates offer).
    // The other peer is the Callee (waits for offer, creates answer).
    // This completely eliminates race conditions and offer collisions.
    const isCaller = currentUser.id < targetUserId;

    if (isCaller) {
      setTimeout(async () => {
        try {
          if (!pc || pc.signalingState === 'closed') return;
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
          });
          await pc.setLocalDescription(offer);
          sendSignalRef.current(targetUserId, {
            type: 'sdp',
            description: pc.localDescription,
          });
        } catch (err) {
          console.error(`[WebRTC] Offer initiation error with ${targetUserId}:`, err);
        }
      }, 50);
    }

    return pc;
  }, [attachRemoteAudio, currentUser.id]);

  // Handle incoming WebRTC signaling message
  const handleIncomingSignal = useCallback(async (fromUserId: string, signal: any) => {
    if (!isConnected || !channelId || fromUserId === currentUser.id) return;

    const pc = getOrCreatePeerConnection(fromUserId);
    if (!pc || pc.signalingState === 'closed') return;

    try {
      if (signal.type === 'sdp' && signal.description) {
        const desc = new RTCSessionDescription(signal.description);

        if (desc.type === 'offer') {
          // If we are currently in local-offer state, perform rollback before applying remote offer
          if (pc.signalingState !== 'stable') {
            await pc.setLocalDescription({ type: 'rollback' });
          }

          await pc.setRemoteDescription(desc);

          // Ensure local microphone track is wired to the sender
          if (localStreamRef.current) {
            const audioTrack = localStreamRef.current.getAudioTracks()[0];
            if (audioTrack) {
              const senders = pc.getSenders();
              const audioSender = senders.find((s) => s.track?.kind === 'audio' || !s.track);
              if (audioSender) {
                await audioSender.replaceTrack(audioTrack).catch(() => {});
              }
            }
          }

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          sendSignalRef.current(fromUserId, {
            type: 'sdp',
            description: pc.localDescription,
          });

          await drainPendingCandidates(fromUserId, pc);
        } else if (desc.type === 'answer') {
          if (pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(desc);
            await drainPendingCandidates(fromUserId, pc);
          }
        }
      } else if (signal.type === 'candidate' && signal.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch (e) {
            console.warn(`[WebRTC] ICE candidate addition error from ${fromUserId}:`, e);
          }
        } else {
          // Queue candidates until remote description is established
          const list = pendingCandidatesRef.current.get(fromUserId) || [];
          list.push(signal.candidate);
          pendingCandidatesRef.current.set(fromUserId, list);
        }
      }
    } catch (err) {
      console.warn(`[WebRTC] Signal handling exception from ${fromUserId}:`, err);
    }
  }, [channelId, currentUser.id, drainPendingCandidates, getOrCreatePeerConnection, isConnected]);

  // Handle incoming audio chunk fallback
  const handleIncomingAudioChunk = useCallback((fromUserId: string, audioBase64: string) => {
    // No-op for direct P2P audio
  }, []);

  // Microphone initialization and local level meter loop
  useEffect(() => {
    if (!isConnected || !channelId) {
      // Disconnect and release all audio tracks and connections
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      if (localAudioContextRef.current) {
        localAudioContextRef.current.close().catch(() => {});
        localAudioContextRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      peerConnectionsRef.current.forEach((pc) => pc.close());
      peerConnectionsRef.current.clear();
      remoteAudioElementsRef.current.forEach((el) => {
        el.pause();
        el.remove();
      });
      remoteAudioElementsRef.current.clear();
      remoteAnalysersRef.current.forEach(({ audioCtx }) => audioCtx.close().catch(() => {}));
      remoteAnalysersRef.current.clear();

      setLocalMicLevel(0);
      setIsLocalSpeaking(false);
      setRemoteSpeakingMap({});
      setRemoteVolumeLevels({});
      return;
    }

    let isMounted = true;
    let lastSpeaking = false;
    let lastLevel = 0;
    let lastLevelUpdateTime = 0;

    async function startMic() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: 48000,
          },
        });

        if (!isMounted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        localStreamRef.current = stream;

        // Apply initial mute state to microphone track
        stream.getAudioTracks().forEach((t) => {
          t.enabled = !isMutedRef.current;
        });

        // Add or replace audio track across all existing peer connections
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
          peerConnectionsRef.current.forEach((pc) => {
            const senders = pc.getSenders();
            const audioSender = senders.find((s) => s.track?.kind === 'audio' || !s.track);
            if (audioSender) {
              audioSender.replaceTrack(audioTrack).catch((err) => {
                console.warn('[WebRTC] Error replacing track on peer:', err);
              });
            } else {
              pc.addTrack(audioTrack, stream);
            }
          });
        }

        // Set up Local Analyser for mic visualization
        const AudioContextClass =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) {
          const audioCtx = new AudioContextClass();
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);

          localAudioContextRef.current = audioCtx;
          localAnalyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);

          const checkMic = () => {
            if (!isMounted || !localAnalyserRef.current) return;

            const now = Date.now();
            const currentMuted = isMutedRef.current;

            if (currentMuted) {
              if (lastLevel !== 0) {
                lastLevel = 0;
                setLocalMicLevel(0);
              }
              if (lastSpeaking) {
                lastSpeaking = false;
                setIsLocalSpeaking(false);
                onSendSpeakingStateRef.current?.(false);
              }
            } else {
              localAnalyserRef.current.getByteFrequencyData(dataArray);
              let sum = 0;
              for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
              }
              const avg = sum / dataArray.length;
              const level = Math.min(100, Math.round((avg / 128) * 100));

              // Throttle UI updates to 80ms or significant change
              if (now - lastLevelUpdateTime > 80 || Math.abs(level - lastLevel) >= 8) {
                lastLevel = level;
                lastLevelUpdateTime = now;
                setLocalMicLevel(level);
              }

              const speaking = level > 12;
              if (speaking !== lastSpeaking) {
                lastSpeaking = speaking;
                setIsLocalSpeaking(speaking);
                onSendSpeakingStateRef.current?.(speaking);
              }
            }

            animationFrameRef.current = requestAnimationFrame(checkMic);
          };

          checkMic();
        }
      } catch (err) {
        console.error('[WebRTC] Microphone access error:', err);
      }
    }

    startMic();

    return () => {
      isMounted = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
      if (localAudioContextRef.current) {
        localAudioContextRef.current.close().catch(() => {});
        localAudioContextRef.current = null;
      }
    };
  }, [isConnected, channelId]);

  // Synchronize Mute state to local audio tracks
  useEffect(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((t) => {
        t.enabled = !isMuted;
      });
    }
    if (isMuted) {
      setLocalMicLevel(0);
      setIsLocalSpeaking(false);
      onSendSpeakingStateRef.current?.(false);
    }
  }, [isMuted]);

  // Synchronize Deafen state to remote audio outputs
  useEffect(() => {
    remoteAudioElementsRef.current.forEach((el, userId) => {
      const vol = userVolumesRef.current[userId] ?? 100;
      el.muted = isDeafened;
      el.volume = isDeafened ? 0 : Math.max(0, Math.min(1, vol / 100));
    });
  }, [isDeafened]);

  // Maintain PeerConnections for all remote participants
  const participantIdsKey = remoteParticipants
    .filter((rp) => rp.userId !== currentUser.id)
    .map((rp) => rp.userId)
    .sort()
    .join(',');

  useEffect(() => {
    if (!isConnected || !channelId) return;

    const currentParticipantIds = new Set<string>(
      remoteParticipants
        .filter((rp) => rp.userId !== currentUser.id)
        .map((rp) => rp.userId)
    );

    // Initialize connections for new participants
    currentParticipantIds.forEach((targetId) => {
      getOrCreatePeerConnection(targetId);
    });

    // Cleanup disconnected participants
    peerConnectionsRef.current.forEach((_, existingId) => {
      if (!currentParticipantIds.has(existingId)) {
        cleanupPeer(existingId);
      }
    });
  }, [channelId, isConnected, participantIdsKey, getOrCreatePeerConnection, cleanupPeer, remoteParticipants, currentUser.id]);

  // Periodic Remote speaking detector
  useEffect(() => {
    if (!isConnected || !channelId) {
      if (remoteCheckIntervalRef.current) {
        clearInterval(remoteCheckIntervalRef.current);
      }
      return;
    }

    const dataArray = new Uint8Array(128);

    remoteCheckIntervalRef.current = setInterval(() => {
      if (remoteAnalysersRef.current.size === 0) return;

      let speakingChanged = false;
      let volumeChanged = false;

      const newSpeakingMap: Record<string, boolean> = {};
      const newVolumeLevels: Record<string, number> = {};

      remoteAnalysersRef.current.forEach(({ analyser }, userId) => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const level = Math.min(100, Math.round((avg / 128) * 100));
        const isSpeaking = level > 10;

        newVolumeLevels[userId] = level;
        newSpeakingMap[userId] = isSpeaking;

        setRemoteSpeakingMap((prev) => {
          if (prev[userId] !== isSpeaking) {
            speakingChanged = true;
          }
          return prev;
        });

        setRemoteVolumeLevels((prev) => {
          if (Math.abs((prev[userId] || 0) - level) >= 8) {
            volumeChanged = true;
          }
          return prev;
        });
      });

      if (speakingChanged) {
        setRemoteSpeakingMap(newSpeakingMap);
      }
      if (volumeChanged) {
        setRemoteVolumeLevels(newVolumeLevels);
      }
    }, 150);

    return () => {
      if (remoteCheckIntervalRef.current) {
        clearInterval(remoteCheckIntervalRef.current);
      }
    };
  }, [channelId, isConnected]);

  return {
    localMicLevel,
    isLocalSpeaking,
    remoteSpeakingMap,
    remoteVolumeLevels,
    userVolumes,
    setUserVolume,
    handleIncomingSignal,
    handleIncomingAudioChunk,
  };
}
