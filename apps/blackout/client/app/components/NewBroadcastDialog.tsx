"use client";

import { useEffect, useState } from "react";
import type { RadioSource, UpcomingFixture } from "@blackout/shared";
import { Dialog } from "./Dialog";
import { DialogBody } from "./DialogBody";
import { DialogFooter } from "./DialogFooter";
import { Field } from "./Field";
import { FieldError } from "./FieldError";
import { PillButton } from "./PillButton";
import { SelectInput } from "./SelectInput";
import { brand as C } from "../lib/palette";
import { formatMatchDateParts } from "../lib/format";
import { apiGet, apiPost } from "@/lib/api";
import { routes } from "@/lib/routes";

interface NewBroadcastDialogProps {
  open: boolean;
  onClose: () => void;
  /** Fired after a broadcast is successfully created; receives the new broadcast id. */
  onCreated: (broadcastId: string) => void;
}

/**
 * Two-step flow: pick a fixture from the Sportmonks upcoming list, then
 * pick an optional radio source and submit. Kept in one dialog because
 * the radio-source choice depends on having already chosen a match.
 *
 * Reloads fixtures + sources on each open — the set can change between
 * openings (Sportmonks pushes new fixtures every few hours, admins may
 * have added a radio source in between).
 */
export function NewBroadcastDialog({ open, onClose, onCreated }: NewBroadcastDialogProps) {
  const [fixtures, setFixtures] = useState<UpcomingFixture[]>([]);
  const [radioSources, setRadioSources] = useState<RadioSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFixture, setSelectedFixture] = useState<UpcomingFixture | null>(null);
  const [radioSourceId, setRadioSourceId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setSelectedFixture(null);
    setRadioSourceId("");
    const controller = new AbortController();
    Promise.all([
      apiGet<UpcomingFixture[]>(routes.fixtures.upcoming(), { signal: controller.signal })
        .catch(() => [] as UpcomingFixture[]),
      apiGet<RadioSource[]>(routes.radioSources.list(), { signal: controller.signal })
        .catch(() => [] as RadioSource[]),
    ])
      .then(([f, r]) => {
        setFixtures(Array.isArray(f) ? f : []);
        setRadioSources(Array.isArray(r) ? r : []);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError((err as Error).message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open]);

  const submit = async () => {
    if (!selectedFixture) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = await apiPost<
        Record<string, unknown>,
        { id?: string; broadcast?: { id?: string } }
      >(routes.broadcasts.list(), {
        homeTeam: selectedFixture.homeTeam,
        awayTeam: selectedFixture.awayTeam,
        competition: selectedFixture.leagueName ?? "Unknown",
        matchDate: new Date(selectedFixture.startingAt).toISOString(),
        fixtureId: selectedFixture.id,
        radioSourceId: radioSourceId || undefined,
      });
      const id = body?.id ?? body?.broadcast?.id;
      if (typeof id !== "string") throw new Error("Unexpected server response");
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const closeIfIdle = () => {
    if (submitting) return;
    onClose();
  };

  const title = selectedFixture ? "Confirm broadcast details" : "New broadcast";
  const subtitle = selectedFixture
    ? `${selectedFixture.homeTeam} vs ${selectedFixture.awayTeam}`
    : "Pick an upcoming fixture to broadcast.";

  return (
    <Dialog open={open} onClose={closeIfIdle} title={title} subtitle={subtitle} width={560}>
      {loading ? (
        <DialogBody>
          <p style={{ color: C.stone, fontSize: 13, margin: 0 }}>Loading fixtures…</p>
        </DialogBody>
      ) : selectedFixture ? (
        <>
          <DialogBody>
            <FieldError>{error}</FieldError>
            <div
              style={{
                padding: "14px 16px",
                border: `0.5px solid ${C.celadon}`,
                borderRadius: 10,
                background: `${C.celadon}2E`,
                marginBottom: 16,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 300, letterSpacing: "-0.02em", color: C.umber }}>
                {selectedFixture.homeTeam} vs {selectedFixture.awayTeam}
              </div>
              <div style={{ fontSize: 12, color: C.driftwood, marginTop: 2 }}>
                {selectedFixture.leagueName} · {formatDate(selectedFixture.startingAt)}{" "}
                {formatTime(selectedFixture.startingAt)}
              </div>
              <button
                type="button"
                onClick={() => setSelectedFixture(null)}
                style={{
                  marginTop: 10,
                  background: "none",
                  border: "none",
                  color: C.stone,
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  textDecoration: "underline",
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  fontWeight: 500,
                }}
              >
                Change fixture
              </button>
            </div>

            <Field
              label="Radio source"
              hint={
                radioSources.length === 0
                  ? "No sources catalogued yet — broadcast can be created without one and a source added later."
                  : "Optional. Can be added later from the moderator console."
              }
            >
              <SelectInput
                value={radioSourceId}
                onChange={(e) => setRadioSourceId(e.target.value)}
              >
                <option value="">— None (add later) —</option>
                {radioSources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — offset {s.defaultOffsetSeconds}s
                  </option>
                ))}
              </SelectInput>
            </Field>
          </DialogBody>
          <DialogFooter>
            <PillButton variant="ghost" onClick={closeIfIdle} disabled={submitting}>
              Cancel
            </PillButton>
            <PillButton variant="primary" onClick={submit} disabled={submitting}>
              {submitting ? "Creating…" : "Create broadcast"}
            </PillButton>
          </DialogFooter>
        </>
      ) : (
        <DialogBody>
          <FieldError>{error}</FieldError>
          {fixtures.length === 0 ? (
            <p style={{ color: C.stone, fontSize: 13, margin: 0 }}>
              No upcoming fixtures found. Sportmonks may be between weeks — try again later.
            </p>
          ) : (
            <FixtureList fixtures={fixtures} onPick={setSelectedFixture} />
          )}
        </DialogBody>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Fixture picker
// ---------------------------------------------------------------------------

function FixtureList({
  fixtures,
  onPick,
}: {
  fixtures: UpcomingFixture[];
  onPick: (f: UpcomingFixture) => void;
}) {
  const byDate = fixtures.reduce<Record<string, UpcomingFixture[]>>((acc, f) => {
    const date = formatDate(f.startingAt);
    (acc[date] ??= []).push(f);
    return acc;
  }, {});

  return (
    <div>
      {Object.entries(byDate).map(([date, group]) => (
        <div key={date} style={{ marginBottom: 20 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: C.stone,
              marginBottom: 8,
            }}
          >
            {date}
          </div>
          {group.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onPick(f)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 14px",
                border: `0.5px solid ${C.celadon}`,
                borderRadius: 8,
                marginBottom: 6,
                background: "transparent",
                color: C.umber,
                cursor: "pointer",
                textAlign: "left",
                width: "100%",
                fontFamily: "inherit",
                transition: "border-color 160ms ease",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: C.driftwood,
                  fontVariantNumeric: "tabular-nums",
                  width: 44,
                  flexShrink: 0,
                }}
              >
                {formatTime(f.startingAt)}
              </span>
              <span
                style={{
                  flex: 1,
                  fontSize: 13,
                  fontWeight: 400,
                  color: C.umber,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {f.homeTeam} vs {f.awayTeam}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: C.stone,
                  letterSpacing: "0.02em",
                }}
              >
                {f.leagueName}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return formatMatchDateParts(iso).date;
}

function formatTime(iso: string): string {
  return formatMatchDateParts(iso).time;
}
