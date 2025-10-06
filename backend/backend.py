import asyncio
import json
import struct
import pvporcupine
import pyaudio
import websockets
import speech_recognition as sr
from datetime import datetime

# ===== CONFIGURATION =====
ACCESS_KEY = "BkTK1rxx5m+2xK08m6Iq2DxrLznQG7SHZalMXUn+56YHAL2Di/ZWiA=="
CUSTOM_KEYWORD_PATH = "/Users/biswarupdutta/Library/CloudStorage/OneDrive-MSFT/office_workings_projects/clini_testing_project/clini-app/backend/clini_en_mac_v3_0_0-1.ppn"

# Recording settings
RECORDING_DURATION = 5  # seconds to record after wake word

# ===== GLOBAL STATE =====
porcupine = None
pa = None
stream = None
is_listening = False
is_recording_command = False
connected_clients = set()
recognizer = sr.Recognizer()
audio_buffer = []

# ===== INITIALIZE PORCUPINE =====
def init_porcupine():
    """Initialize Porcupine wake word engine and audio stream"""
    global porcupine, pa, stream
    
    try:
        # Create Porcupine instance
        porcupine = pvporcupine.create(
            access_key=ACCESS_KEY,
            keyword_paths=[CUSTOM_KEYWORD_PATH]
        )
        
        # Initialize PyAudio
        pa = pyaudio.PyAudio()
        
        # Open audio stream
        stream = pa.open(
            rate=porcupine.sample_rate,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            frames_per_buffer=porcupine.frame_length
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
    """Clean up all audio resources"""
    global stream, pa, porcupine
    
    try:
        if stream:
            stream.stop_stream()
            stream.close()
        if pa:
            pa.terminate()
        if porcupine:
            porcupine.delete()
        print("✅ Resources cleaned up")
    except Exception as e:
        print(f"⚠️  Cleanup warning: {e}")

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
        
        # Create AudioData object (sample_width=2 for paInt16)
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

# ===== RECORD COMMAND =====
async def record_command():
    """Record audio for RECORDING_DURATION seconds and transcribe"""
    global is_recording_command, stream, porcupine, audio_buffer
    
    print(f"🎙️  Recording for {RECORDING_DURATION} seconds...")
    
    # Notify frontend recording started
    await broadcast({
        "type": "recording",
        "message": f"Recording command for {RECORDING_DURATION} seconds...",
        "duration": RECORDING_DURATION
    })
    
    # Clear buffer
    audio_buffer = []
    
    # Calculate frames to record
    frames_to_record = int(porcupine.sample_rate * RECORDING_DURATION / porcupine.frame_length)
    
    try:
        # Record frames
        for i in range(frames_to_record):
            if not is_recording_command:
                print("⚠️  Recording cancelled")
                break
            
            # Read audio frame
            pcm_bytes = stream.read(porcupine.frame_length, exception_on_overflow=False)
            audio_buffer.append(pcm_bytes)
            
            # Calculate progress
            progress = int((i + 1) / frames_to_record * 100)
            
            # Send progress every 10 frames
            if i % 10 == 0:
                await broadcast({
                    "type": "recording_progress",
                    "progress": progress
                })
            
            await asyncio.sleep(0.001)
        
        print("✅ Recording complete")
        await broadcast({
            "type": "status",
            "message": "Recording complete. Processing..."
        })
        
        # Transcribe
        if audio_buffer:
            await transcribe_audio(audio_buffer, porcupine.sample_rate)
        
    except Exception as e:
        print(f"❌ Recording error: {e}")
        await broadcast({
            "type": "error",
            "message": f"Recording error: {str(e)}"
        })
    
    finally:
        is_recording_command = False
        audio_buffer = []

# ===== LISTENING LOOP =====
async def listen_for_wake_word():
    """Main loop: detect wake word and trigger recording"""
    global is_listening, is_recording_command, stream, porcupine
    
    print("🎤 Listening for 'Hello Root'...")
    await broadcast({
        "type": "status",
        "message": "Listening for 'Hello Root'..."
    })
    
    try:
        while is_listening:
            # Skip if recording
            if is_recording_command:
                await asyncio.sleep(0.1)
                continue
            
            # Read audio frame
            pcm_bytes = stream.read(porcupine.frame_length, exception_on_overflow=False)
            pcm = struct.unpack_from("h" * porcupine.frame_length, pcm_bytes)
            
            # Check for wake word
            result = porcupine.process(pcm)
            
            # Calculate audio level for visualization
            audio_level = int((sum(abs(x) for x in pcm) / len(pcm)) / 327.67)
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
                await record_command()
            
            await asyncio.sleep(0.01)
    
    except Exception as e:
        print(f"❌ Listening error: {e}")
        await broadcast({
            "type": "error",
            "message": f"Error: {str(e)}"
        })
    
    finally:
        is_listening = False
        print("🛑 Stopped listening")

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
                action = data.get("action")
                
                if action == "start" and not is_listening:
                    print("▶️  Starting listening...")
                    is_listening = True
                    asyncio.create_task(listen_for_wake_word())
                
                elif action == "stop" and is_listening:
                    print("⏸️  Stopping listening...")
                    is_listening = False
                    await broadcast({
                        "type": "status",
                        "message": "Listening stopped"
                    })
                
            except json.JSONDecodeError:
                print(f"⚠️  Invalid JSON from client {client_id}")
            except Exception as e:
                print(f"⚠️  Error processing message: {e}")
    
    except websockets.exceptions.ConnectionClosed:
        print(f"🔌 Client {client_id} disconnected")
    
    finally:
        # Unregister client
        connected_clients.discard(websocket)
        print(f"👋 Client {client_id} removed. Total: {len(connected_clients)}")
        
        # Stop listening if no clients
        if len(connected_clients) == 0:
            is_listening = False
            print("ℹ️  No clients. Listening stopped.")

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
    
    print(f"\n📡 Server: ws://localhost:8765")
    print(f"🎯 Wake Word: 'Clinisio'")
    print(f"⏱️  Recording: {RECORDING_DURATION} seconds after wake word")
    print(f"\n💡 Usage:")
    print(f"   1. Open React app and click 'Connect'")
    print(f"   2. Click 'Start Listening'")
    print(f"   3. Say: 'Clinisio' + your command")
    print(f"   4. Example: 'Clinisio, add paracetamol 650 mg'")
    print(f"\nPress Ctrl+C to stop")
    print("=" * 70 + "\n")
    
    # Start server
    try:
        async with websockets.serve(handler, "0.0.0.0", int(os.environ.get("PORT", 8765))):
            await asyncio.Future()
    except Exception as e:
        print(f"\n❌ Server error: {e}")

# ===== ENTRY POINT =====
if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n" + "=" * 70)
        print("⚠️  Server stopped by user (Ctrl+C)")
        print("=" * 70)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
    finally:
        cleanup()
        print("👋 Goodbye!\n")
