import type { Metadata } from "next";
import { PublicLayout } from "../components/PublicLayout";
import { PageTitle } from "../components/PageTitle";
import { SectionHeading } from "../components/SectionHeading";
import { SectionRule } from "../components/SectionRule";

export const metadata: Metadata = {
  title: "About — The Blackout",
  description:
    "What The Blackout is, why it exists, how it works, and how we use AI.",
};

export default function AboutPage() {
  return (
    <PublicLayout>
      <PageTitle>About The Blackout</PageTitle>

      <SectionHeading>What it is</SectionHeading>
      <p>
        Football has two worlds that rarely meet. One is the experience of a
        match as it happens — emotional, primal, meaningful in a way that
        can&rsquo;t quite be explained to someone who wasn&rsquo;t there. The
        other is great football writing — thoughtful, considered, articulate,
        putting words to something that was previously only understood as
        feeling. Both are real. Both matter. But they almost never arrive in
        the same place at the same time. The live experience is one thing; the
        meaning comes later, if it comes at all.
      </p>
      <p>The Blackout tries to bring them together.</p>
      <p>
        In practice, it is a live literary broadcast platform for football
        matches played during the UK&rsquo;s 3pm Saturday broadcasting blackout.
        Each broadcast is a single match, narrated in real time in a
        distinctive literary voice — match events interpreted through a
        writer&rsquo;s perspective, interwoven with club history,
        rivalry mythology, and player storytelling. The result is delivered as
        a live audiobook with illustrations timed to the drama, experienced
        simultaneously by everyone listening.
      </p>
      <p>
        It is not a score service. It is not a podcast. It is not radio
        commentary. It is a new kind of experience — the game and its meaning,
        arriving together, in real time.
      </p>

      <SectionRule />

      <SectionHeading>Why it exists</SectionHeading>
      <p>
        The 3pm Saturday blackout was never supposed to be a feature. It was a
        protection — the football authorities holding a line for the lower
        leagues, ensuring that live broadcasts didn&rsquo;t pull supporters
        away from the grounds that needed them most. A recognition that
        football is a community, not just a product, and that what happens at
        every level of the game matters.
      </p>
      <p>
        It has survived into an era that has commercialised almost everything
        else the game once held sacred. And in the middle of all that noise,
        it remains: one hour a week where the game still looks like it did
        before it became an industry. Every Saturday at 3pm, thousands of
        matches kick off across the country and disappear — the stories
        unfolding in near silence for everyone who isn&rsquo;t there in person.
      </p>
      <p>
        The Blackout exists because those matches deserve better. One broadcast
        a week, one match, one voice. Something simpler and older than anything
        else in the football media landscape — a story of a game, and some
        pictures to help your imagination bring it to life.
      </p>
      <p>
        There is an obvious tension in using cutting edge technology to produce
        something so deliberately modest. The experience it powers is closer to
        reading yesterday&rsquo;s results in the morning newspaper — when
        televisions were a luxury and the game lived in the imagination — than
        to anything the modern sports media landscape offers. That tension is
        not an accident. The best technology doesn&rsquo;t announce itself — it
        disappears into what it makes possible. And what it makes possible here
        is something the game has nearly forgotten: the feeling that a football
        match is worth paying close attention to, that it has meaning beyond
        the scoreline, that the story of ninety minutes is worth telling
        properly.
      </p>
      <p>
        Some things are timeless not because they resist change but because
        they keep being rediscovered. The Blackout is a rediscovery.
      </p>
      <p>
        The 3pm blackout is the last thing protecting football from itself.
        We&rsquo;re on its side.
      </p>

      <SectionRule />

      <SectionHeading>How it works</SectionHeading>
      <p>
        A listener opens The Blackout on a Saturday afternoon and enters a
        shared room with everyone else following that match. As the game
        unfolds, they hear a distinctive voice — a writer&rsquo;s perspective
        on this match, these clubs, this moment. Goals arrive with
        context. Substitutions carry weight. The passage of time in a goalless
        match is not silence but accumulation.
      </p>
      <p>
        Every broadcast begins with a writer-defined brief — their research,
        their editorial angle, their understanding of what this particular
        match means. A narrative engine reads that brief alongside live match
        data and generates literary prose as events unfold. The technology is
        not producing content and calling it writing. It is taking a
        writer&rsquo;s genuine creative work and making it available live, in
        real time, as the match happens. The voice the listener hears is
        shaped by a real person who cared about this game before it kicked off.
      </p>
      <p>
        Alongside the audio, illustrations appear in sync with the narrative —
        atmospheric images timed to the emotional arc of the broadcast, not
        just the scoreline. The visual style is a writer-guided illustration
        aesthetic consistent across all broadcasts — The Blackout has a
        defined look that belongs to the platform. Within that style, the
        images reflect the writer&rsquo;s brief: the characters, the
        atmosphere, the story they want to tell. No illustrator can draw an
        image in the six seconds between a goal and its narration — so the
        images are generated in real time within that framework. The creative
        intent is human.
      </p>
      <p>
        Everyone in the room hears the same thing at the same time. It is a
        shared experience, not a personalised feed.
      </p>

      <SectionRule />

      <SectionHeading>How we use AI</SectionHeading>
      <p>
        The Blackout uses AI to do things that would otherwise be impossible.
        It does not use AI as a substitute for the things that humans do
        better.
      </p>
      <p>
        Every broadcast is grounded in a writer&rsquo;s work. Their research, their
        editorial angle, their understanding of what this match means — that is
        the foundation of everything that follows. A narrative engine reads
        that brief alongside live match data and generates literary prose as
        events unfold. It is not producing content and calling it writing. It
        is taking a writer&rsquo;s genuine creative work and making it
        available live, in real time, at a cadence no human could sustain
        across ninety minutes of football. The writer shapes what the engine
        says. The engine makes it possible to say it in the moment.
      </p>
      <p>
        The same logic applies to illustrations. A human-defined visual style
        defines how The Blackout looks. An image generation model produces
        illustrations within that style as the match unfolds — because no
        illustrator can produce an image in the seconds between a goal and its
        narration. The speed is the point. The style and the intent behind
        each image come from human decisions.
      </p>
      <p>
        We are not neutral about this. The conversation around AI in creative
        work is often framed as replacement — the technology standing in for
        the human. We think that is the wrong frame, and we have built The
        Blackout to demonstrate a different one. The writers who shape its worlds are
        not providing a prompt and standing back. They are doing real creative
        work that the technology amplifies. If the writer&rsquo;s brief is
        thin, the broadcast is thin. The quality of the human input determines
        the quality of the output.
      </p>
      <p>
        The concept is explicit about where AI is involved. Its purpose is to
        amplify human creative intent, not to disguise or replace it.
      </p>

    </PublicLayout>
  );
}
