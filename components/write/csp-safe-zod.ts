import { z } from "zod";

// The Write form checks a story in the browser with the same schema as the server (lib/stories/blocks.ts). By default zod
// speeds up validation by compiling it with `new Function(...)`, which a Content-Security-Policy without 'unsafe-eval' forbids
// (it is reported, or blocked in enforce mode). "jitless" makes zod validate with plain code instead: the same results, no eval.
// This file is imported first by WriteForm, before any schema is used; it is not imported on the server, which keeps the speed-up.
z.config({ jitless: true });