import asyncio
import json
import base64
import pvporcupine
import websockets
import speech_recognition as sr
from datetime import datetime
import numpy as np
import os

# ===== CONFIGURATION FROM ENVIRONMENT =====
ACCESS_KEY = os.getenv("PORCUPINE_ACCESS_KEY", "BkTK1rxx5m+2xK08m6Iq2DxrLznQG7SHZalMXUn+56YHAL2Di/ZWiA==")
CUSTOM_KEYWORD_PATH = os.getenv("KEYWORD_PATH", "./clini_en_mac_v3_0_0-1.ppn")
PORT = int(os.getenv("PORT", 8765))

# Recording settings
RECORDING_DURATION = 5  # seconds to record after wake word

# ===== GLOBAL STATE =====
porcupine = None
is_listening = False
is_recording_command = False
connected_clients = set()
recognizer = sr.Recognizer()
audio_buffer = []
wake_word_buffer = []  # Buffer for wake word detection

# ===== INITIALIZE PORCUPINE =====
def init_porcupine():
    """Initialize Porcupine wake word engine"""
    global porcupine
    
    try:
        # Create Porcupine instance
        porcupine = pvporcupine.create(
            access_key=ACCESS_KEY,
            keyword_paths=[CUSTOM_KEYWORD_PATH]
        )
        
        print("✅ Porcupine initialized successfully")
        print(f"   Sample Rate: {porcupine.sample_rate} Hz")
        print(f"   Frame Length: {porcupine.frame_length}")
        return True
        
    except Exception as e:
        print(f"❌ Failed to initialize Porcupine: {e}")
        print("   Please check your ACCESS_KEY and CUSTOM_KEYWORD_PATH")
        return False

# ===== CLEANUP =====
def cleanup():
    """Clean up all resources"""
    global porcupine
    
    try:
        if porcupine:
            porcupine.delete()
        print("✅ Resources cleaned up")
    except Exception as e:
        print(f"⚠️ Cleanup warning: {e}")

# ===== BROADCAST =====
async def broadcast(message):
    """Send message to all connected WebSocket clients"""
    if not connected_clients:
        return
    
    # Send to all clients, remove disconnected ones
    disconnected = set()
    for client in connected_clients:
        try:
            await client.send(json.dumps(message))
        except:
            disconnected.add(client)
    
    connected_clients.difference_update(disconnected)

# ===== PROCESS AUDIO CHUNK =====
async def process_audio_chunk(audio_data, sample_rate):
    """
    Process incoming audio chunk for wake word detection or recording
    
    Args:
        audio_data: Base64 encoded PCM audio data
        sample_rate: Sample rate from frontend
    """
    global is_recording_command, audio_buffer, wake_word_buffer, porcupine
    
    try:
        # Decode base64 audio
        pcm_bytes = base64.b64decode(audio_data)
        
        # Convert to int16 array
        pcm_array = np.frombuffer(pcm_bytes, dtype=np.int16)
        
        # Resample if needed (frontend sends 16000 Hz, Porcupine expects its sample rate)
        if sample_rate != porcupine.sample_rate:
            # Simple resampling (for production, use proper resampling library)
            ratio = porcupine.sample_rate / sample_rate
            new_length = int(len(pcm_array) * ratio)
            pcm_array = np.interp(
                np.linspace(0, len(pcm_array), new_length),
                np.arange(len(pcm_array)),
                pcm_array
            ).astype(np.int16)
        
        # If recording command, add to buffer
        if is_recording_command:
            audio_buffer.append(pcm_bytes)
            return
        
        # Otherwise, check for wake word
        # Add to wake word buffer
        wake_word_buffer.extend(pcm_array.tolist())
        
        # Process in frame_length chunks
        while len(wake_word_buffer) >= porcupine.frame_length:
            # Extract one frame
            frame = wake_word_buffer[:porcupine.frame_length]
            wake_word_buffer = wake_word_buffer[porcupine.frame_length:]
            
            # Check for wake word
            result = porcupine.process(frame)
            
            # Calculate audio level for visualization
            audio_level = int((sum(abs(x) for x in frame) / len(frame)) / 327.67)
            audio_level = min(audio_level, 100)
            
            # Send audio level
            await broadcast({
                "type": "audio_level",
                "level": audio_level
            })
            
            # Wake word detected!
            if result >= 0:
                print(f"✅ Wake word detected at {datetime.now().strftime('%H:%M:%S')}")
                
                await broadcast({
                    "type": "detection",
                    "timestamp": datetime.now().isoformat()
                })
                
                # Start recording
                is_recording_command = True
                audio_buffer = []
                wake_word_buffer = []  # Clear buffer
                
                await broadcast({
                    "type": "recording",
                    "message": f"Recording command for {RECORDING_DURATION} seconds...",
                    "duration": RECORDING_DURATION
                })
                
                # Schedule transcription after RECORDING_DURATION
                asyncio.create_task(schedule_transcription())
                
                break
    
    except Exception as e:
        print(f"❌ Error processing audio chunk: {e}")

# ===== SCHEDULE TRANSCRIPTION =====
async def schedule_transcription():
    """Wait for recording duration, then transcribe"""
    global is_recording_command, audio_buffer, porcupine
    
    try:
        # Calculate expected chunks
        chunks_needed = int((RECORDING_DURATION * porcupine.sample_rate) / (porcupine.frame_length))
        
        # Wait for recording to complete
        start_time = asyncio.get_event_loop().time()
        while is_recording_command:
            elapsed = asyncio.get_event_loop().time() - start_time
            
            if elapsed >= RECORDING_DURATION:
                break
            
            # Send progress
            progress = min(int((elapsed / RECORDING_DURATION) * 100), 100)
            await broadcast({
                "type": "recording_progress",
                "progress": progress
            })
            
            await asyncio.sleep(0.1)
        
        print("✅ Recording complete")
        await broadcast({
            "type": "status",
            "message": "Recording complete. Processing..."
        })
        
        # Transcribe
        if audio_buffer:
            await transcribe_audio(audio_buffer, porcupine.sample_rate)
        
    except Exception as e:
        print(f"❌ Transcription scheduling error: {e}")
    finally:
        is_recording_command = False
        audio_buffer = []

# ===== TRANSCRIBE AUDIO =====
async def transcribe_audio(audio_data, sample_rate):
    """
    Transcribe audio using Google Speech Recognition
    
    Args:
        audio_data: List of audio frame bytes
        sample_rate: Sample rate in Hz
    """
    try:
        print("🎯 Transcribing audio...")
        await broadcast({
            "type": "status",
            "message": "Transcribing command..."
        })
        
        # Combine audio frames
        audio_bytes = b''.join(audio_data)
        
        # Create AudioData object (sample_width=2 for int16)
        audio = sr.AudioData(audio_bytes, sample_rate, 2)
        
        # Run speech recognition in executor (non-blocking)
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None,
            recognizer.recognize_google,
            audio
        )
        
        print(f"✅ Transcription: '{text}'")
        
        # Send transcription to frontend
        await broadcast({
            "type": "transcription",
            "text": text,
            "timestamp": datetime.now().isoformat()
        })
        
        return text
        
    except sr.UnknownValueError:
        print("❌ Could not understand audio")
        await broadcast({
            "type": "error",
            "message": "Could not understand audio. Please speak clearly."
        })
        return None
        
    except sr.RequestError as e:
        print(f"❌ Speech recognition service error: {e}")
        await broadcast({
            "type": "error",
            "message": "Speech recognition service error. Check internet connection."
        })
        return None
        
    except Exception as e:
        print(f"❌ Transcription error: {e}")
        await broadcast({
            "type": "error",
            "message": f"Transcription error: {str(e)}"
        })
        return None

# ===== WEBSOCKET HANDLER =====
async def handle_client(websocket):
    """Handle WebSocket client connections"""
    global is_listening
    
    # Register client
    connected_clients.add(websocket)
    client_id = id(websocket)
    print(f"✅ Client {client_id} connected. Total: {len(connected_clients)}")
    
    try:
        # Send welcome message
        await websocket.send(json.dumps({
            "type": "status",
            "message": "Connected to wake word detector"
        }))
        
        # Handle messages
        async for message in websocket:
            try:
                data = json.loads(message)
                msg_type = data.get("type")
                
                if msg_type == "start" and not is_listening:
                    print("▶️ Starting listening...")
                    is_listening = True
                    await broadcast({
                        "type": "status",
                        "message": "Listening for 'Clinisio'..."
                    })
                
                elif msg_type == "stop" and is_listening:
                    print("⏸️ Stopping listening...")
                    is_listening = False
                    await broadcast({
                        "type": "status",
                        "message": "Listening stopped"
                    })
                
                elif msg_type == "audio" and is_listening:
                    # Process audio chunk
                    audio_data = data.get("data")
                    sample_rate = data.get("sampleRate", 16000)
                    
                    if audio_data:
                        await process_audio_chunk(audio_data, sample_rate)
                
            except json.JSONDecodeError:
                print(f"⚠️ Invalid JSON from client {client_id}")
            except Exception as e:
                print(f"⚠️ Error processing message: {e}")
    
    except websockets.exceptions.ConnectionClosed:
        print(f"🔌 Client {client_id} disconnected")
    
    finally:
        # Unregister client
        connected_clients.discard(websocket)
        print(f"👋 Client {client_id} removed. Total: {len(connected_clients)}")
        
        # Stop listening if no clients
        if len(connected_clients) == 0:
            is_listening = False
            print("ℹ️ No clients. Listening stopped.")

# ===== MAIN =====
async def main():
    """Start WebSocket server"""
    print("=" * 70)
    print("🚀 PRESCRIPTION VOICE ASSISTANT - WebSocket Server")
    print("=" * 70)
    
    # Initialize
    if not init_porcupine():
        print("❌ Initialization failed. Exiting...")
        return
    
    print(f"\n📡 Server: ws://0.0.0.0:{PORT}")
    print(f"🎯 Wake Word: 'Clinisio'")
    print(f"⏱️ Recording: {RECORDING_DURATION} seconds after wake word")
    print(f"\n💡 Environment:")
    print(f"   ACCESS_KEY: {'Set' if ACCESS_KEY else 'Not set'}")
    print(f"   KEYWORD_PATH: {CUSTOM_KEYWORD_PATH}")
    print(f"   PORT: {PORT}")
    print(f"\nPress Ctrl+C to stop")
    print("=" * 70 + "\n")
    
    # Start server - Bind to 0.0.0.0 for Render
    try:
        async with websockets.serve(handle_client, "0.0.0.0", PORT):
            await asyncio.Future()
    except Exception as e:
        print(f"\n❌ Server error: {e}")

# ===== ENTRY POINT =====
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n" + "=" * 70)
        print("⚠️ Server stopped by user (Ctrl+C)")
        print("=" * 70)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
    finally:
        cleanup()
        print("👋 Goodbye!\n")