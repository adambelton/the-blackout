import "../env.js";
import { db, sql } from "./client.js";
import { radioSources } from "./schema.js";

const SEED_RADIO_SOURCES = [
  {
    name: "TalkSPORT",
    streamUrl: "https://radio.talksport.com/stream",
    urlPattern: "radio.talksport.com/stream",
    defaultOffsetSeconds: 30,
    transcode: false,
  },
  {
    name: "TalkSPORT 2",
    streamUrl: "https://radio.talksport.com/stream2",
    urlPattern: "radio.talksport.com/stream2",
    defaultOffsetSeconds: 30,
    transcode: false,
  },
  {
    name: "BBC Radio 5 Live (public)",
    streamUrl:
      "http://as-hls-ww-live.akamaized.net/pool_89021708/live/ww/bbc_radio_five_live/bbc_radio_five_live.isml/bbc_radio_five_live-audio%3d128000.norewind.m3u8",
    urlPattern: "bbc_radio_five_live",
    defaultOffsetSeconds: 45,
    transcode: false,
  },
  {
    // Syndication feed ships MPEG-TS segments with HE-AAC, which Deepgram
    // can't auto-decode — so transcode=true pipes it through ffmpeg into
    // linear16 before sending. Plays during 3pm blackouts where the
    // public feed goes silent.
    name: "BBC Radio 5 Live (syndication)",
    streamUrl:
      "http://a.files.bbci.co.uk/ms6/live/3441A116-B12E-4D2F-ACA8-C1984642FA4B/audio/simulcast/hls/uk/audio_syndication_high_sbr_v1/ak/bbc_radio_five_live.m3u8",
    urlPattern: "audio_syndication_high_sbr",
    defaultOffsetSeconds: 45,
    transcode: true,
  },
];

async function seed() {
  for (const source of SEED_RADIO_SOURCES) {
    await db
      .insert(radioSources)
      .values(source)
      .onConflictDoNothing({ target: radioSources.streamUrl });
    console.log(`[seed] radio_source: ${source.name}`);
  }
}

seed()
  .then(() => {
    console.log("[seed] done");
    return sql.end();
  })
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("[seed] failed:", err);
    await sql.end();
    process.exit(1);
  });
