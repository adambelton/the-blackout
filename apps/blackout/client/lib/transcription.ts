/**
 * Web Speech API wrapper for live commentary transcription.
 * Runs in the moderator's browser only.
 */

export interface TranscriptChunk {
  text: string;
  isFinal: boolean;
  timestamp: number;
}

type OnChunk = (chunk: TranscriptChunk) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpeechRecognitionConstructor = new () => any;

export function createTranscriber(onChunk: OnChunk): {
  start: () => void;
  stop: () => void;
} {
  const SpeechRecognition: SpeechRecognitionConstructor | undefined =
    (window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor })
      .SpeechRecognition ||
    (
      window as unknown as {
        webkitSpeechRecognition?: SpeechRecognitionConstructor;
      }
    ).webkitSpeechRecognition;

  if (!SpeechRecognition) {
    throw new Error("Web Speech API is not supported in this browser");
  }

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-GB";

  recognition.onresult = (event: { resultIndex: number; results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } } }) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        onChunk({
          text: result[0].transcript.trim(),
          isFinal: true,
          timestamp: Date.now(),
        });
      }
    }
  };

  recognition.onerror = (event: Event & { error?: string }) => {
    console.error("[transcription] error:", event.error);
    // Auto-restart on non-fatal errors
    if (event.error !== "not-allowed" && event.error !== "aborted") {
      setTimeout(() => recognition.start(), 500);
    }
  };

  recognition.onend = () => {
    // Web Speech API can stop on its own — restart to keep continuous
    try {
      recognition.start();
    } catch {
      // Already started, ignore
    }
  };

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop(),
  };
}
