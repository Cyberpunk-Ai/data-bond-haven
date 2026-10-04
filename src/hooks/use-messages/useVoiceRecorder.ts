import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Microphone recording for voice notes. Owns the MediaRecorder, the ticking
 * duration, and the cleanup that the old page-local version left to chance
 * (tracks kept alive when a recording was cancelled mid-take).
 *
 * The finished audio is handed to `onRecorded` as a WebM File plus its length;
 * the caller uploads and sends it, so this hook stays out of the network path.
 */
export function useVoiceRecorder(onRecorded: (file: File, durationSeconds: number) => void) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseTracks = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
  }, []);

  const start = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start();
      startedAtRef.current = Date.now();
      setIsRecording(true);
      setDuration(0);
      stopTimer();
      timerRef.current = setInterval(() => {
        setDuration(Math.round((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
    } catch {
      toast.error("Microphone access denied or error starting recording");
    }
  }, [stopTimer]);

  const cancel = useCallback(() => {
    stopTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      // Stop without an onstop handler firing a send — data is discarded.
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        // Already stopped; tracks below still need releasing.
      }
    }
    releaseTracks();
    recorderRef.current = null;
    chunksRef.current = [];
    setIsRecording(false);
    setDuration(0);
  }, [releaseTracks, stopTimer]);

  const send = useCallback(() => {
    stopTimer();
    setIsRecording(false);
    const taken = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    setDuration(0);
    const recorder = recorderRef.current;
    if (!recorder) {
      toast.error("No active recording found");
      return;
    }
    recorder.onstop = () => {
      releaseTracks();
      const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
      const file = new File([audioBlob], `voice_note_${Date.now()}.webm`, {
        type: "audio/webm",
      });
      recorderRef.current = null;
      onRecorded(file, taken);
    };
    try {
      recorder.stop();
    } catch {
      toast.error("Failed to finish voice note");
    }
  }, [onRecorded, releaseTracks, stopTimer]);

  // Never leave the mic hot if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      stopTimer();
      releaseTracks();
    };
  }, [releaseTracks, stopTimer]);

  return { isRecording, duration, start, cancel, send };
}
