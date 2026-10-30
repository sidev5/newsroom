import { handleStageRequest } from "@/lib/pipeline/cron-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleStageRequest("ingest", request);
}
