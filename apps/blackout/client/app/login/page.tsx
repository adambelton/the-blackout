import { DevLoginForm } from "./components/DevLoginForm";

export default function LoginPage() {
  return (
    <main
      style={{
        padding: "4rem 2rem",
        fontFamily: "system-ui",
        maxWidth: 400,
        margin: "0 auto",
        textAlign: "center",
        color: "#222",
      }}
    >
      <h1>Sign in to The Blackout</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Sign in to access the moderator console and studio.
      </p>
      <DevLoginForm />
    </main>
  );
}
