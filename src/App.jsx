import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Mic, MicOff, Zap, CheckCircle, AlertCircle, Activity, FileText, Trash2, Plus
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

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const isListeningRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const maxReconnectDelay = 30000; // 30 seconds

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
  }, [addLog, scheduleReconnect]);

  const toggleListening = useCallback(() => {
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
      wsRef.current.send(JSON.stringify({ action: newState ? 'start' : 'stop' }));
      addLog(newState ? 'Started listening...' : 'Stopped listening', 'info');
    } catch (error) {
      console.error('Error sending message:', error);
      addLog('Failed to send command', 'error');
      setIsConnected(false);
    }
  }, [isConnected, isListening, connectWebSocket, addLog]);

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
        className="bg-white/5 border border-white/10 rounded-xl p-4 flex items-start justify-between transition-all hover:bg-white/10"
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-green-300 font-bold text-sm">#{index + 1}</span>
            <span className="text-purple-300 text-xs">{item.timestamp.toLocaleTimeString()}</span>
          </div>
          <p className="text-white text-lg font-medium m-0">{item.text}</p>
        </div>
        <button
          onClick={() => removePrescriptionItem(item.id)}
          aria-label={`Remove item ${index + 1}`}
          className="ml-4 p-2 bg-red-500/20 border border-red-500/30 rounded-lg text-red-300 cursor-pointer transition-all hover:bg-red-500/30 flex items-center justify-center"
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
    };
  }, []);

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .pulse-animation { animation: pulse 2s infinite; }
        .pulse-fast { animation: pulse 1s infinite; }
        
        /* Base styles */
        body, html { 
          margin: 0; 
          padding: 0; 
          width: 100%;
          height: 100%;
          overflow-x: hidden;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
          color: white;
          background-color: #111827;
        }
        
        #root {
          width: 100%;
          height: 100%;
        }
        
        /* Layout */
        .min-h-screen {
          min-height: 100vh;
          width: 100vw;
          margin: 0;
          padding: 0;
        }
        
        .flex {
          display: flex;
        }
        
        .flex-1 {
          flex: 1;
        }
        
        .flex-col {
          flex-direction: column;
        }
        
        .flex-wrap {
          flex-wrap: wrap;
        }
        
        .items-center {
          align-items: center;
        }
        
        .items-start {
          align-items: flex-start;
        }
        
        .justify-center {
          justify-content: center;
        }
        
        .justify-between {
          justify-content: space-between;
        }
        
        .gap-1 {
          gap: 0.25rem;
        }
        
        .gap-2 {
          gap: 0.5rem;
        }
        
        .gap-3 {
          gap: 0.75rem;
        }
        
        .gap-4 {
          gap: 1rem;
        }
        
        .gap-5 {
          gap: 1.25rem;
        }
        
        .space-y-1 > * + * {
          margin-top: 0.25rem;
        }
        
        .space-y-3 > * + * {
          margin-top: 0.75rem;
        }
        
        /* Sizing */
        .w-full {
          width: 100%;
        }
        
        .w-32 {
          width: 8rem;
        }
        
        .w-24 {
          width: 6rem;
        }
        
        .h-32 {
          height: 8rem;
        }
        
        .h-24 {
          height: 6rem;
        }
        
        .h-2 {
          height: 0.5rem;
        }
        
        .max-w-md {
          max-width: 28rem;
        }
        
        .max-h-40 {
          max-height: 10rem;
        }
        
        .max-h-\\[500px\\] {
          max-height: 500px;
        }
        
        /* Spacing */
        .p-1 {
          padding: 0.25rem;
        }
        
        .p-2 {
          padding: 0.5rem;
        }
        
        .p-3 {
          padding: 0.75rem;
        }
        
        .p-4 {
          padding: 1rem;
        }
        
        .p-5 {
          padding: 1.25rem;
        }
        
        .p-6 {
          padding: 1.5rem;
        }
        
        .px-2 {
          padding-left: 0.5rem;
          padding-right: 0.5rem;
        }
        
        .px-3 {
          padding-left: 0.75rem;
          padding-right: 0.75rem;
        }
        
        .px-4 {
          padding-left: 1rem;
          padding-right: 1rem;
        }
        
        .px-6 {
          padding-left: 1.5rem;
          padding-right: 1.5rem;
        }
        
        .py-1 {
          padding-top: 0.25rem;
          padding-bottom: 0.25rem;
        }
        
        .py-2 {
          padding-top: 0.5rem;
          padding-bottom: 0.5rem;
        }
        
        .py-3 {
          padding-top: 0.75rem;
          padding-bottom: 0.75rem;
        }
        
        .m-0 {
          margin: 0;
        }
        
        .mb-1 {
          margin-bottom: 0.25rem;
        }
        
        .mb-2 {
          margin-bottom: 0.5rem;
        }
        
        .mb-4 {
          margin-bottom: 1rem;
        }
        
        .mb-6 {
          margin-bottom: 1.5rem;
        }
        
        .mb-8 {
          margin-bottom: 2rem;
        }
        
        .ml-4 {
          margin-left: 1rem;
        }
        
        .mt-6 {
          margin-top: 1.5rem;
        }
        
        /* Typography */
        .text-xs {
          font-size: 0.75rem;
        }
        
        .text-sm {
          font-size: 0.875rem;
        }
        
        .text-lg {
          font-size: 1.125rem;
        }
        
        .text-2xl {
          font-size: 1.5rem;
        }
        
        .font-medium {
          font-weight: 500;
        }
        
        .font-bold {
          font-weight: 700;
        }
        
        .text-center {
          text-align: center;
        }
        
        /* Colors */
        .bg-black\\/30 {
          background-color: rgba(0, 0, 0, 0.3);
        }
        
        .bg-white\\/5 {
          background-color: rgba(255, 255, 255, 0.05);
        }
        
        .bg-white\\/10 {
          background-color: rgba(255, 255, 255, 0.1);
        }
        
        .bg-green-500\\/20 {
          background-color: rgba(16, 185, 129, 0.2);
        }
        
        .bg-green-500\\/30 {
          background-color: rgba(16, 185, 129, 0.3);
        }
        
        .bg-red-500\\/20 {
          background-color: rgba(239, 68, 68, 0.2);
        }
        
        .bg-red-500\\/30 {
          background-color: rgba(239, 68, 68, 0.3);
        }
        
        .bg-purple-500\\/20 {
          background-color: rgba(139, 92, 246, 0.2);
        }
        
        .bg-red-500 {
          background-color: rgb(239, 68, 68);
        }
        
        .bg-purple-500 {
          background-color: rgb(139, 92, 246);
        }
        
        .bg-gradient-to-br {
          background-image: linear-gradient(to bottom right, var(--tw-gradient-stops));
        }
        
        .from-indigo-600 {
          --tw-gradient-from: #4f46e5;
          --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to, rgba(79, 70, 229, 0));
        }
        
        .via-purple-600 {
          --tw-gradient-stops: var(--tw-gradient-from), #9333ea, var(--tw-gradient-to, rgba(147, 51, 234, 0));
        }
        
        .to-pink-400 {
          --tw-gradient-to: #f472b6;
        }
        
        .text-white {
          color: rgb(255, 255, 255);
        }
        
        .text-white\\/70 {
          color: rgba(255, 255, 255, 0.7);
        }
        
        .text-white\\/50 {
          color: rgba(255, 255, 255, 0.5);
        }
        
        .text-white\\/30 {
          color: rgba(255, 255, 255, 0.3);
        }
        
        .text-green-300 {
          color: rgb(134, 239, 172);
        }
        
        .text-red-300 {
          color: rgb(252, 165, 165);
        }
        
        .text-purple-300 {
          color: rgb(216, 180, 254);
        }
        
        .border {
          border-width: 1px;
        }
        
        .border-2 {
          border-width: 2px;
        }
        
        .border-white\\/10 {
          border-color: rgba(255, 255, 255, 0.1);
        }
        
        .border-white\\/20 {
          border-color: rgba(255, 255, 255, 0.2);
        }
        
        .border-green-500\\/30 {
          border-color: rgba(16, 185, 129, 0.3);
        }
        
        .border-green-500\\/50 {
          border-color: rgba(16, 185, 129, 0.5);
        }
        
        .border-red-500\\/30 {
          border-color: rgba(239, 68, 68, 0.3);
        }
        
        .border-red-500\\/50 {
          border-color: rgba(239, 68, 68, 0.5);
        }
        
        .border-purple-500\\/30 {
          border-color: rgba(139, 92, 246, 0.3);
        }
        
        /* Effects */
        .rounded-lg {
          border-radius: 0.5rem;
        }
        
        .rounded-xl {
          border-radius: 0.75rem;
        }
        
        .rounded-2xl {
          border-radius: 1rem;
        }
        
        .rounded-full {
          border-radius: 9999px;
        }
        
        .shadow-xl {
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        }
        
        .backdrop-blur-xl {
          backdrop-filter: blur(24px);
        }
        
        .transition-all {
          transition-property: all;
          transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
          transition-duration: 150ms;
        }
        
        /* Interactivity */
        .cursor-pointer {
          cursor: pointer;
        }
        
        .cursor-not-allowed {
          cursor: not-allowed;
        }
        
        .hover\\:bg-white\\/20:hover {
          background-color: rgba(255, 255, 255, 0.2);
        }
        
        .hover\\:bg-green-500\\/30:hover {
          background-color: rgba(16, 185, 129, 0.3);
        }
        
        .hover\\:bg-red-500\\/30:hover {
          background-color: rgba(239, 68, 68, 0.3);
        }
        
        .hover\\:bg-white\\/10:hover {
          background-color: rgba(255, 255, 255, 0.1);
        }
        
        /* Layout */
        .overflow-y-auto {
          overflow-y: auto;
        }
        
        .overflow-x-hidden {
          overflow-x: hidden;
        }
      `}} />

      <div className="min-h-screen w-screen bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-400 flex items-center justify-center p-5">
        <div className="w-full max-w-screen-xl flex gap-5 flex-wrap justify-center">
          {/* MAIN DETECTION CARD */}
          <div className="bg-black/30 backdrop-blur-xl border border-white/20 rounded-2xl p-6 shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h1 className="text-white text-2xl font-bold">Clini Voice Assistant</h1>
              <div className={`flex items-center gap-2 px-3 py-1 rounded-full ${isConnected ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
                <Zap size={16} className={isConnected ? 'pulse-animation' : ''} />
                <span className="text-sm font-medium">{isConnected ? 'Connected' : 'Disconnected'}</span>
              </div>
            </div>

            <div className="flex flex-col items-center justify-center mb-8">
              <div 
                className={`w-32 h-32 rounded-full flex items-center justify-center mb-4 transition-all ${
                  isListening 
                    ? 'bg-green-500/20 border-2 border-green-500/50' 
                    : 'bg-white/10 border-2 border-white/20'
                }`}
              >
                <div 
                  className={`w-24 h-24 rounded-full flex items-center justify-center ${
                    isRecording 
                      ? 'bg-red-500/30 border-2 border-red-500/50 pulse-fast' 
                      : isListening 
                        ? 'bg-green-500/30 border-2 border-green-500/50' 
                        : 'bg-white/5 border-2 border-white/10'
                  }`}
                >
                  {isRecording ? (
                    <Activity size={40} className="text-red-300" />
                  ) : isListening ? (
                    <Mic size={40} className="text-green-300" />
                  ) : (
                    <MicOff size={40} className="text-white/70" />
                  )}
                </div>
              </div>

              {isRecording && (
                <div className="w-full bg-white/10 rounded-full h-2 mb-4">
                  <div 
                    className="bg-red-500 h-2 rounded-full transition-all" 
                    style={{ width: `${recordingProgress}%` }}
                  ></div>
                </div>
              )}

              <button
                onClick={toggleListening}
                className={`px-6 py-3 rounded-xl text-lg font-medium transition-all ${
                  isListening
                    ? 'bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30'
                    : 'bg-green-500/20 text-green-300 border border-green-500/30 hover:bg-green-500/30'
                }`}
              >
                {isListening ? 'Stop Listening' : 'Start Listening'}
              </button>
            </div>

            <div className="flex items-center justify-between mb-4 text-white/70 text-sm">
              <div>Detections: <span className="text-purple-300 font-medium">{detectionCount}</span></div>
              <div>
                Last: <span className="text-purple-300 font-medium">
                  {lastDetection ? lastDetection.toLocaleTimeString() : 'None'}
                </span>
              </div>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-xl p-3 mb-6">
              <div className="flex items-center justify-between mb-2">
                <span className="text-white/70 text-sm">Audio Level</span>
                <span className="text-xs text-purple-300">{Math.round(audioLevel * 100)}%</span>
              </div>
              <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-purple-500 h-2 rounded-full transition-all" 
                  style={{ width: `${Math.min(audioLevel * 100, 100)}%` }}
                ></div>
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto bg-white/5 border border-white/10 rounded-xl p-3">
              <h3 className="text-white/70 text-sm mb-2 flex items-center gap-2">
                <FileText size={14} />
                System Logs
              </h3>
              <div className="space-y-1">
                {logs.map((log, index) => (
                  <div key={index} className={`text-xs py-1 px-2 rounded ${
                    log.type === 'error' ? 'bg-red-500/20 text-red-300' :
                    log.type === 'success' ? 'bg-green-500/20 text-green-300' :
                    'bg-white/10 text-white/70'
                  }`}>
                    <span className="text-white/50">{log.timestamp}</span> {log.message}
                  </div>
                ))}
                {logs.length === 0 && (
                  <div className="text-xs py-1 px-2 rounded bg-white/10 text-white/50">
                    No logs yet. Start listening to begin.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* PRESCRIPTION CARD */}
          <div className="bg-black/30 backdrop-blur-xl border border-white/20 rounded-2xl p-6 shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-white text-2xl font-bold">Prescription Items</h2>
              <button
                onClick={clearPrescription}
                disabled={prescriptionItems.length === 0}
                className={`px-3 py-1 rounded-lg text-sm font-medium flex items-center gap-2 ${
                  prescriptionItems.length === 0
                    ? 'bg-white/5 text-white/30 cursor-not-allowed'
                    : 'bg-red-500/20 text-red-300 hover:bg-red-500/30'
                }`}
              >
                <Trash2 size={14} />
                Clear All
              </button>
            </div>

            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {prescriptionItems.length === 0 ? (
                <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center text-white/50">
                  <p className="mb-2">No prescription items yet</p>
                  <p className="text-sm">Say "Clinisio" followed by a prescription to add items</p>
                </div>
              ) : (
                prescriptionList
              )}
            </div>

            <div className="mt-6 flex justify-center">
              <button
                onClick={toggleListening}
                className={`px-4 py-2 rounded-lg text-sm font-medium flex items-center gap-2 ${
                  isListening
                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                    : 'bg-white/10 text-white/70 border border-white/20 hover:bg-white/20'
                }`}
              >
                <Plus size={16} />
                {isListening ? 'Listening...' : 'Add Item'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
