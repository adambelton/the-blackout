export interface RadioSource {
  id: string;
  name: string;
  streamUrl: string;
  urlPattern: string;
  defaultOffsetSeconds: number;
  transcode: boolean;
  lastObservedOffsetSeconds: number | null;
  lastObservedAt: string | null;
  observationCount: number;
}
