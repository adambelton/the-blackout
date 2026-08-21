import { LandingBroadcastCard } from "./components/LandingBroadcastCard";
import { PublicLayout } from "./components/PublicLayout";
import { brand as C } from "./lib/palette";

export default function Home() {
  return (
    <PublicLayout wordmark="display" wordmarkAs="div">
      <p
        style={{
          fontSize: "1.0625rem",
          color: C.driftwood,
          margin: "0 0 2rem",
          lineHeight: 1.6,
          maxWidth: 540,
        }}
      >
        A live literary broadcast platform for the 3pm football blackout.
        Real football writers shape the story. AI orchestrates the telling.
      </p>

      <section style={{ marginBottom: "2rem" }}>
        <p>
          Football has two worlds that rarely meet. One is the experience of a
          match as it happens — emotional, primal, meaningful in a way that
          can&rsquo;t quite be explained to someone who wasn&rsquo;t there. The
          other is great football writing — thoughtful, considered, articulate,
          putting words to something that was previously only understood as
          feeling.
        </p>
        <p>The Blackout tries to bring them together.</p>
        <p>
          Each broadcast is a single match, narrated in real time in a
          distinctive literary voice — match events interpreted through a
          writer&rsquo;s perspective, interwoven with club history,
          rivalry mythology, and player storytelling. Delivered as a live
          audiobook with illustrations timed to the drama, experienced
          simultaneously by everyone listening.
        </p>
        <p>
          It is not a score service. It is not a podcast. It is not radio
          commentary. It is a new kind of experience — the game and its meaning,
          arriving together, in real time.
        </p>
      </section>

      <LandingBroadcastCard />
    </PublicLayout>
  );
}
