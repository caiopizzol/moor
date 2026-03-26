import { type FormEvent, useState } from "react";
import { api } from "../lib/api";
import { Logo } from "./Logo";

type Props = {
  onSuccess: () => void;
};

export function SetupPage({ onSuccess }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      await api.auth.setup(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <Logo size={28} />
        <p className="auth-subtitle">Create a password to get started</p>
        {error && <div className="auth-error">{error}</div>}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min. 8 characters)"
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm password"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={loading || !password || !confirm}
        >
          {loading ? "Setting up..." : "Create password"}
        </button>
      </form>
    </div>
  );
}
