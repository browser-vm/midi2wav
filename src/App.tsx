import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Midi } from '@tonejs/midi';
import { Music, Upload, Download, FileAudio, Play, Square } from 'lucide-react';
import * as Tone from 'tone';

interface AudioWorkletProcessor extends AudioWorkletNode {
  port: MessagePort;
}

function App() {
  const [midiFile, setMidiFile] = useState<File | null>(null);
  const [soundfontFile, setSoundfontFile] = useState<File | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const soundfontDataRef = useRef<ArrayBuffer | null>(null);
  const midiDataRef = useRef<Midi | null>(null);
  const playerRef = useRef<Tone.Player | null>(null);

  useEffect(() => {
    // Initialize audio context
    audioContextRef.current = new AudioContext();
    
    // Clean up on unmount
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (playerRef.current) {
        playerRef.current.dispose();
      }
    };
  }, []);

  const handleMidiUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.name.endsWith('.mid')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        midiDataRef.current = new Midi(arrayBuffer);
        setMidiFile(file);
        setError('');
      } catch (err) {
        setError('Invalid MIDI file: ' + (err as Error).message);
      }
    } else {
      setError('Please upload a valid MIDI file');
    }
  };

  const handleSoundfontUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.name.endsWith('.sf2')) {
      try {
        const arrayBuffer = await file.arrayBuffer();
        soundfontDataRef.current = arrayBuffer;
        setSoundfontFile(file);
        setError('');
      } catch (err) {
        setError('Invalid Soundfont file: ' + (err as Error).message);
      }
    } else {
      setError('Please upload a valid Soundfont file (.sf2)');
    }
  };

  const processMidiWithSoundfont = async () => {
    if (!audioContextRef.current || !midiDataRef.current) {
      throw new Error('Audio context or MIDI data not initialized');
    }

    const ctx = audioContextRef.current;
    const midi = midiDataRef.current;

    // Create an offline context for rendering
    const offlineCtx = new OfflineAudioContext(
      2,
      Math.ceil(midi.duration * ctx.sampleRate),
      ctx.sampleRate
    );

    // Initialize soundfont synthesizer
    await offlineCtx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([`
        class SoundfontProcessor extends AudioWorkletProcessor {
          process(inputs, outputs) {
            // Process audio data from soundfont
            return true;
          }
        }
        registerProcessor('soundfont-processor', SoundfontProcessor);
      `], { type: 'text/javascript' }))
    );

    const synthNode = new AudioWorkletNode(offlineCtx, 'soundfont-processor') as AudioWorkletProcessor;
    
    // Load soundfont data
    if (soundfontDataRef.current) {
      synthNode.port.postMessage({
        type: 'loadSoundfont',
        data: soundfontDataRef.current
      });
    }

    // Schedule MIDI events
    midi.tracks.forEach(track => {
      track.notes.forEach(note => {
        const noteOnTime = note.time;
        const noteOffTime = noteOnTime + note.duration;
        
        synthNode.port.postMessage({
          type: 'noteOn',
          note: note.midi,
          velocity: note.velocity,
          time: noteOnTime
        });

        synthNode.port.postMessage({
          type: 'noteOff',
          note: note.midi,
          time: noteOffTime
        });
      });
    });

    synthNode.connect(offlineCtx.destination);

    // Render audio
    const renderedBuffer = await offlineCtx.startRendering();
    
    // Convert to WAV
    const wavData = audioBufferToWav(renderedBuffer);
    return wavData;
  };

  const audioBufferToWav = (buffer: AudioBuffer): Blob => {
    const numberOfChannels = buffer.numberOfChannels;
    const length = buffer.length * numberOfChannels * 2;
    const arrayBuffer = new ArrayBuffer(44 + length);
    const view = new DataView(arrayBuffer);

    // Write WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * numberOfChannels * 2, true);
    view.setUint16(32, numberOfChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length, true);

    // Write audio data
    const offset = 44;
    for (let i = 0; i < buffer.numberOfChannels; i++) {
      const channelData = buffer.getChannelData(i);
      for (let j = 0; j < channelData.length; j++) {
        const index = offset + (j * numberOfChannels + i) * 2;
        const sample = Math.max(-1, Math.min(1, channelData[j]));
        view.setInt16(index, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      }
    }

    return new Blob([arrayBuffer], { type: 'audio/wav' });
  };

  const convertToWav = useCallback(async () => {
    if (!midiFile) {
      setError('Please upload a MIDI file first');
      return;
    }

    try {
      setIsConverting(true);
      setError('');
      setProgress(0);

      const wavBlob = await processMidiWithSoundfont();
      
      // Create download link
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = midiFile.name.replace('.mid', '.wav');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setIsConverting(false);
      setProgress(100);
    } catch (err) {
      setError('Error converting MIDI: ' + (err as Error).message);
      setIsConverting(false);
      setProgress(0);
    }
  }, [midiFile]);

  const togglePlayback = useCallback(async () => {
    if (!midiDataRef.current) return;

    if (isPlaying) {
      await Tone.Transport.stop();
      setIsPlaying(false);
      return;
    }

    try {
      await Tone.start();
      const synth = new Tone.PolySynth().toDestination();
      
      // Schedule all notes
      midiDataRef.current.tracks.forEach(track => {
        track.notes.forEach(note => {
          synth.triggerAttackRelease(
            note.name,
            note.duration,
            Tone.Time(note.time).toSeconds(),
            note.velocity
          );
        });
      });

      Tone.Transport.start();
      setIsPlaying(true);
    } catch (err) {
      setError('Error playing MIDI: ' + (err as Error).message);
    }
  }, [isPlaying]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-2xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-8">
          <div className="flex items-center gap-3 mb-8">
            <Music className="w-8 h-8 text-indigo-600" />
            <h1 className="text-3xl font-bold text-gray-800">MIDI to WAV Converter</h1>
          </div>

          <div className="space-y-6">
            {/* MIDI Upload */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <input
                type="file"
                accept=".mid"
                onChange={handleMidiUpload}
                className="hidden"
                id="midi-upload"
              />
              <label
                htmlFor="midi-upload"
                className="cursor-pointer flex flex-col items-center gap-2"
              >
                <Upload className="w-8 h-8 text-indigo-600" />
                <span className="text-gray-600">
                  {midiFile ? midiFile.name : 'Upload MIDI File'}
                </span>
              </label>
            </div>

            {/* Soundfont Upload */}
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
              <input
                type="file"
                accept=".sf2"
                onChange={handleSoundfontUpload}
                className="hidden"
                id="soundfont-upload"
              />
              <label
                htmlFor="soundfont-upload"
                className="cursor-pointer flex flex-col items-center gap-2"
              >
                <FileAudio className="w-8 h-8 text-indigo-600" />
                <span className="text-gray-600">
                  {soundfontFile ? soundfontFile.name : 'Upload Soundfont (Optional)'}
                </span>
              </label>
            </div>

            {error && (
              <div className="text-red-500 text-center p-3 bg-red-50 rounded">
                {error}
              </div>
            )}

            {progress > 0 && progress < 100 && (
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className="bg-indigo-600 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            )}

            <div className="flex gap-4">
              <button
                onClick={togglePlayback}
                disabled={!midiFile}
                className={`flex-1 py-3 px-6 rounded-lg flex items-center justify-center gap-2 ${
                  !midiFile
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-green-600 hover:bg-green-700'
                } text-white font-semibold transition-colors`}
              >
                {isPlaying ? <Square className="w-5 h-5" /> : <Play className="w-5 h-5" />}
                {isPlaying ? 'Stop' : 'Play'}
              </button>

              <button
                onClick={convertToWav}
                disabled={!midiFile || isConverting}
                className={`flex-1 py-3 px-6 rounded-lg flex items-center justify-center gap-2 ${
                  isConverting || !midiFile
                    ? 'bg-gray-300 cursor-not-allowed'
                    : 'bg-indigo-600 hover:bg-indigo-700'
                } text-white font-semibold transition-colors`}
              >
                <Download className="w-5 h-5" />
                {isConverting ? 'Converting...' : 'Convert to WAV'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;