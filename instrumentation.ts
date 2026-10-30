// Runs once when the server starts (next dev, next start, a Vercel function cold start).
// A broken environment stops the boot here, with every problem named, instead of failing later on the first request.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // `next build` has no secrets on some machines (README: builds do not need them); the check is for running servers.
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NODE_ENV === "test") return;
  const { bootCheck } = await import("./lib/boot-check");
  bootCheck();
}
