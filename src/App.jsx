import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Mic, MicOff, Zap, AlertCircle, Activity, FileText, Trash2, Plus
} from 'lucide-react';

export default function PrescriptionVoiceDetector() {
  const [isListening, setIsListening] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [detectionCount, setDetectionCount] = useState(0);
  const [lastDetection, setLastDetection] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [logs, setLogs] = useState([]);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingProgress, setRecordingProgress] = useState(0);
  const [prescriptionItems, setPrescriptionItems] = useState([]);
  const [micPermission, setMicPermission] = useState('prompt');

  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioStreamRef = useRef(null);
  const processorRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const isListeningRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectDelay = 30000;

  const addLog = useCallback((message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => {
      const newLog = { message, type, timestamp };
      return prev.length >= 50 ? [...prev.slice(-49), newLog] : [...prev, newLog];
    });
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) return;

    const delay = Math.min(
      1000 * Math.pow(2, reconnectAttemptsRef.current),
      maxReconnectDelay
    );

    reconnectTimeoutRef.current = setTimeout(() => {
      addLog(`Reconnecting (attempt ${reconnectAttemptsRef.current + 1})...`, 'info');
      reconnectAttemptsRef.current++;
      connectWebSocket();
    }, delay);
  }, [addLog]);

  const stopAudioStream = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
      audioStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const startAudioStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 16000
        } 
      });
      
      audioStreamRef.current = stream;
      setMicPermission('granted');
      addLog('Microphone access granted', 'success');

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
      
      const audioContext = audioContextRef.current;
      const source = audioContext.createMediaStreamSource(stream);
      
      const bufferSize = 4096;
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
      
      processor.onaudioprocess = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        
        const inputData = e.inputBuffer.getChannelData(0);
        
        const int16Data = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        const base64Audio = btoa(
          String.fromCharCode.apply(null, new Uint8Array(int16Data.buffer))
        );
        
        try {
          wsRef.current.send(JSON.stringify({
            type: 'audio',
            data: base64Audio,
            sampleRate: audioContext.sampleRate
          }));
        } catch (err) {
          console.error('Error sending audio:', err);
        }
      };
      
      source.connect(processor);
      processor.connect(audioContext.destination);
      processorRef.current = processor;
      
      addLog('Audio streaming started', 'success');
      
    } catch (error) {
      console.error('Error accessing microphone:', error);
      setMicPermission('denied');
      addLog('Microphone access denied. Please allow microphone access.', 'error');
      setIsListening(false);
      isListeningRef.current = false;
    }
  }, [addLog]);

  const connectWebSocket = useCallback(() => {
    try {
      if (wsRef.current) wsRef.current.close();

      const ws = new WebSocket('ws://localhost:8765');

      ws.onopen = () => {
        setIsConnected(true);
        reconnectAttemptsRef.current = 0;
        addLog('Connected to wake word detector', 'success');

        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (!data.type) return console.warn('Invalid message:', data);

          switch (data.type) {
            case 'detection':
              setDetectionCount(prev => prev + 1);
              setLastDetection(new Date());
              addLog('Wake word detected! Recording command...', 'success');
              break;

            case 'recording':
              setIsRecording(true);
              setRecordingProgress(0);
              addLog(data.message || 'Recording...', 'info');
              break;

            case 'recording_progress':
              setRecordingProgress(data.progress || 0);
              break;

            case 'transcription':
              setIsRecording(false);
              setRecordingProgress(0);
              addLog(`Transcribed: ${data.text}`, 'success');
              setPrescriptionItems(prev => [
                ...prev,
                { id: Date.now(), text: data.text, timestamp: new Date() }
              ]);
              break;

            case 'audio_level':
              setAudioLevel(data.level || 0);
              break;

            case 'status':
              addLog(data.message || 'Status update', 'info');
              if (data.message?.includes('complete')) setIsRecording(false);
              break;

            case 'error':
              setIsRecording(false);
              setRecordingProgress(0);
              addLog(data.message || 'An error occurred', 'error');
              break;

            default:
              console.log('Unknown message type:', data.type);
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err, event.data);
          addLog('Error processing message', 'error');
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setIsConnected(false);
        addLog('Connection error. Is the Python backend running?', 'error');
      };

      ws.onclose = () => {
        setIsConnected(false);
        setIsListening(false);
        setIsRecording(false);
        stopAudioStream();
        addLog('Disconnected from backend', 'error');

        if (isListeningRef.current && !reconnectTimeoutRef.current) {
          scheduleReconnect();
        }
      };

      wsRef.current = ws;
    } catch (error) {
      console.error('Failed to connect:', error);
      addLog('Failed to connect. Start the Python backend first.', 'error');
      setIsConnected(false);
    }
  }, [addLog, scheduleReconnect, stopAudioStream]);

  const toggleListening = useCallback(async () => {
    if (!isConnected) {
      connectWebSocket();
      return;
    }

    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('Connection lost. Reconnecting...', 'error');
      setIsConnected(false);
      connectWebSocket();
      return;
    }

    const newState = !isListening;
    setIsListening(newState);
    isListeningRef.current = newState;

    try {
      if (newState) {
        await startAudioStream();
        wsRef.current.send(JSON.stringify({ type: 'start' }));
        addLog('Started listening...', 'info');
      } else {
        stopAudioStream();
        wsRef.current.send(JSON.stringify({ type: 'stop' }));
        addLog('Stopped listening', 'info');
      }
    } catch (error) {
      console.error('Error toggling listening:', error);
      addLog('Failed to toggle listening', 'error');
      setIsConnected(false);
      setIsListening(false);
      isListeningRef.current = false;
      stopAudioStream();
    }
  }, [isConnected, isListening, connectWebSocket, addLog, startAudioStream, stopAudioStream]);

  const removePrescriptionItem = useCallback((id) => {
    setPrescriptionItems(prev => prev.filter(item => item.id !== id));
    addLog('Item removed', 'info');
  }, [addLog]);

  const clearPrescription = useCallback(() => {
    setPrescriptionItems([]);
    addLog('Prescription cleared', 'info');
  }, [addLog]);

  const prescriptionList = useMemo(() => (
    prescriptionItems.map((item, index) => (
      <div
        key={item.id}
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          borderRadius: '0.75rem',
          padding: '1rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          transition: 'all 0.15s',
        }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <span style={{ color: 'rgb(134, 239, 172)', fontWeight: 700, fontSize: '0.875rem' }}>#{index + 1}</span>
            <span style={{ color: 'rgb(216, 180, 254)', fontSize: '0.75rem' }}>{item.timestamp.toLocaleTimeString()}</span>
          </div>
          <p style={{ color: 'white', fontSize: '1.125rem', fontWeight: 500, margin: 0 }}>{item.text}</p>
        </div>
        <button
          onClick={() => removePrescriptionItem(item.id)}
          aria-label={`Remove item ${index + 1}`}
          style={{
            marginLeft: '1rem',
            padding: '0.5rem',
            backgroundColor: 'rgba(239, 68, 68, 0.2)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: '0.5rem',
            color: 'rgb(252, 165, 165)',
            cursor: 'pointer',
            transition: 'all 0.15s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)'}
        >
          <Trash2 size={18} />
        </button>
      </div>
    ))
  ), [prescriptionItems, removePrescriptionItem]);

  useEffect(() => {
    document.body.style.margin = '0';
    document.body.style.padding = '0';

    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      stopAudioStream();
    };
  }, [stopAudioStream]);

  const styles = {
    container: {
      minHeight: '100vh',
      width: '100vw',
      background: 'linear-gradient(to bottom right, #4f46e5, #9333ea, #f472b6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1.25rem',
      margin: 0,
    },
    mainWrapper: {
      width: '100%',
      maxWidth: '1280px',
      display: 'flex',
      gap: '1.25rem',
      flexWrap: 'wrap',
      justifyContent: 'center',
    },
    card: {
      backgroundColor: 'rgba(0, 0, 0, 0.3)',
      backdropFilter: 'blur(24px)',
      border: '1px solid rgba(255, 255, 255, 0.2)',
      borderRadius: '1rem',
      padding: '1.5rem',
      boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
      width: '100%',
      maxWidth: '28rem',
    },
  };

  return (
    <div style={styles.container}>
      <div style={styles.mainWrapper}>
        <div style={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
            <h1 style={{ color: 'white', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Clini Voice Assistant</h1>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              paddingLeft: '0.75rem',
              paddingRight: '0.75rem',
              paddingTop: '0.25rem',
              paddingBottom: '0.25rem',
              borderRadius: '9999px',
              backgroundColor: isConnected ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
              color: isConnected ? 'rgb(134, 239, 172)' : 'rgb(252, 165, 165)',
            }}>
              <Zap size={16} style={{ animation: isConnected ? 'pulse 2s infinite' : 'none' }} />
              <span style={{ fontSize: '0.875rem', fontWeight: 500 }}>{isConnected ? 'Connected' : 'Disconnected'}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', marginBottom: '2rem' }}>
            <div style={{
              width: '8rem',
              height: '8rem',
              borderRadius: '9999px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '1rem',
              transition: 'all 0.15s',
              backgroundColor: isListening ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.1)',
              border: isListening ? '2px solid rgba(16, 185, 129, 0.5)' : '2px solid rgba(255, 255, 255, 0.2)',
            }}>
              <div style={{
                width: '6rem',
                height: '6rem',
                borderRadius: '9999px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isRecording ? 'rgba(239, 68, 68, 0.3)' : isListening ? 'rgba(16, 185, 129, 0.3)' : 'rgba(255, 255, 255, 0.05)',
                border: isRecording ? '2px solid rgba(239, 68, 68, 0.5)' : isListening ? '2px solid rgba(16, 185, 129, 0.5)' : '2px solid rgba(255, 255, 255, 0.1)',
                animation: isRecording ? 'pulse 1s infinite' : 'none',
              }}>
                {isRecording ? (
                  <Activity size={40} style={{ color: 'rgb(252, 165, 165)' }} />
                ) : isListening ? (
                  <Mic size={40} style={{ color: 'rgb(134, 239, 172)' }} />
                ) : (
                  <MicOff size={40} style={{ color: 'rgba(255, 255, 255, 0.7)' }} />
                )}
              </div>
            </div>

            {isRecording && (
              <div style={{ width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '9999px', height: '0.5rem', marginBottom: '1rem' }}>
                <div style={{
                  backgroundColor: 'rgb(239, 68, 68)',
                  height: '0.5rem',
                  borderRadius: '9999px',
                  transition: 'all 0.15s',
                  width: `${recordingProgress}%`,
                }} />
              </div>
            )}

            <button
              onClick={toggleListening}
              style={{
                paddingLeft: '1.5rem',
                paddingRight: '1.5rem',
                paddingTop: '0.75rem',
                paddingBottom: '0.75rem',
                borderRadius: '0.75rem',
                fontSize: '1.125rem',
                fontWeight: 500,
                transition: 'all 0.15s',
                backgroundColor: isListening ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                color: isListening ? 'rgb(252, 165, 165)' : 'rgb(134, 239, 172)',
                border: isListening ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(16, 185, 129, 0.3)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = isListening ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = isListening ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)';
              }}
            >
              {isListening ? 'Stop Listening' : 'Start Listening'}
            </button>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.875rem' }}>
            <div>Detections: <span style={{ color: 'rgb(216, 180, 254)', fontWeight: 500 }}>{detectionCount}</span></div>
            <div>
              Last: <span style={{ color: 'rgb(216, 180, 254)', fontWeight: 500 }}>
                {lastDetection ? lastDetection.toLocaleTimeString() : 'None'}
              </span>
            </div>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.75rem', padding: '0.75rem', marginBottom: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.875rem' }}>Audio Level</span>
              <span style={{ fontSize: '0.75rem', color: 'rgb(216, 180, 254)' }}>{Math.round(audioLevel * 100)}%</span>
            </div>
            <div style={{ width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.1)', borderRadius: '9999px', height: '0.5rem', overflow: 'hidden' }}>
              <div style={{
                backgroundColor: 'rgb(139, 92, 246)',
                height: '0.5rem',
                borderRadius: '9999px',
                transition: 'all 0.15s',
                width: `${Math.min(audioLevel * 100, 100)}%`,
              }} />
            </div>
          </div>

          <div style={{ maxHeight: '10rem', overflowY: 'auto', backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.75rem', padding: '0.75rem' }}>
            <h3 style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.875rem', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: 0 }}>
              <FileText size={14} />
              System Logs
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              {logs.map((log, index) => (
                <div key={index} style={{
                  fontSize: '0.75rem',
                  paddingTop: '0.25rem',
                  paddingBottom: '0.25rem',
                  paddingLeft: '0.5rem',
                  paddingRight: '0.5rem',
                  borderRadius: '0.25rem',
                  backgroundColor: log.type === 'error' ? 'rgba(239, 68, 68, 0.2)' : log.type === 'success' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                  color: log.type === 'error' ? 'rgb(252, 165, 165)' : log.type === 'success' ? 'rgb(134, 239, 172)' : 'rgba(255, 255, 255, 0.7)',
                }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.5)' }}>{log.timestamp}</span> {log.message}
                </div>
              ))}
              {logs.length === 0 && (
                <div style={{ fontSize: '0.75rem', paddingTop: '0.25rem', paddingBottom: '0.25rem', paddingLeft: '0.5rem', paddingRight: '0.5rem', borderRadius: '0.25rem', backgroundColor: 'rgba(255, 255, 255, 0.1)', color: 'rgba(255, 255, 255, 0.5)' }}>
                  No logs yet. Start listening to begin.
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={styles.card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
            <h2 style={{ color: 'white', fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Prescription Items</h2>
            <button
              onClick={clearPrescription}
              disabled={prescriptionItems.length === 0}
              style={{
                paddingLeft: '0.75rem',
                paddingRight: '0.75rem',
                paddingTop: '0.25rem',
                paddingBottom: '0.25rem',
                borderRadius: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: prescriptionItems.length === 0 ? 'rgba(255, 255, 255, 0.05)' : 'rgba(239, 68, 68, 0.2)',
                color: prescriptionItems.length === 0 ? 'rgba(255, 255, 255, 0.3)' : 'rgb(252, 165, 165)',
                cursor: prescriptionItems.length === 0 ? 'not-allowed' : 'pointer',
                border: 'none',
              }}
              onMouseEnter={(e) => {
                if (prescriptionItems.length > 0) {
                  e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
                }
              }}
              onMouseLeave={(e) => {
                if (prescriptionItems.length > 0) {
                  e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.2)';
                }
              }}
            >
              <Trash2 size={14} />
              Clear All
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '500px', overflowY: 'auto' }}>
            {prescriptionItems.length === 0 ? (
              <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '0.75rem', padding: '1rem', textAlign: 'center', color: 'rgba(255, 255, 255, 0.5)' }}>
                <p style={{ marginBottom: '0.5rem', marginTop: 0 }}>No prescription items yet</p>
                <p style={{ fontSize: '0.875rem', margin: 0 }}>Say "Clinisio" followed by a prescription to add items</p>
              </div>
            ) : (
              prescriptionList
            )}
          </div>

          <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'center' }}>
            <button
              onClick={toggleListening}
              style={{
                paddingLeft: '1rem',
                paddingRight: '1rem',
                paddingTop: '0.5rem',
                paddingBottom: '0.5rem',
                borderRadius: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                backgroundColor: isListening ? 'rgba(139, 92, 246, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                color: isListening ? 'rgb(216, 180, 254)' : 'rgba(255, 255, 255, 0.7)',
                border: isListening ? '1px solid rgba(139, 92, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.2)',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!isListening) {
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isListening) {
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
                }
              }}
            >
              <Plus size={16} />
              {isListening ? 'Listening...' : 'Add Item'}
            </button>
          </div>
        </div>
      </div>
      
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}