"use client";

import { brand as C } from "../../lib/palette";

export function EmptyState({
  isAdmin,
  onCreate,
}: {
  isAdmin: boolean;
  onCreate: () => void;
}) {
  return (
    <div
      style={{
        padding: "48px 18px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        textAlign: "center",
        color: C.stone,
        fontSize: 13,
        marginTop: 32,
      }}
    >
      No broadcasts yet.
      {isAdmin ? (
        <>
          {" "}
          <button
            type="button"
            onClick={onCreate}
            style={{
              background: "none",
              border: "none",
              color: C.umber,
              textDecoration: "underline",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
              padding: 0,
            }}
          >
            Create one
          </button>
          .
        </>
      ) : null}
    </div>
  );
}
