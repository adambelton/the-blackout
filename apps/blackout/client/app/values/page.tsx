import type { Metadata } from "next";
import { PublicLayout } from "../components/PublicLayout";
import { PageTitle } from "../components/PageTitle";
import { SectionHeading } from "../components/SectionHeading";
import { SectionRule } from "../components/SectionRule";

export const metadata: Metadata = {
  title: "What we stand for — The Blackout",
  description: "The creative principles behind The Blackout concept.",
};

export default function ValuesPage() {
  return (
    <PublicLayout>
      <PageTitle>Values</PageTitle>

      <SectionHeading>Writers lead</SectionHeading>
      <p>
        The premise, voice, characters, themes, and dramatic boundaries begin
        with a writer. The system exists to carry that creative intent through
        an unpredictable match, not to invent an interchangeable story around
        it.
      </p>
      <p>
        Authorship should remain visible. A generated line may respond to live
        events, but the world it belongs to and the choices that shape it are
        human work.
      </p>

      <SectionRule />

      <SectionHeading>AI supports creative effort</SectionHeading>
      <p>
        Generative AI is useful here because a live match cannot be scripted
        in advance. It can interpret events within a writer-defined framework
        and produce timely variations while the game unfolds.
      </p>
      <p>
        That capability is not a substitute for taste, judgment, or intent.
        The interesting question is how software can extend a writer&rsquo;s
        reach without obscuring or replacing their contribution.
      </p>

      <SectionRule />

      <SectionHeading>Football stays true</SectionHeading>
      <p>
        The fiction can reinterpret the feeling of a match, but it should not
        rewrite what happened. Scores, incidents, timing, and momentum remain
        anchored to the underlying game.
      </p>

      <SectionRule />

      <SectionHeading>A shared experience</SectionHeading>
      <p>
        Everyone following a broadcast encounters the same evolving
        narrative. That shared timeline matters: it makes the story something
        experienced together, like the match that drives it.
      </p>

      <SectionRule />

      <SectionHeading>An open concept</SectionHeading>
      <p>
        The Blackout is a paused, open-source prototype. It is not an active
        service. The repository preserves the concept, the design decisions
        behind it, and one approach to building the system.
      </p>
    </PublicLayout>
  );
}
