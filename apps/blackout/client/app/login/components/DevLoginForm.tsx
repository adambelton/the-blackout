"use client";

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

export function DevLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: signInError } = await signIn.email({
      email,
      password,
      callbackURL: "/",
    });
    if (signInError) {
      setError(signInError.message ?? "Sign in failed.");
      setPending(false);
    }
    // Successful sign-in triggers a redirect via callbackURL; no
    // further state to manage here.
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        marginTop: "2.5rem",
        paddingTop: "1.5rem",
        borderTop: "1px solid #eee",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        textAlign: "left",
      }}
    >
      <p style={{ color: "#666", fontSize: "0.85rem", margin: 0 }}>
        Sign in with your email and password.
      </p>
      <input
        type="email"
        placeholder="Email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ padding: "0.5rem", fontSize: "1rem" }}
      />
      <input
        type="password"
        placeholder="Password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        style={{ padding: "0.5rem", fontSize: "1rem" }}
      />
      {error ? (
        <p style={{ color: "#a00", fontSize: "0.85rem", margin: 0 }}>{error}</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        style={{
          padding: "0.6rem 1.5rem",
          fontSize: "0.95rem",
          backgroundColor: "#444",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          cursor: pending ? "default" : "pointer",
          opacity: pending ? 0.7 : 1,
        }}
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
