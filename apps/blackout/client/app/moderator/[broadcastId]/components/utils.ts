import { brand as C } from "../../../lib/palette";

export function pillStyles(
  variant: "primary" | "ghost" | "destructive" | "ghostDisabled",
): React.CSSProperties {
  const base: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: 12,
    padding: "7px 16px",
    borderRadius: 100,
    cursor: variant === "ghostDisabled" ? "not-allowed" : "pointer",
    transition: "all 160ms ease",
  };
  if (variant === "primary") {
    return {
      ...base,
      background: C.umber,
      color: C.ivory,
      border: "none",
      fontWeight: 500,
    };
  }
  if (variant === "destructive") {
    return {
      ...base,
      background: "transparent",
      color: C.crimson,
      border: `0.5px solid ${C.crimson}40`,
    };
  }
  return {
    ...base,
    background: "transparent",
    color: variant === "ghostDisabled" ? C.stone : C.umber,
    border: `0.5px solid ${C.celadon}`,
    opacity: variant === "ghostDisabled" ? 0.5 : 1,
  };
}
